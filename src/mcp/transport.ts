/**
 * In-memory replica of the official extension's `Oie` SDK MCP transport.
 *
 * From `extension.js:1460355`:
 *   class Oie { sendMcpMessage; isClosed=false;
 *     constructor(sendMcpMessage){ this.sendMcpMessage=sendMcpMessage; }
 *     onclose; onerror; onmessage;
 *     async start(){}                       // no-op (in-memory)
 *     async send(e){ if(this.isClosed) throw Error("Transport is closed");
 *                     this.sendMcpMessage(e); }
 *     async close(){ if(this.isClosed) return; this.isClosed=true; this.onclose?.(); }
 *   }
 *
 * Claude ↔ host protocol:
 *  - claude sends:   control_request { subtype:"mcp_message", server_name, message:<jsonrpc> }
 *  - host calls:     transport.onmessage(message)   →  SDK server handles it
 *  - SDK server replies via: transport.send(replyMsg)
 *  - send sends:     `transport.sendMcpMessage(msg)` which (in the official
 *                    code) writes a NEW control_request{subtype:"mcp_message",...}
 *                    back to claude for *notifications*, or resolves the
 *                    pending promise keyed `<serverName>:<id>` for *requests*.
 *
 * This file implements just the transport half. The pending-response pairing
 * lives in the host bridge (`McpHostBridge`).
 */

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export class InMemoryTransport {
  readonly sendMcpMessage: (msg: JsonRpcMessage) => void;
  isClosed = false;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (msg: JsonRpcMessage) => void;

  constructor(sendMcpMessage: (msg: JsonRpcMessage) => void) {
    this.sendMcpMessage = sendMcpMessage;
  }

  async start(): Promise<void> {
    /* in-memory; nothing to do */
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.isClosed) throw new Error("Transport is closed");
    this.sendMcpMessage(msg);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onclose?.();
  }
}

/**
 * Minimal Transport interface compatible with @modelcontextprotocol/sdk's
 * `Transport` contract. The SDK only needs { start, send, close, onmessage,
 * onerror, onclose } — all present here.
 */
export interface TransportLike {
  start(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (msg: JsonRpcMessage) => void;
  onerror?: (e: Error) => void;
  onclose?: () => void;
}

export const SUPPRESS_CONTROL_RESPONSE: symbol = Symbol("suppressControlResponse");

/**
 * Canonical permission decision envelope that `canUseTool` returns.
 *
 * From `extension.js`: the SDK returns either `null` (→ `lM`, suppress the
 * control_response — claude re-asks later / uses default), or one of:
 *   { behavior:"allow",    updatedInput:{...} }
 *   { behavior:"deny",     message:"..."      }
 *   { behavior:"ask",      message:"..."      }   // claude surfaces to user
 * `toolUseID` patching happens in the host, not here.
 */
export type ToolPermissionDecision =
  | null
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string };

export type { JsonRpcMessage };