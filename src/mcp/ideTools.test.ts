import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock vscode before importing the module under test
vi.mock("vscode", () => import("../test/vscode.mock"));

import vscode from "vscode";

// Server name function checks vscode.env.appName — set default
vi.mocked(vscode.env).appName = "Visual Studio Code" as any;

// Dynamic import after mocks are in place
const { ideToolBindings, serverNameFor, installLatestSelectionTracker } =
  await vi.importActual<typeof import("./ideTools")>("./ideTools");
import type { IdeToolDeps } from "./ideTools";

const stubDeps: IdeToolDeps = {
  version: "0.1.0-test",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), appendLine: vi.fn() },
};

describe("serverNameFor()", () => {
  afterEach(() => {
    vi.mocked(vscode.env).appName = "Visual Studio Code" as any;
  });

  it('returns "Claude Code VSCode MCP" for "Visual Studio Code"', () => {
    vi.mocked(vscode.env).appName = "Visual Studio Code" as any;
    expect(serverNameFor()).toBe("Claude Code VSCode MCP");
  });

  it('returns "Claude Code Cursor MCP" for "Cursor"', () => {
    vi.mocked(vscode.env).appName = "Cursor" as any;
    expect(serverNameFor()).toBe("Claude Code Cursor MCP");
  });

  it('returns "Claude Code Windsurf MCP" for "Windsurf"', () => {
    vi.mocked(vscode.env).appName = "Windsurf" as any;
    expect(serverNameFor()).toBe("Claude Code Windsurf MCP");
  });

  it("falls back to appName-based name for unknown editors", () => {
    vi.mocked(vscode.env).appName = "Neovim" as any;
    expect(serverNameFor()).toContain("Neovim");
  });
});

describe("ideToolBindings", () => {
  beforeEach(() => {
    vi.mocked(vscode.env).appName = "Visual Studio Code" as any;
  });

  it("returns exactly 12 tools", () => {
    const tools = ideToolBindings(stubDeps);
    expect(tools).toHaveLength(12);
  });

  it("has all expected tool names", () => {
    const tools = ideToolBindings(stubDeps);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "openDiff",
      "getDiagnostics",
      "close_tab",
      "closeAllDiffTabs",
      "openFile",
      "getOpenEditors",
      "getWorkspaceFolders",
      "getCurrentSelection",
      "checkDocumentDirty",
      "saveDocument",
      "getLatestSelection",
      "executeCode",
    ]);
  });

  it("each tool has a handler and inputSchema", () => {
    const tools = ideToolBindings(stubDeps);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(typeof t.handler).toBe("function");
      expect(t.inputSchema).toBeDefined();
    }
  });

  describe("individual tool input schemas", () => {
    it("openDiff accepts old_file_path, new_file_path, new_file_contents, tab_name", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "openDiff")!;
      expect(tool.inputSchema).toHaveProperty("old_file_path");
      expect(tool.inputSchema).toHaveProperty("new_file_path");
      expect(tool.inputSchema).toHaveProperty("new_file_contents");
      expect(tool.inputSchema).toHaveProperty("tab_name");
    });

    it("getDiagnostics accepts optional uri", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "getDiagnostics")!;
      expect(tool.inputSchema).toHaveProperty("uri");
    });

    it("close_tab requires tab_name", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "close_tab")!;
      expect(tool.inputSchema).toHaveProperty("tab_name");
    });

    it("closeAllDiffTabs has empty schema", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "closeAllDiffTabs")!;
      expect(Object.keys(tool.inputSchema)).toHaveLength(0);
    });

    it("openFile accepts filePath and selection params", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "openFile")!;
      expect(tool.inputSchema).toHaveProperty("filePath");
      expect(tool.inputSchema).toHaveProperty("preview");
      expect(tool.inputSchema).toHaveProperty("startText");
      expect(tool.inputSchema).toHaveProperty("endText");
      expect(tool.inputSchema).toHaveProperty("selectToEndOfLine");
      expect(tool.inputSchema).toHaveProperty("makeFrontmost");
    });

    it("getOpenEditors has empty schema", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "getOpenEditors")!;
      expect(Object.keys(tool.inputSchema)).toHaveLength(0);
    });

    it("getWorkspaceFolders has empty schema", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "getWorkspaceFolders")!;
      expect(Object.keys(tool.inputSchema)).toHaveLength(0);
    });

    it("getCurrentSelection has empty schema", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "getCurrentSelection")!;
      expect(Object.keys(tool.inputSchema)).toHaveLength(0);
    });

    it("checkDocumentDirty requires filePath", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "checkDocumentDirty")!;
      expect(tool.inputSchema).toHaveProperty("filePath");
    });

    it("saveDocument requires filePath", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "saveDocument")!;
      expect(tool.inputSchema).toHaveProperty("filePath");
    });

    it("getLatestSelection has empty schema", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "getLatestSelection")!;
      expect(Object.keys(tool.inputSchema)).toHaveLength(0);
    });

    it("executeCode accepts code string", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "executeCode")!;
      expect(tool.inputSchema).toHaveProperty("code");
    });
  });

  describe("tool annotations and meta", () => {
    it("openFile has readOnlyHint annotation", () => {
      const tools = ideToolBindings(stubDeps);
      const tool = tools.find((t) => t.name === "openFile")!;
      expect(tool.annotations).toEqual({ readOnlyHint: true });
    });

    it("other tools have no annotations", () => {
      const tools = ideToolBindings(stubDeps);
      const others = tools.filter((t) => t.name !== "openFile");
      for (const t of others) {
        expect(t.annotations).toBeUndefined();
      }
    });
  });
});

describe("installLatestSelectionTracker", () => {
  it("returns a Disposable", () => {
    const d = installLatestSelectionTracker();
    expect(d).toBeDefined();
    expect(typeof d.dispose).toBe("function");
  });

  it("can be called multiple times (returns same disposable)", () => {
    const d1 = installLatestSelectionTracker();
    const d2 = installLatestSelectionTracker();
    expect(d1).toBe(d2);
  });
});