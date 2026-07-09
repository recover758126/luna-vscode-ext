/**
 * IDE-tool registry faithfully mirroring the official `anthropic.claude-code`
 * VS Code extension (v2.1.204).
 *
 * ─── Reverse-engineering finding (critical for compat) ──────────────────
 *
 * The official extension registers **two distinct** MCP servers:
 *
 *   1. `claude-vscode-extension` (v2.1.204)  — stdio `mcp_message`
 *      Built by `Ome()` (`extension.js:2042856`). Controller stubs are
 *      `registerTool:()=>{}` and `o=undefined`; `addDebuggerMcpToChannel()`
 *      adds the server only when an active debugger session exists. So by
 *      **default zero tools** are exposed on this stdio server.
 *
 *   2. `Claude Code {Editor} MCP`              — HTTP/WS bridge
 *      Built by `$ve(...)` (`extension.js:2226020`), named by `mut()`,
 *      carried via the IDE↔claude HTTP "Remote Control" server. This
 *      server registers 12 IDE-interaction tools.
 *
 * The 12 tools are implemented in `src/mcp/ideTools.ts` (byte-faithful
 * schemas + real VS Code handlers) and the HTTP/WS server that hosts them
 * is `src/mcp/ideServer.ts`. The replica starts it in `activate()`.
 *
 * `tools.ts` here exports stub `installDebuggerTools` / `installJupyterTools`
 * no-ops for backward-compat with the stdio-side `createExtensionMcpServer()`
 * — they do nothing, matching the official stub.
 */
import type { ExtensionMcpServer } from "./server";

/**
 * No-op stub, kept for API parity with `createExtensionMcpServer()`. The
 * official stdio `claude-vscode-extension` servers registers zero tools
 * (controllers are `() => {}`).
 */
export function installDebuggerTools(_svr: ExtensionMcpServer): void {
  void _svr;
}

export function installJupyterTools(_svr: ExtensionMcpServer): void {
  void _svr;
}