/**
 * Minimal VS Code API mock for vitest unit tests.
 * Extends automatically — add missing members as tests require them.
 */

export const env = {
  appName: "Visual Studio Code",
  language: "en",
  machineId: "test-machine",
  sessionId: "test-session",
  shell: "powershell",
  uriScheme: "vscode",
};

export namespace Uri {
  export function file(fsPath: string): { fsPath: string; scheme: string; toString: () => string } {
    return {
      fsPath,
      scheme: "file",
      toString(this: any) {
        return this.scheme === "file" ? `file://${this.fsPath.replace(/\\/g, "/")}` : `${this.scheme}://${this.fsPath}`;
      },
    };
  }
  export function parse(s: string): { fsPath: string; scheme: string; toString: () => string } {
    const [scheme, rest] = s.includes("://") ? [s.split("://")[0], s.split("://")[1]] : ["file", s];
    return { fsPath: rest ?? s, scheme, toString: () => s };
  }
}

export const workspace = {
  workspaceFolders: undefined as Array<{ name: string; uri: { fsPath: string; toString: () => string }; index: number }> | undefined,
  workspaceFile: undefined as unknown,
  rootPath: undefined as string | undefined,
  textDocuments: [] as Array<{ uri: { toString: () => string }; fileName: string; languageId: string; lineCount: number; isDirty: boolean; isUntitled: boolean; isClosed: boolean }>,
  openTextDocument: async () => ({}),
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  onWillSaveTextDocument: () => ({ dispose: () => {} }),
  getConfiguration: () => ({ get: () => undefined }),
  fs: {
    stat: async () => ({}),
  },
  applyEdit: async () => true,
};

export namespace languages {
  export function getDiagnostics(_uri?: any): Array<[any, Array<any>]> {
    return [];
  }
  export function onDidChangeDiagnostics(): any {
    return { dispose: () => {} };
  }
}

export type DiagnosticSeverity = number;
export namespace DiagnosticSeverity {
  export const Error = 0;
  export const Warning = 1;
  export const Information = 2;
  export const Hint = 3;
}

export enum NotebookCellKind {
  Code = 2,
  Markdown = 1,
}

export namespace NotebookEdit {
  export function insertCells(_index: number, _cells: any[]): any {
    return {};
  }
}

export namespace NotebookEditorRevealType {
  export const InCenter = 0;
  export const InCenterIfOutsideViewport = 1;
  export const AtTop = 2;
}

export namespace TextEditorRevealType {
  export const Default = 0;
  export const InCenter = 1;
  export const InCenterIfOutsideViewport = 2;
  export const AtTop = 3;
}

export class Disposable {
  constructor(public dispose: () => void) {}
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class Selection {
  public start: Position;
  public end: Position;
  public isEmpty: boolean;
  public isReversed: boolean;
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
    this.isEmpty = startLine === endLine && startChar === endChar;
    this.isReversed = false;
  }
}

export class WorkspaceEdit {
  set(_uri: any, _edits: any[]): void {}
}

export class NotebookCellData {
  kind: NotebookCellKind;
  value: string;
  languageId: string;
  metadata?: Record<string, unknown>;
  constructor(kind: NotebookCellKind, value: string, languageId: string) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

export class NotebookRange {
  constructor(public start: number, public end: number) {}
}

export const window = {
  activeTerminal: null as any,
  activeTextEditor: null as any,
  visibleTextEditors: [] as Array<any>,
  showWarningMessage: async (_msg: string, _opts?: any, ..._items: string[]) => undefined as string | undefined,
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined as string | undefined,
  createOutputChannel: (_name: string) => ({
    appendLine: () => {},
    append: () => {},
    dispose: () => {},
  }),
  tabGroups: {
    all: [] as Array<{ tabs: Array<any>; viewColumn: number | undefined; isActive: boolean }>,
    close: async () => true,
    onDidChangeTabs: () => ({ dispose: () => {} }),
  },
  showTextDocument: async (_doc: any, _opts?: any) => ({}),
  onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
  activeNotebookEditor: null as any,
};

export namespace commands {
  export function executeCommand(_cmd: string, ..._args: any[]): Promise<any> {
    return Promise.resolve();
  }
}

export namespace extensions {
  export function getExtension(_id: string): any {
    return null;
  }
}

// Tab classes
export class TabInputText {
  constructor(public uri: any) {}
}

export class TabInputTextDiff {
  constructor(public original: any, public modified: any) {}
}

// Export everything under a default namespace for `import * as vscode`
const vscode = {
  env,
  Uri,
  workspace,
  languages,
  DiagnosticSeverity,
  NotebookCellKind,
  NotebookEdit,
  NotebookEditorRevealType,
  TextEditorRevealType,
  Disposable,
  Position,
  Range,
  Selection,
  WorkspaceEdit,
  NotebookCellData,
  NotebookRange,
  window,
  commands,
  extensions,
  TabInputText,
  TabInputTextDiff,
};

export default vscode;
