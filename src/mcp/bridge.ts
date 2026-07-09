import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InMemoryTransport,
  SUPPRESS_CONTROL_RESPONSE,
  type JsonRpcMessage,
  type ToolPermissionDecision,
} from "./transport";

export type { ToolPermissionDecision };

/**
 * Inbound `control_request` envelopes Claude pipes to us.
 * Shape recovered from the bundle's `processControlRequest` switch.
 */
export interface ControlRequestMsg {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    /* can_use_tool */
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_use_id?: string;
    agent_id?: string;
    title?: string;
    display_name?: string;
    description?: string;
    decision_reason?: string;
    blocked_path?: string;
    permission_suggestions?: unknown;
    /* mcp_message */
    server_name?: string;
    message?: JsonRpcMessage;
    /* elicitation */
    elicitation_id?: string;
    requested_schema?: unknown;
    mode?: string;
    url?: string;
    mcp_server_name?: string;
    [k: string]: unknown;
  };
}

export type ControlResponsePayload =
  | { mcp_response: unknown }
  | { behavior: "allow" | "deny" | "ask"; updatedInput?: unknown; message?: string; toolUseID?: string }
  | typeof SUPPRESS_CONTROL_RESPONSE
  | Record<string, unknown>;

export interface ControlResponseMsg {
  type: "control_response";
  request_id: string;
  response?: ControlResponsePayload;
  error?: { message: string; [k: string]: unknown };
}

/** Called with (toolName, input, ctx) → decision. Host provides this. */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: {
    requestId: string;
    toolUseID?: string;
    agentID?: string;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    blockedPath?: string;
    signal?: AbortSignal;
  }
) => Promise<ToolPermissionDecision>;

/**
 * Replica of the SDK-side state on the bundle's `Xj` / `Query` class:
 *   sdkMcpTransports:  Map<serverName, Oie>
 *   pendingMcpResponses: Map<`${serverName}:${id}`, {resolve,reject}>
 *
 * Pipes JSON-RPC between claude stdio and the (in-process) SDK McpServer.
 */
export class McpHostBridge {
  private pendingMcpResponses = new Map<
    string,
    { resolve: (v: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  private sdkMcpTransports = new Map<string, InMemoryTransport>();
  private sdkServerInstances = new Map<string, McpServer>();
  private abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly canUseTool: CanUseToolCallback
  ) {}

  /** Register a `type:"sdk"` server under its canonical name. */
  connectSdkMcpServer(serverName: string, server: McpServer): InMemoryTransport {
    const transport = new InMemoryTransport((msg) => this.sendMcpMessageToCli(serverName, msg));
    this.sdkMcpTransports.set(serverName, transport);
    this.sdkServerInstances.set(serverName, server);
    server.connect(transport as any).catch((e: Error) => {
      if (this.sdkMcpTransports.get(serverName) === transport) this.sdkMcpTransports.delete(serverName);
      if (this.sdkServerInstances.get(serverName) === server) this.sdkServerInstances.delete(serverName);
      this.log(`MCP connect failed for ${serverName}: ${e.message}`);
    });
    return transport;
  }

  async disconnectSdkMcpServer(name: string): Promise<void> {
    const t = this.sdkMcpTransports.get(name);
    if (t) {
      await t.close();
      this.sdkMcpTransports.delete(name);
    }
    this.sdkServerInstances.delete(name);
  }

  /** Main dispatch: processes a parsed inbound control_request line. */
  async processControlRequest(line: ControlRequestMsg): Promise<ControlResponseMsg | undefined> {
    const { request_id, request } = line;

    switch (request.subtype) {
      case "can_use_tool": {
        return await this.handleCanUseTool(request_id, request);
      }
      case "mcp_message": {
        return await this.handleMcpMessage(request_id, request);
      }
      default: {
        // Subtypes not handled by this replica (hook_callback, elicitation,
        // request_user_dialog, claude_authenticate, …) — return a benign ack.
        return this.wrap(request_id, { ack: request.subtype });
      }
    }
  }

  // ---- can_use_tool --------------------------------------------------------
  private async handleCanUseTool(
    requestId: string,
    req: ControlRequestMsg["request"]
  ): Promise<ControlResponseMsg | undefined> {
    const ac = new AbortController();
    this.abortControllers.set(requestId, ac);
    try {
      const decision = await this.canUseTool(req.tool_name ?? "", (req.tool_input as any) ?? {}, {
        requestId,
        toolUseID: req.tool_use_id,
        agentID: req.agent_id,
        title: req.title,
        displayName: req.display_name,
        description: req.description,
        decisionReason: req.decision_reason,
        blockedPath: req.blocked_path,
        signal: ac.signal,
      });
      if (decision === null) {
        // Official: returns `lM` (Symbol("suppressControlResponse")) → no response sent.
        return undefined;
      }
      return this.wrap(requestId, {
        ...decision,
        toolUseID: req.tool_use_id,
      });
    } catch (e) {
      return this.wrapErr(requestId, (e as Error).message);
    } finally {
      this.abortControllers.delete(requestId);
    }
  }

  handleControlCancelRequest(requestId: string): void {
    const ac = this.abortControllers.get(requestId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(requestId);
    }
  }

  // ---- mcp_message ---------------------------------------------------------
  private async handleMcpMessage(
    requestId: string,
    req: ControlRequestMsg["request"]
  ): Promise<ControlResponseMsg> {
    const serverName = req.server_name ?? "";
    const message = req.message as JsonRpcMessage;
    const transport = this.sdkMcpTransports.get(serverName);
    if (!transport) {
      return this.wrapErr(requestId, `SDK MCP server not found: ${serverName}`);
    }

    // Official envelope:
    //   if message has `method` AND `id !== null`  → await handleMcpControlRequest (request)
    //   else                                       → transport.onmessage(msg) ; synthesize ack
    if (message && "method" in message && "id" in message && message.id !== null && message.id !== undefined) {
      const mcpResponse = await this.handleMcpControlRequest(serverName, message, transport);
      return this.wrap(requestId, { mcp_response: mcpResponse });
    }
    if (transport.onmessage) transport.onmessage(message);
    return this.wrap(requestId, { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } });
  }

  /** Pairs a request id; SDK server reply (via transport.send) resolves it. */
  private handleMcpControlRequest(
    serverName: string,
    message: JsonRpcMessage,
    transport: InMemoryTransport
  ): Promise<unknown> {
    const id = ("id" in message && (message as any).id !== null && (message as any).id !== undefined)
      ? (message as any).id
      : null;
    const key = `${serverName}:${id}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => this.pendingMcpResponses.delete(key);
      const resolveOnce = (v: JsonRpcMessage) => {
        cleanup();
        resolve(v);
      };
      const rejectOnce = (e: Error) => {
        cleanup();
        reject(e);
      };
      this.pendingMcpResponses.set(key, { resolve: resolveOnce, reject: rejectOnce });
      if (transport.onmessage) {
        transport.onmessage(message);
      } else {
        cleanup();
        reject(new Error("No message handler registered"));
      }
    });
  }

  /** SDK server calls this via transport.send(). Mirrors `sendMcpServerMessageToCli`. */
  private sendMcpMessageToCli(serverName: string, msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== null && msg.id !== undefined) {
      const key = `${serverName}:${msg.id}`;
      const pending = this.pendingMcpResponses.get(key);
      if (pending) {
        pending.resolve(msg);
        this.pendingMcpResponses.delete(key);
        return;
      }
      // No pending request for this id → it's a server-initiated request
      // (e.g. elicitation). Forward to claude as a fresh control_request.
    }
    // Either a notification or unmatched response → forward into claude.
    const out: ControlRequestMsg = {
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "mcp_message", server_name: serverName, message: msg },
    };
    this.write(out);
  }

  // ---- plumbing ------------------------------------------------------------
  private wrap(request_id: string, response: Record<string, unknown>): ControlResponseMsg {
    return { type: "control_response", request_id, response };
  }
  private wrapErr(request_id: string, message: string): ControlResponseMsg {
    return { type: "control_response", request_id, error: { message } };
  }
  private log(s: string): void {
    // stderr — not piped through claude, surfaces in the host output channel.
    process.stderr.write(`[luna-bridge] ${s}\n`);
  }

  write(msg: object): void {
    this.child.stdin.write(JSON.stringify(msg) + "\n", (err) => {
      if (err) this.log(`write error: ${err.message}`);
    });
  }
}