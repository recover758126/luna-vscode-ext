import * as vscode from "vscode";
import {
  createExtensionMcpServer,
  type ServerConfig,
} from "./mcp/server";
import { installDebuggerTools, installJupyterTools } from "./mcp/tools";
import { resolveClaudeBinary, spawnClaudeBinary } from "./binary";
import {
  McpHostBridge,
  type ControlRequestMsg,
  type ControlResponseMsg,
  type ToolPermissionDecision,
} from "./mcp/bridge";
import { InMemoryTransport } from "./mcp/transport";
import { startIdeMcpServer, type IdeMcpServer } from "./mcp/ideServer";
import { installLatestSelectionTracker, type IdeToolLogger } from "./mcp/ideTools";

function cfg<T>(key: string, fallback: T): T {
  const v = vscode.workspace.getConfiguration("lunaCode").get<T>(key);
  return (v === undefined ? fallback : v) as T;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Luna Code");
  context.subscriptions.push(output);

  // Logger passed to the IDE MCP server's tool handlers.
  const ideLogger: IdeToolLogger = {
    info:  (m) => output.appendLine(`[ide-mcp] ${m}`),
    warn:  (m) => output.appendLine(`[ide-mcp] WARN ${m}`),
    error: (m) => output.appendLine(`[ide-mcp] ERR  ${m}`),
    appendLine: (m) => output.appendLine(`[jupyter] ${m}`),
  };

  // Stdio `claude-vscode-extension` server (zero tools by default — faithful).
  const extensionMcp = createExtensionMcpServer();
  installDebuggerTools(extensionMcp);
  installJupyterTools(extensionMcp);

  // HTTP/WS `Claude Code {Editor} MCP` server carrying the 12 IDE tools.
  let ideMcp: IdeMcpServer | undefined;
  if (cfg<boolean>("enableIdeMcp", true)) {
    try {
      ideMcp = await startIdeMcpServer({
        version: context.extension.packageJSON.version || "0.0.1",
        logger: ideLogger,
      });
      output.appendLine(
        `IDE MCP server listening on 127.0.0.1:${ideMcp.port} (lock file written under ~/.claude/ide/)`
      );
      context.subscriptions.push({
        dispose: async () => {
          try { await ideMcp?.dispose(); } catch {}
        },
      });
    } catch (e) {
      output.appendLine(`[ide-mcp] failed to start: ${(e as Error).message}`);
    }
  }
  // Subscribe to selection changes so `getLatestSelection` reflects non-active editors.
  context.subscriptions.push(installLatestSelectionTracker());

  let bridge: McpHostBridge | undefined;
  let child: import("child_process").ChildProcessWithoutNullStreams | undefined;

  const start = vscode.commands.registerCommand(
    "luna-vscode.start",
    async () => {
      if (child && !child.killed) {
        output.appendLine("Session already running.");
        return;
      }
      const cwd =
        cfg<string>("workspaceCwd", "") ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        process.cwd();
      const { pathToClaudeCodeExecutable, env } = resolveClaudeBinary(
        cfg<string>("claudeBinaryPath", "")
      );
      output.appendLine(`Spawning claude: ${pathToClaudeCodeExecutable} (cwd=${cwd})`);

      const model = cfg<string>("model", "");
      const extraArgs =
        model ? ["--model", model] : [];
      child = spawnClaudeBinary({ binaryPath: pathToClaudeCodeExecutable, cwd, env, args: extraArgs });

      bridge = new McpHostBridge(child, (toolName, input, ctx) =>
        decidePermission(toolName, input, ctx)
      );

      // Register the in-process `claude-vscode-extension` MCP server (A).
      // The bridge owns the InMemoryTransport (replica of `Oie()`) and calls
      // `server.connect(transport)` inside connectSdkMcpServer().
      if (cfg<boolean>("enableExtensionMcp", true)) {
        const serverCfg: ServerConfig = extensionMcp.createServerConfig();
        bridge.connectSdkMcpServer(serverCfg.name, serverCfg.instance);
        output.appendLine(
          `Registered MCP server "${serverCfg.name}" v${serverCfg.version} (sdk)`
        );
      }

      // stdout stream → parse JSON-Lines → dispatch control_requests through bridge
      let stdoutBuf = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          void dispatchLine(line, bridge, output);
        }
      });
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (d: string) => {
        output.appendLine(`[claude stderr] ${d.trim()}`);
      });
      child.on("exit", (code) => {
        output.appendLine(`claude exited (${code})`);
        child = undefined;
        bridge = undefined;
      });
    }
  );

  const stop = vscode.commands.registerCommand("luna-vscode.stop", async () => {
    if (!child) return;
    child.kill("SIGTERM");
    child = undefined;
    bridge = undefined;
    output.appendLine("Stopped.");
  });

  context.subscriptions.push(start, stop);

  async function dispatchLine(
    line: string,
    b: McpHostBridge | undefined,
    out: vscode.OutputChannel
  ): Promise<void> {
    if (!b) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.appendLine(`[luna] non-json: ${line.slice(0, 120)}`);
      return;
    }
    if (parsed?.type === "control_request") {
      // Handle cancellation control_requests first.
      if (parsed.request?.subtype === "control_cancel") {
        b.handleControlCancelRequest(parsed.request_id);
        return;
      }
      const resp: ControlResponseMsg | undefined = await b.processControlRequest(
        parsed as ControlRequestMsg
      );
      if (resp) b.write(resp);
      return;
    }
    if (parsed?.type === "assistant" || parsed?.type === "result" || parsed?.type === "system") {
      out.appendLine(`[claude ${parsed.type}] ${JSON.stringify(parsed).slice(0, 200)}`);
      return;
    }
    out.appendLine(`[luna] ${parsed?.type ?? "unknown"}`);
  }

  /**
   * `can_use_tool` permission callback. Returns the canonical decision
   * envelope (`{behavior[...allow/deny/ask]}` or `null` to suppress).
   *
   * Out of the box this surfaces a quick-pick to the user. A real driver
   * would forward to a webview permission prompt; the contract is identical.
   */
  async function decidePermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      requestId: string;
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      signal?: AbortSignal;
    }
  ): Promise<ToolPermissionDecision> {
    if (cfg<string>("permissionMode", "default") === "bypassPermissions") {
      return { behavior: "allow", updatedInput: input };
    }
    const title = ctx.displayName || ctx.title || toolName;
    const detail =
      ctx.description ||
      (input && typeof input === "object"
        ? JSON.stringify(input).slice(0, 300)
        : "");
    const choice = await vscode.window.showWarningMessage(
      `Claude wants to use "${title}"`,
      { modal: true, detail },
      "Allow",
      "Allow for session",
      "Deny"
    );
    if (ctx.signal?.aborted) return null; // suppress — claude resent/cancelled
    switch (choice) {
      case "Allow":
      case "Allow for session":
        return { behavior: "allow", updatedInput: input };
      case "Deny":
        return { behavior: "deny", message: `User denied ${toolName}` };
      default:
        return { behavior: "ask", message: "User dismissed" };
    }
  }
}

export function deactivate(): void {
  /* host kills children on extension reload */
}