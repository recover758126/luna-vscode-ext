import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import * as http from "http";
import WebSocket, { WebSocketServer } from "ws";
// `ws` namespace import kept for the WebSocketServer type only;
// static ready-state constants come from the default export.
import type * as ws from "ws";
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ideToolBindings, serverNameFor, type IdeToolDeps } from "./ideTools";

export interface IdeMcpServer {
  readonly port: number | null;
  readonly authToken: string;
  dispose(): Promise<void>;
}

/**
 * Replica of the official extension's `$ve(...)` factory
 * (`extension.js:2226020`) �?the "Claude Code {Editor} MCP" HTTP/WebSocket
 * server carrying the 12 IDE-interaction tools.
 *
 * Components, with bundle offsets:
 *   - httpServer          : `Cve.createServer()`            (Node `http`)
 *   - WebSocketServer     : `new Aq.default({server:l})`     (the `ws` package)
 *   - authToken           : `Tve.randomUUID()`              (uuid v4)
 *   - WS auth             : header `x-claude-code-ide-authorization` must === authToken
 *   - WS transport        : `new Qq(w)`                     (`WSTransport`)
 *   - SDK server + 12 tools: `new Gq({name: mut(), version})` + `a.tool(...)*12`
 *   - lock file           : `Yq(port, authToken)` written under `~/.claude/ide/<port>.lock`
 *   - lock file schema    : {pid, workspaceFolders, ideName, transport:"ws",
 *                            runningInWindows, authToken}
 *   - port discovery      : `put()` random in [10000, 65535], `fut()` probe, retry up to 50×
 *
 * Claude (the binary) finds this server by reading the lock file. We do not
 * need to register it on the channel �?the binary's IDE detection does that.
 */
export async function startIdeMcpServer(
  deps: IdeToolDeps
): Promise<IdeMcpServer> {
  const port = await findFreePort();
  const authToken = randomUUID();

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const bindings = ideToolBindings(deps);
  const mcpServer = new McpServer(
    {
      name: serverNameFor(),
      version: deps.version,
    },
    { capabilities: { tools: {} } }
  );

  for (const tool of bindings) {
    // Casting through `any` avoids TS2589 ("Type instantiation excessively
    // deep") that the SDK's recursive registerTool<> generics trigger when
    // given a 6-field mixed object schema (e.g. openFile).
    const reg: any = mcpServer.registerTool.bind(mcpServer);
    reg(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as any,
        annotations: tool.annotations as any,
        _meta: tool._meta,
      },
      async (args: any, extra: any) => tool.handler(args, extra)
    );
  }

  let activeTransport: WSTransport | null = null;
  // `diagnosticsSub` is reserved for wiring `vscode.languages.onDidChangeDiagnostics`
  // �?WS broadcast of `diagnostics_changed` notifications (replica of
  // `xd.registerClient(cb)` in the bundle). Currently unused.
  const diagnosticsSub: vscode.Disposable | undefined = undefined;

  wss.on("connection", (socket: ws.WebSocket, req: http.IncomingMessage) => {
    const header = req.headers["x-claude-code-ide-authorization"];
    if (header !== authToken) {
      deps.logger.error("Unauthorized WebSocket connection attempt");
      socket.close(1008, "Unauthorized");
      return;
    }
    deps.logger.info(`New WS connection from: ${req.url || "unknown"}`);

    if (activeTransport) {
      deps.logger.info("Disconnecting previous WebSocket client");
      try {
        activeTransport.close();
      } catch (e) {
        deps.logger.error(`Error closing previous transport: ${(e as Error).message}`);
      }
    }

    const transport = new WSTransport(socket);
    activeTransport = transport;

    mcpServer.connect(transport as any).catch((e: Error) => {
      // Bubble up the way the bundle does (console.error).
      console.error("Error connecting transport:", e);
      activeTransport = null;
      try {
        socket.close();
      } catch (closeErr) {
        deps.logger.error(`Error closing WebSocket: ${(closeErr as Error).message}`);
      }
    });
  });

  // Write the lock file in `~/.claude/ide/<port>.lock` (matches `Yq` in bundle)
  const lockPath = writeLockFile(port, authToken);
  deps.logger.info(`Lock file written: ${lockPath}`);

  const workspaceFoldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    writeLockFile(port, authToken);
    deps.logger.info(`Updated lock file for port ${port} with new workspace folders`);
  });

  return {
    port,
    authToken,
    async dispose() {
      try {
        fs.unlinkSync(lockPath);
        deps.logger.info(`Deleted lock file for port ${port}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          console.error(`Failed to delete lock file ${lockPath}:`, e);
        }
      }
      workspaceFoldersSub.dispose();
      (diagnosticsSub as vscode.Disposable | undefined)?.dispose();
      wss.close();
      httpServer.close();
      try {
        await mcpServer.close();
      } catch {
        /* ignore */
      }
    },
  };
}

class WSTransport {
  readonly ws: ws.WebSocket;
  started = false;
  private opened: Promise<void>;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (msg: unknown) => void;

  constructor(socket: ws.WebSocket) {
    this.ws = socket;
    this.opened = new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) resolve();
      else {
        socket.on("open", () => resolve());
        socket.on("error", (e: Error) => reject(e));
      }
    });
    socket.on("message", (data: Buffer) => this.onMessageHandler(data));
    socket.on("error", (e: Error) => this.onErrorHandler(e));
    socket.on("close", () => this.onCloseHandler());
  }

  private onMessageHandler = (data: Buffer) => {
    try {
      const parsed = JSON.parse(data.toString("utf-8"));
      this.onmessage?.(parsed);
    } catch (e) {
      this.onErrorHandler(e as Error);
    }
  };

  private onErrorHandler = (e: Error) => {
    this.onerror?.(e instanceof Error ? e : new Error("Failed to process message"));
  };

  private onCloseHandler = () => {
    this.onclose?.();
    this.ws.off("message", this.onMessageHandler as any);
    this.ws.off("error", this.onErrorHandler as any);
    this.ws.off("close", this.onCloseHandler as any);
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("Start can only be called once per transport.");
    await this.opened;
    if (this.ws.readyState !== WebSocket.OPEN)
      throw new Error("WebSocket is not open. Cannot start transport.");
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.close();
    this.onCloseHandler();
  }

  async send(msg: unknown): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN)
      throw new Error("WebSocket is not open. Cannot send message.");
    const text = JSON.stringify(msg);
    await new Promise<void>((resolve, reject) => {
      this.ws.send(text, (err: Error | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/* ── Lock file (matches `Yq` / `Sve` in bundle) ───────────────────────────── */

export function claudeIdeDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const dir = path.join(configDir, "ide");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* already exists */
  }
  return dir;
}

function writeLockFile(port: number, authToken: string): string {
  const dir = claudeIdeDir();
  const lockPath = path.join(dir, `${port}.lock`);
  const existed = fs.existsSync(lockPath);
  const workspaceFolders =
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
  const payload = {
    pid: process.ppid,
    workspaceFolders,
    ideName: vscode.env.appName,
    transport: "ws" as const,
    runningInWindows: process.platform === "win32",
    authToken,
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload), { mode: 0o600 });
  if (!existed) console.log(`Created lock file: ${lockPath}`);
  return lockPath;
}

/* ── Port discovery (`kve` / `put` / `fut` in bundle) ────────────────────── */

function randomPortCandidate(): number {
  return Math.floor(Math.random() * 55536) + 10000;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close();
      resolve(true);
    });
    probe.listen(port, "127.0.0.1");
  });
}

async function findFreePort(maxAttempts = 50): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = randomPortCandidate();
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error("Failed to find an available port after multiple attempts");
}