# Luna VS Code ext — Claude Code MCP replica

A reverse-engineered re-implementation of the **MCP server layer** that ships
inside Anthropic's official `anthropic.claude-code` VS Code extension
(v2.1.204, darwin-arm64 build). The host launches the **real bundled `claude`
native binary** and registers an in-process MCP server that Claude can call
for IDE/back-end tools.

## Reverse-engineering summary

Source: `extension/extension.js` (2.16 MB esbuild bundle), analyzed by
grepping the minified output for the MCP surface.

### Two MCP servers, two transports (critical correctness finding)

The extension registers **two distinct** MCP servers with different
natures and tool surfaces:

**A. `claude-vscode-extension` (v2.1.204) — stdio `mcp_message` control protocol**

Built by `Ome(context, output)` (`extension.js:2042856`):

```js
function Ome(e,t){
  let n = { getState: () => ({hasActiveSession:false}),          // stub debuggerController
            onStateChange: () => () => {},
            registerTool: () => {} };
  let o;                                                          // jupyterController = undefined
  function s(){
    let a = IT({name:"claude-vscode-extension", version:"2.1.204"});
    return o?.registerTool(a.instance), a;                        // ?-chained → never runs
  }
  return { createServerConfig: s, debuggerController: n, jupyterController: o };
}
```

- Exposed through the standard claude stdio `control_request{subtype:"mcp_message"}`
  route; added to a channel when an **active debugger session** exists
  (`addDebuggerMcpToChannel()` at `extension.js:2136146`).
- Controller stubs `registerTool: () => {}` and `o = undefined`}
  ⇒ **the stdio server exposes ZERO tools by default**.
- A replica's stdio server must remain toolless to stay wire-compatible.

**B. `Claude Code {Editor} MCP` (e.g. "Claude Code VSCode MCP") — HTTP/WS bridge**

Built by `$ve(...)` (`extension.js:2226020`), server name resolved by `mut()`
from `vscode.env.appName`:

```js
function $ve(e,t,r,i,n,o,s){
  let a = new Gq({name: mut(), version: e.extension.packageJSON.version || "0.0.1"});
  a.tool("openDiff", "Open a git diff for the file", {...}, handler);
  a.tool("getDiagnostics", ...);
  … 12 tools total …
  a.tool("executeCode", "Execute python code in the Jupyter kernel for the current notebook file.", {...}, handler);
  // connect() onto a `new Qq(w)` WebSocket transport (carried over the
  // IDE↔claude HTTP "Remote Control" server).
}
```

The 12 `Claude Code {Editor} MCP` tools (recovered verbatim — name,
description, inputSchema `.describe()` strings byte-identical to the bundle):

| # | name | description |
|--:|------|-------------|
| 1 | `openDiff` | "Open a git diff for the file" |
| 2 | `getDiagnostics` | "Get language diagnostics from VS Code" |
| 3 | `close_tab` | (no description — anonymous override pattern) |
| 4 | `closeAllDiffTabs` | "Close all diff tabs in the editor" |
| 5 | `openFile` | "Open a file in the editor and optionally select a range of text" (annotation `{readOnlyHint: true}`) |
| 6 | `getOpenEditors` | "Get information about currently open editors" |
| 7 | `getWorkspaceFolders` | "Get all workspace folders currently open in the IDE" |
| 8 | `getCurrentSelection` | "Get the current text selection in the active editor" |
| 9 | `checkDocumentDirty` | "Check if a document has unsaved changes (is dirty)" |
| 10 | `saveDocument` | "Save a document with unsaved changes" |
| 11 | `getLatestSelection` | "Get the most recent text selection (even if not in the active editor)" |
| 12 | `executeCode` | "Execute python code in the Jupyter kernel for the current notebook file. …" |

All 12 are now **fully implemented** in `src/mcp/ideTools.ts` (byte-faithful
schemas + real VS Code handlers) and hosted by `src/mcp/ideServer.ts` over
HTTP/WebSocket — a faithful replica of `$ve(...)`. More detail in the
"Architecture of the replica" section below.

### The factory `IT(e)` — `extension.js:1644416`

The bundle defines a factory `IT(e)` at `extension.js:1644416`:

```js
function IT(e){
  let t = new Ooe({name:e.name, version:e.version ?? "1.0.0"},
                  {capabilities:{tools:e.tools ? {} : void 0}, instructions:e.instructions});
  if (e.tools) e.tools.forEach((r)=>{
    t.registerTool(r.name, {
      description:r.description,
      inputSchema:r.inputSchema,
      annotations:r.annotations,
      _meta: e.alwaysLoad ? {"anthropic/alwaysLoad":true, ...r._meta} : r._meta
    }, r.handler);
  });
  return { type:"sdk", name:e.name, instance:t };
}
```

`Ooe` is the SDK's `McpServer` class (from `@modelcontextprotocol/sdk`).
`IT`/`new Gq(...)` is called four times in the bundle:

| # | Call site (offset)        | Server name                | Purpose                                                                  |
|---|---------------------------|----------------------------|--------------------------------------------------------------------------|
| 1 | `extension.js:1644416`    | (definition)               | the factory itself                                                        |
| 2 | `extension.js:1912795`    | `claude-vscode` v2.1.204   | host↔CLI notification channel (installs `log_event` notification handler) |
| 3 | `extension.js:2042856`    | `claude-vscode-extension` v2.1.204 | **stdio MCP server** (zero tools by default) — see "Two MCP servers" above |
| 4 | `extension.js:2226020`    | `Claude Code {Editor} MCP` (via `mut()`) | **HTTP/WS IDE-tool server** (12 tools) — see above            |

The returned `createServerConfig()` yields `{ type:"sdk", name, instance }`.
That object is handed to the channel via `query.setMcpServers({...channel.mcpServers, "claude-vscode-extension": serverConfig })`
(see `extension.js:2129312` region). Claude then addresses tools on the server
through `control_request { subtype:"mcp_message", server_name, message }` over stdout JSON-Lines.

## Architecture of the replica

```
src/
  extension.ts        VS Code activation; spawns the real claude binary,
                      registers claude-vscode-extension stdio MCP server,
                      starts the HTTP/WS `Claude Code {Editor} MCP` IDE
                      server, pumps JSON-Lines, implements the can_use_tool
                      permission flow (modal quick-pick) → ToolPermissionDecision.
  binary.ts           resolveClaudeBinary() + spawnClaudeBinary()
                      with --input-format stream-json --output-format stream-json.
  mcp/
    server.ts         IT() + Ome() replica: ToolRegistry, createExtensionMcpServer(),
                      ExtensionMcpServer interface, SERVER_NAME/SERVER_VERSION.
                      Server instance is left UN-connected; bridge owns transport.
    tools.ts          installDebuggerTools / installJupyterTools — no-op stubs
                      (the stdio `claude-vscode-extension` server registers zero
                      tools by default, matching the official stub controllers).
    transport.ts      InMemoryTransport (replica of `Oie`), SUPPRESS_CONTROL_RESPONSE
                      (replica of `lM` symbol), ToolPermissionDecision type.
    bridge.ts         McpHostBridge: pendingMcpResponses map, sdkMcpTransports map,
                      processControlRequest dispatch for can_use_tool + mcp_message,
                      handleControlCancelRequest, JSON-RPC ↔ SDK server routing
                      (replica of `connectSdkMcpServer`/`handleMcpControlRequest`).
    ideServer.ts      startIdeMcpServer() — HTTP server + WebSocketServer (replica of
                      `$ve(...)` factory). Writes the `~/.claude/ide/<port>.lock`
                      lockfile with {pid, workspaceFolders, ideName, transport:"ws",
                      runningInWindows, authToken}. Port discovery via random
                      [10000, 65535] + `isPortFree` probe (max 50 retries, matches
                      `kve`/`put`/`fut` in the bundle). Auth on the `x-claude-code-
                      ide-authorization` header.
    ideTools.ts       Real VS Code implementations of all 12 IDE tools
                      (openDiff/getDiagnostics/close_tab/closeAllDiffTabs/openFile/
                      getOpenEditors/getWorkspaceFolders/getCurrentSelection/
                      checkDocumentDirty/saveDocument/getLatestSelection/executeCode),
                      with byte-faithful zod schemas + `.describe()` strings. Plus
                      installLatestSelectionTracker() that mirrors `_ve(a, m)` and
                      `gl` by subscribing to onDidChangeTextEditorSelection.
```

### Out of scope (compat-safe / future work)

- **Webview chat UI** — official extension ships a 4.59 MB React bundle
  (messages, tool-result rendering, slash commands, permission prompts);
  not re-implemented. Permission prompts are handled with VS Code modal
  quick-picks instead, returning the same `{behavior[allow|deny|ask],
  updatedInput?}` envelope (`can_use_tool`) that the official webview does.
- **Jupyter `executeCode`** depends on the `ms-toolsai.jupyter` extension
  being installed/enabled (matches the official behaviour — `aut()`).
  `appendPythonCell` uses the stable `WorkspaceEdit` + `NotebookEdit` API
  vs. the official `notebookController.appendCode` (proposed-only).
- The 226 MB native `claude` binary is **not** re-implemented; this
  extension reuses the one from the official VSIX. Point
  `lunaCode.claudeBinaryPath` at `extension/resources/native-binary/claude`.

## Build

```powershell
npm install
npm run typecheck
npm run build      # esbuild -> dist/extension.js
# debug launch:
# F5 in VS Code with the "Extension Development Host" preset; or
npm run package    # produces luna-vscode-ext-0.1.0.vsix
```

## End-to-end flow

After activation the extension runs **two** MCP servers concurrently:

```
                  VS Code host (this extension)
        ┌───────────────────────────────────────────────┐
        │ stdio route  (claude-vscode-extension, 0 tools) │  HTTP/WS route
        │   bridge → McpHostBridge         IDE MCP server  │
        │     (pendingMcpResponses map,    :127.0.0.1/WS   │
        │      sdkMcpTransports map)        (12 IDE tools   │
        │                                  over WS)        │
        │        ▲                                ▲        │
        └────────│────────────────────────────────│────────┘
                 │                                │
                 │ stdin/stdout                   │ WebSocket (x-claude-code-
                 │ stream-json control            │   ide-authorization header)
                 ▼                                ▼
         real `claude` binary  ◄─── ~───►  real `claude` binary (same process)
                 │
                 (api.anthropic.com, MCP http servers, ...)
```

1. `luna-vscode.start` spawns the bundled `claude` (lunaCode.claudeBinaryPath)
   with `--input-format stream-json --output-format stream-json --verbose`.
2. The host writes `~/.claude/ide/<port>.lock`
   (`{pid, workspaceFolders, ideName, transport:"ws", authToken}`).
   `claude` discovers the lockfile and connects to the HTTP/WS server using
   the auth token, listing the 12 IDE tools.
3. Claude calls any of the 12 tools via JSON-RPC over the WS connection;
   the SDK server routes the call into the corresponding VS Code handler
   in `src/mcp/ideTools.ts`.
4. When Claude wants to run a CLI/file-write tool it issues a `control_request
   {subtype:"can_use_tool"}` over **stdio**; `McpHostBridge` surfaces a
   `vscode.window.showWarningMessage` modal and returns
   `{allow | deny | ask, updatedInput?}` or `null` (SUPPRESS_CONTROL_RESPONSE
   → `lM` symbol) per the bundle's contract.

## Bundle offsets index (for cross-reference)

| Symbol | Offset       | What                                    |
|--------|--------------|-----------------------------------------|
| `IT`   | 1644416      | SDK MCP server factory                  |
| `Oie`  | 1460355      | in-memory transport class                |
| `lM`   | 1460632      | `Symbol("suppressControlResponse")`     |
| `Ome`  | 2042856      | `claude-vscode-extension` factory       |
| `$ve`  | 2226020      | HTTP/WS `Claude Code {Editor} MCP` factory |
| `mut`  | 2225907      | per-editor server name resolver          |
| `Qq`   | 2224333      | WebSocket transport class                |
| `Gq`   | (in $ve)     | second McpServer class mirror            |
| `Yq`   | 2223161      | `writeLockFile(port, authToken)`         |
| `Sve`  | 2223557      | `unlinkLockFile(port)`                   |
| `kve`/`fut`/`put` | 2223013+ | port discovery (`put`/`fut`/retry)   |
| `processControlRequest` | 1468204+ | `can_use_tool` + `mcp_message` dispatch (replica in `bridge.ts`) |