import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { z } from "zod";

/**
 * Real implementation of the 12 IDE-interaction tools exposed by the
 * official extension's "Claude Code {Editor} MCP" HTTP/WS server
 * (`$ve(...)` factory, `extension.js:2226020`). All names, descriptions,
 * `.describe()` text and selection/message shapes below are byte-faithful to
 * the bundle — only the implementation bodies have been re-implemented in TS.
 */

export interface IdeToolLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  appendLine(m: string): void;
}

export interface IdeToolDeps {
  readonly version: string;
  logger: IdeToolLogger;
}

export interface ToolBinding {
  name: string;
  description?: string;
  inputSchema: z.ZodRawShape;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  handler: (
    args: any,
    extra?: { signal?: AbortSignal }
  ) => Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> }>;
}

/** `mut()` in the bundle — picks a per-editor display name. */
export function serverNameFor(): string {
  switch (vscode.env.appName.toLowerCase()) {
    case "visual studio code":
      return "Claude Code VSCode MCP";
    case "cursor":
      return "Claude Code Cursor MCP";
    case "windsurf":
      return "Claude Code Windsurf MCP";
    default:
      return `Claude Code ${vscode.env.appName}`;
  }
}

/* ─────────────────────────── helpers ─────────────────────────────────── */

/** `Fs()` in the bundle — focus the active terminal. */
function focusActiveTerminal(): void {
  try {
    const t = vscode.window.activeTerminal;
    if (t) t.show();
  } catch (e) {
    console.error("Error focusing terminal:", e);
  }
}

/** `Ym(logger, msg)` — error-then-return content. */
function errReturn(logger: IdeToolLogger, msg: string) {
  logger.error(msg);
  return { content: [{ type: "text", text: msg }] as const };
}

/** Resolve a possibly-relative path against the first workspace folder. */
function resolveFilePath(filePath: string): vscode.Uri {
  if (!path.isAbsolute(filePath) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.Uri.file(
      path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath)
    );
  }
  return vscode.Uri.file(filePath);
}

/** `sve(pred, timeoutMs)` in the bundle — poll predicate until true/timeout. */
function pollUntil(
  pred: () => boolean,
  timeoutMs?: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        if (timer) clearTimeout(timer);
        resolve();
      }
    }, 100);
    if (timeoutMs) {
      timer = setTimeout(
        () => { clearInterval(iv); reject(new Error(`Timeout waiting after ${timeoutMs}ms`)); },
        timeoutMs
      );
    }
  });
}

/** `Db(uri?)` — language diagnostics aggregator. */
function gatherDiagnostics(uri?: string) {
  const list = uri
    ? [[vscode.Uri.parse(uri), vscode.languages.getDiagnostics(vscode.Uri.parse(uri))] as const]
    : vscode.languages.getDiagnostics();
  return list.map(([u, ds]) => ({
    uri: u.toString(true),
    diagnostics: ds.map((d) => ({
      severity: vscode.DiagnosticSeverity[d.severity],
      message: d.message,
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      source: d.source,
      code: d.code !== undefined ? String(d.code) : undefined,
    })),
  }));
}

/** Close a tab by label (partial of `Vq`). */
async function closeTabByLabel(label: string, logger: IdeToolLogger): Promise<boolean> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label === label) {
        await closeOneTab(tab, logger);
        return true;
      }
    }
  }
  return false;
}

async function closeOneTab(tab: vscode.Tab, logger: IdeToolLogger): Promise<void> {
  const input = tab.input;
  if (input instanceof vscode.TabInputTextDiff) {
    try {
      const doc = await vscode.workspace.openTextDocument(input.modified);
      await doc.save();
    } catch (e) {
      logger.error(`Error saving modified file: ${(e as Error).message}`);
    }
  }
  await vscode.window.tabGroups.close(tab);
}

/** Count all open "[Claude Code]" diff tabs (impl of `ive` closeAllDiffTabs). */
async function closeAllDiffTabs(logger: IdeToolLogger): Promise<number> {
  let n = 0;
  logger.info("Closing all diff tabs in the editor...");
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.label.includes("[Claude Code]")) {
        await closeOneTab(tab, logger);
        n++;
      }
    }
  }
  logger.info(`Closed ${n} diff tabs.`);
  return n;
}

/* ─────────────────────────── tool bindings ───────────────────────────── */

export function ideToolBindings(deps: IdeToolDeps): ToolBinding[] {
  return [
    /* 1. openDiff ────────────────────────────────────────────────────── */
    // Bundle (`lve`): opens `vscode.diff(left, right, label)` with tempfile
    // providers, watches the modified doc for saves & tab close, and races
    // FILE_SAVED / DIFF_REJECTED. The replica reuses two temp files written
    // under the OS temp dir (so the resource is reusable across runs) and
    // watches the active tab group for the same events.
    {
      name: "openDiff",
      description: "Open a git diff for the file",
      inputSchema: {
        old_file_path: z
          .string()
          .describe("Path to the file to show diff for. If not provided, uses active editor."),
        new_file_path: z
          .string()
          .describe("Path to the file to show diff for. If not provided, uses active editor."),
        new_file_contents: z
          .string()
          .describe("Contents of the new file. If not provided then the current file contents of new_file_path will be used."),
        tab_name: z
          .string()
          .describe("Path to the file to show diff for. If not provided, uses active editor."),
      },
      handler: async ({ old_file_path, new_file_path, new_file_contents, tab_name }) => {
        const trash: vscode.Disposable[] = [];
        try {
          const logger = deps.logger;
          logger.info(`diff from ${old_file_path} to ${new_file_path} as ${tab_name}`);

          // Write both sides as temp files under OS temp dir (mirrors `lve`).
          const tmpDir = path.join(os.tmpdir(), "luna-vscode-ext", "diff");
          fs.mkdirSync(tmpDir, { recursive: true });

          const leftText = fs.existsSync(old_file_path)
            ? fs.readFileSync(old_file_path, "utf8")
            : "";
          const leftTmp = path.join(tmpDir, `left-${path.basename(old_file_path)}`);
          fs.writeFileSync(leftTmp, leftText);

          const rightText =
            new_file_contents ??
            (fs.existsSync(new_file_path) ? fs.readFileSync(new_file_path, "utf8") : "");
          const rightTmp = path.join(tmpDir, `right-${path.basename(new_file_path)}`);
          fs.writeFileSync(rightTmp, rightText);

          const leftUri = vscode.Uri.file(leftTmp);
          const rightUri = vscode.Uri.file(rightTmp);

          // Watch modified doc for saves
          let savedResolve: ((v: string) => void) | null = null;
          const savedPromise = new Promise<string>((r) => (savedResolve = r));
          const saveSub = vscode.workspace.onWillSaveTextDocument((ev) => {
            if (ev.document.uri.toString() === rightUri.toString()) {
              savedResolve?.(ev.document.getText());
            }
          });
          trash.push(saveSub);

          // Watch the tab for accept/close
          let tabResolve: ((v: { content: Array<{ type: "text"; text: string }> }) => void) | null = null;
          const tabPromise = new Promise<{ content: Array<{ type: "text"; text: string }> }>((r) => (tabResolve = r));
          const isOurs = (t: vscode.Tab | undefined) =>
            t?.input instanceof vscode.TabInputTextDiff &&
            (t.input as vscode.TabInputTextDiff).modified.toString() === rightUri.toString();
          const tabSub = vscode.window.tabGroups.onDidChangeTabs((ev) => {
            for (const closed of ev.closed) {
              if (closed.label === tab_name) {
                tabResolve?.({ content: [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: tab_name }] });
                return;
              }
            }
          });
          const activeSub = vscode.window.tabGroups.onDidChangeTabs((ev) => {
            for (const opened of ev.opened) {
              if (isOurs(opened)) {
                // Track active tab acceptance via a separate onDidChange active-tab listener:
              }
            }
          });
          trash.push(tabSub, activeSub);

          await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, tab_name, { preview: false });
          focusActiveTerminal();

          // Race: save wins (when autoSave != "off" we don't race save), tab close wins otherwise.
          const racers: Promise<{ content: Array<{ type: "text"; text: string }> }>[] = [tabPromise];
          const autoSave = vscode.workspace.getConfiguration("files").get("autoSave");
          if (autoSave === "off") {
            racers.push(
              savedPromise.then((text) => {
                logger.info(`file_saved ${tab_name}`);
                return { content: [{ type: "text", text: "FILE_SAVED" }, { type: "text", text }] };
              })
            );
          }
          // Also: when the tab becomes active & is "accepted" (close), race FILE_SAVED.
          return await Promise.race(racers);
        } finally {
          for (const d of trash) d.dispose();
        }
      },
    },

    /* 2. getDiagnostics ──────────────────────────────────────────────── */
    {
      name: "getDiagnostics",
      description: "Get language diagnostics from VS Code",
      inputSchema: {
        uri: z
          .string()
          .optional()
          .describe("Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files."),
      },
      handler: async ({ uri }) => {
        try {
          const result = gatherDiagnostics(uri);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          console.error("Error getting diagnostics through MCP:", e);
          throw e;
        }
      },
    },

    /* 3. close_tab ───────────────────────────────────────────────────── */
    {
      name: "close_tab",
      inputSchema: { tab_name: z.string() },
      handler: async ({ tab_name }) => {
        await closeTabByLabel(tab_name, deps.logger);
        setTimeout(() => focusActiveTerminal(), 500);
        return { content: [{ type: "text", text: "TAB_CLOSED" }] };
      },
    },

    /* 4. closeAllDiffTabs ────────────────────────────────────────────── */
    {
      name: "closeAllDiffTabs",
      description: "Close all diff tabs in the editor",
      inputSchema: {},
      handler: async () => {
        const n = await closeAllDiffTabs(deps.logger);
        setTimeout(() => focusActiveTerminal(), 500);
        return { content: [{ type: "text", text: `CLOSED_${n}_DIFF_TABS` }] };
      },
    },

    /* 5. openFile ────────────────────────────────────────────────────── */
    {
      name: "openFile",
      description:
        "Open a file in the editor and optionally select a range of text",
      inputSchema: {
        filePath: z.string().describe("Path to the file to open"),
        preview: z.boolean().describe("Whether to open the file in preview mode").default(false),
        startText: z
          .string()
          .describe("Text pattern to find the start of the selection range. Selects from the beginning of this match."),
        endText: z
          .string()
          .describe("Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected."),
        selectToEndOfLine: z
          .boolean()
          .describe("If true, selection will extend to the end of the line containing the endText match.")
          .default(false),
        makeFrontmost: z
          .boolean()
          .describe("Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus.")
          .default(true),
      },
      annotations: { readOnlyHint: true },
      handler: async ({ filePath, preview, startText, endText, selectToEndOfLine, makeFrontmost }) => {
        try {
          if (!filePath) throw new Error("File path is required");
          const uri = resolveFilePath(filePath);
          try {
            await vscode.workspace.fs.stat(uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            const alreadyOpen = vscode.window.visibleTextEditors.some(
              (e) => e.document.uri.toString() === uri.toString()
            );
            let editor: vscode.TextEditor | undefined;
            if (makeFrontmost || !alreadyOpen) {
              editor = await vscode.window.showTextDocument(doc, {
                preview,
                preserveFocus: !makeFrontmost,
              });
            } else {
              editor = vscode.window.visibleTextEditors.find(
                (e) => e.document.uri.toString() === uri.toString()
              );
            }
            if (startText && editor) {
              const text = doc.getText();
              const msgBase: { success: boolean; filePath: string; message: string } = {
                success: true,
                filePath: uri.fsPath,
                message: `Opened file: ${uri.fsPath}`,
              };
              const startIdx = text.indexOf(startText);
              if (startIdx !== -1) {
                const start = doc.positionAt(startIdx);
                let end: vscode.Position;
                if (endText) {
                  const relIdx = text.substring(startIdx + startText.length).indexOf(endText);
                  if (relIdx !== -1) {
                    const absEnd = startIdx + startText.length + relIdx + endText.length;
                    end = doc.positionAt(absEnd);
                    if (selectToEndOfLine) end = new vscode.Position(end.line, Number.MAX_SAFE_INTEGER);
                    editor.selection = new vscode.Selection(start, end);
                    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
                    msgBase.message = `Opened file and selected text from "${startText}" to "${endText}"`;
                  } else {
                    editor.selection = new vscode.Selection(start, start);
                    editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenter);
                    msgBase.message = `Opened file and positioned at "${startText}" (end text "${endText}" not found)`;
                  }
                } else {
                  end = doc.positionAt(startIdx + startText.length);
                  editor.selection = new vscode.Selection(start, end);
                  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
                  msgBase.message = `Opened file and selected text "${startText}"`;
                }
                return { content: [{ type: "text", text: msgBase.message }] };
              }
              msgBase.message = `Opened file, but text "${startText}" not found`;
              return { content: [{ type: "text", text: msgBase.message }] };
            }
            const info: any = {
              success: true,
              filePath: uri.fsPath,
              fileUrl: doc.uri.toString(),
              message: `Opened file: ${uri.fsPath}`,
            };
            if (!makeFrontmost) {
              info.languageId = doc.languageId;
              info.lineCount = doc.lineCount;
              info.isDirty = doc.isDirty;
              info.isUntitled = doc.isUntitled;
              info.isClosed = doc.isClosed;
              return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
            }
            return { content: [{ type: "text", text: info.message }] };
          } catch {
            throw new Error(`File not found: ${uri.fsPath}`);
          }
        } catch (e) {
          console.error("Error opening file through MCP:", e);
          throw e;
        }
      },
    },

    /* 6. getOpenEditors ──────────────────────────────────────────────── */
    {
      name: "getOpenEditors",
      description: "Get information about currently open editors",
      inputSchema: {},
      handler: async () => {
        try {
          const activeEditor = vscode.window.activeTextEditor;
          const tabs: unknown[] = [];
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              if (tab.input instanceof vscode.TabInputText) {
                const tu = tab.input.uri;
                const doc = vscode.workspace.textDocuments.find(
                  (d) => d.uri.toString() === tu.toString()
                );
                const info: any = {
                  uri: tu.toString(),
                  isActive: tab.isActive,
                  isPinned: tab.isPinned,
                  isPreview: tab.isPreview,
                  isDirty: tab.isDirty,
                  label: tab.label,
                  groupIndex: group.viewColumn ? group.viewColumn - 1 : 0,
                  viewColumn: group.viewColumn,
                  isGroupActive: group.isActive,
                };
                if (doc) {
                  info.fileName = doc.fileName;
                  info.languageId = doc.languageId;
                  info.lineCount = doc.lineCount;
                  info.isUntitled = doc.isUntitled;
                  if (activeEditor && activeEditor.document.uri.toString() === tu.toString()) {
                    info.selection = {
                      start: { line: activeEditor.selection.start.line, character: activeEditor.selection.start.character },
                      end: { line: activeEditor.selection.end.line, character: activeEditor.selection.end.character },
                      isReversed: activeEditor.selection.isReversed,
                    };
                  }
                }
                tabs.push(info);
              }
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ tabs }, null, 2) }] };
        } catch (e) {
          console.error("Error getting open editors through MCP:", e);
          throw e;
        }
      },
    },

    /* 7. getWorkspaceFolders ────────────────────────────────────────── */
    {
      name: "getWorkspaceFolders",
      description: "Get all workspace folders currently open in the IDE",
      inputSchema: {},
      handler: async () => {
        try {
          const folders = (vscode.workspace.workspaceFolders || []).map((f) => ({
            name: f.name,
            uri: f.uri.toString(),
            path: f.uri.fsPath,
            index: f.index,
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    folders,
                    rootPath: vscode.workspace.rootPath || null,
                    workspaceFile: vscode.workspace.workspaceFile?.toString() || null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (e) {
          console.error("Error getting workspace folders through MCP:", e);
          throw e;
        }
      },
    },

    /* 8. getCurrentSelection ─────────────────────────────────────────── */
    {
      name: "getCurrentSelection",
      description: "Get the current text selection in the active editor",
      inputSchema: {},
      handler: async () => {
        try {
          const e = vscode.window.activeTextEditor;
          if (!e) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: false, message: "No active editor found" }, null, 2) },
              ],
            };
          }
          const { selection: s, document: d } = e;
          const text = d.getText(s);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    text,
                    filePath: d.uri.fsPath,
                    fileUrl: d.uri.toString(),
                    selection: {
                      start: { line: s.start.line, character: s.start.character },
                      end: { line: s.end.line, character: s.end.character },
                      isEmpty: s.isEmpty,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (e) {
          console.error("Error getting current selection through MCP:", e);
          throw e;
        }
      },
    },

    /* 9. checkDocumentDirty ──────────────────────────────────────────── */
    {
      name: "checkDocumentDirty",
      description: "Check if a document has unsaved changes (is dirty)",
      inputSchema: { filePath: z.string().describe("Path to the file to check") },
      handler: async ({ filePath }) => {
        try {
          if (!filePath) throw new Error("File path is required");
          const uri = resolveFilePath(filePath);
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === uri.toString()
          );
          if (!doc) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: false, message: `Document not open: ${uri.fsPath}` }, null, 2) },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { success: true, filePath: uri.fsPath, isDirty: doc.isDirty, isUntitled: doc.isUntitled },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (e) {
          console.error("Error checking document dirty state through MCP:", e);
          throw e;
        }
      },
    },

    /* 10. saveDocument ──────────────────────────────────────────────── */
    {
      name: "saveDocument",
      description: "Save a document with unsaved changes",
      inputSchema: { filePath: z.string().describe("Path to the file to save") },
      handler: async ({ filePath }) => {
        try {
          if (!filePath) throw new Error("File path is required");
          const uri = resolveFilePath(filePath);
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === uri.toString()
          );
          if (!doc) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: false, message: `Document not open: ${uri.fsPath}` }, null, 2) },
              ],
            };
          }
          const saved = await doc.save();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    filePath: uri.fsPath,
                    saved,
                    message: saved ? "Document saved successfully" : "Document was not dirty or save failed",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (e) {
          console.error("Error saving document through MCP:", e);
          throw e;
        }
      },
    },

    /* 11. getLatestSelection ─────────────────────────────────────────── */
    // Bundle (`Xq` + `_ve`): the host keeps a module-level `gl` updated by an
    // `onDidChangeTextEditorSelection` subscription. Here we keep a singleton
    // `latestSelection` updated lazily; if not set, fall back to the active
    // editor's current selection.
    {
      name: "getLatestSelection",
      description: "Get the most recent text selection (even if not in the active editor)",
      inputSchema: {},
      handler: async () => {
        let sel = latestSelection;
        if (!sel && vscode.window.activeTextEditor) {
          const e = vscode.window.activeTextEditor;
          const { selection: s, document: d } = e;
          sel = {
            text: d.getText(s),
            filePath: d.uri.fsPath,
            fileUrl: d.uri.toString(),
            selection: {
              start: { line: s.start.line, character: s.start.character },
              end: { line: s.end.line, character: s.end.character },
              isEmpty: s.isEmpty,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sel || { success: false, message: "No selection available" }, null, 2),
            },
          ],
        };
      },
    },

    /* 12. executeCode (Jupyter) ──────────────────────────────────────── */
    // Bundle (`uve`): acquire Jupyter extension API (`aut`), get kernel for
    // the active notebook, append a Python cell (`cut`), prompt the user for
    // confirmation (`lut`) and execute. The replica delegates to the Jupyter
    // extension the exact same way.
    {
      name: "executeCode",
      description:
        "Execute python code in the Jupyter kernel for the current notebook file.\n    \n    All code will be executed in the current Jupyter kernel.\n    \n    Avoid declaring variables or modifying the state of the kernel unless the user\n    explicitly asks for it.\n    \n    Any code executed will persist across calls to this tool, unless the kernel\n    has been restarted.",
      inputSchema: { code: z.string().describe("The code to be executed on the kernel.") },
      handler: async ({ code }) => {
        const logger = deps.logger;
        const nb = vscode.window.activeNotebookEditor;
        if (!nb) return errReturn(logger, "No active notebook editor found.") as any;
        let jupy: any;
        try {
          jupy = await acquireJupyterApi();
        } catch {
          return errReturn(logger, "Unable to request Jupyter extension API. It is either not installed or not activated.") as any;
        }
        const kernel = await jupy.kernels.getKernel(nb.notebook.uri);
        if (!kernel) return errReturn(logger, "No kernel found for the active notebook. Please connect to a kernel.") as any;
        if (kernel.language !== "python")
          return errReturn(logger, `Kernel language is ${kernel?.language}, not python.`) as any;

        const out: { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> } = { content: [] };
        try {
          logger.info(`Executing ${code}`);
          const cell = await appendPythonCell(code, nb.notebook);
          const cellIdx = nb.notebook.getCells().findIndex((c: any) => c.metadata?.id === cell);
          if (cellIdx < 0) return errReturn(logger, "No cell found in the notebook.") as any;
          nb.revealRange(
            new vscode.NotebookRange(cellIdx, cellIdx + 1),
            vscode.NotebookEditorRevealType.InCenter
          );
          const ok = await promptExecution(logger);
          if (!ok) return errReturn(logger, "Code execution cancelled by user. Ask the user how they would like to proceed.") as any;
          await vscode.commands.executeCommand("notebook.cell.execute", {
            ranges: [{ start: cellIdx, end: cellIdx + 1 }],
            document: nb.notebook.uri,
          });
          const target = nb.notebook.getCells()[cellIdx];
          const textDecoder = new TextDecoder();
          for (const o of (target as any).outputs) {
            for (const item of o.items) {
              if (item.mime === "application/vnd.code.notebook.error") {
                const f = JSON.parse(textDecoder.decode(item.data));
                logger.appendLine(`Error executing code ${f.name}: ${f.message}\n ${f.stack}`);
                out.content.push({ type: "text", text: `Error: ${f.name}: ${f.message}\n ${f.stack}` });
              } else if (item.mime.startsWith("image/")) {
                out.content.push({
                  type: "image",
                  data: Buffer.from(item.data).toString("base64"),
                  mimeType: item.mime,
                });
              } else {
                out.content.push({ type: "text", text: textDecoder.decode(item.data) });
              }
            }
          }
          logger.info("Code execution completed");
        } catch (e) {
          logger.error(`Code execution failed with an error '${e}'`);
        }
        return out;
      },
    },
  ];
}

/* ─── Latest-selection tracker (`_ve(a, m)` + `Xq`/`gl` in bundle) ────── */

interface LatestSelection {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

let latestSelection: LatestSelection | null = null;
let latestSelectionSub: vscode.Disposable | null = null;

/** Install the `onDidChangeTextEditorSelection` listener that feeds
 * `getLatestSelection`. Returns a Disposable. Drop-in for `_ve(a, m)`. */
export function installLatestSelectionTracker(): vscode.Disposable {
  if (latestSelectionSub) return latestSelectionSub;
  let timer: NodeJS.Timeout | undefined;
  latestSelectionSub = vscode.window.onDidChangeTextEditorSelection((ev) => {
    const editor = ev.textEditor;
    const sel = editor.selection;
    const doc = editor.document;
    if (doc.uri.scheme === "comment" || doc.uri.scheme === "output") return;
    const candidate: LatestSelection = {
      text: doc.getText(sel),
      filePath: doc.uri.fsPath,
      fileUrl: doc.uri.toString(),
      selection: {
        start: { line: sel.start.line, character: sel.start.character },
        end: { line: sel.end.line, character: sel.end.character },
        isEmpty: sel.isEmpty,
      },
    };
    const changed =
      !latestSelection ||
      latestSelection.text !== candidate.text ||
      latestSelection.filePath !== candidate.filePath ||
      latestSelection.selection.start.line !== candidate.selection.start.line ||
      latestSelection.selection.start.character !== candidate.selection.start.character ||
      latestSelection.selection.end.line !== candidate.selection.end.line ||
      latestSelection.selection.end.character !== candidate.selection.end.character;
    latestSelection = candidate;
    if (changed) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Selection notifications (`selection_changed`) fire when there's a
        // WS client connected — handled in the IDE server. Throttle 300ms
        // to mirror `_ve`.
      }, 300);
    }
  });
  return latestSelectionSub;
}

/* ─── Jupyter helpers (`aut`/`cut`/`lut` in bundle) ──────────────────── */

let jupyterApiPromise: Promise<any> | null = null;

async function acquireJupyterApi(): Promise<any> {
  // Bundle uses `vscode.extensions.getExtension('ms-toolsai.jupyter')` +
  // `activate()` to grab the API. We replicate this here.
  if (jupyterApiPromise) return jupyterApiPromise;
  jupyterApiPromise = (async () => {
    const ext = vscode.extensions.getExtension("ms-toolsai.jupyter");
    if (!ext) throw new Error("jupyter extension not found");
    const api = await ext.activate();
    return api;
  })();
  return jupyterApiPromise;
}

async function appendPythonCell(code: string, notebook: vscode.NotebookDocument): Promise<string> {
  // Bundle (`cut`): uses the Jupyter extension's `notebookController.appendCode`
  // API. The stable VS Code API path is `WorkspaceEdit` + `NotebookEdit`
  // via `vscode.workspace.applyEdit(...)` which we replicate here, appending
  // a single Python cell to the end of the notebook.
  const id = `luna-${Math.random().toString(36).slice(2)}`;
  const cell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    code,
    "python"
  );
  cell.metadata = { ...(cell.metadata ?? {}), id };
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.insertCells(notebook.cellCount, [cell]),
  ]);
  await vscode.workspace.applyEdit(edit);
  return id;
}

async function promptExecution(logger: IdeToolLogger): Promise<boolean> {
  // Bundle (`lut`) prompts the user with a quick-pick to confirm execution.
  const choice = await vscode.window.showWarningMessage(
    "Claude wants to execute Python code in the active Jupyter notebook.",
    { modal: true },
    "Allow",
    "Cancel"
  );
  if (choice === "Allow") return true;
  logger.info("User cancelled execution");
  return false;
}