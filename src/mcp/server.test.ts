import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExtensionMcpServer, SERVER_NAME, SERVER_VERSION } from "./server";

describe("createExtensionMcpServer", () => {
  it("returns expected metadata", () => {
    const factory = createExtensionMcpServer();
    expect(factory.createServerConfig).toBeInstanceOf(Function);
    expect(factory.debuggerController).toBeDefined();
    expect(factory.jupyterController).toBeDefined();
    expect(factory.toolRegistry).toBeDefined();
  });

  it("returns a ServerConfig with expected name and version", () => {
    const factory = createExtensionMcpServer();
    const config = factory.createServerConfig();

    expect(config).toBeDefined();
    expect(config.name).toBe(SERVER_NAME);
    expect(config.version).toBe(SERVER_VERSION);
    expect(config.instance).toBeInstanceOf(McpServer);
  });

  it("createServerConfig caches and returns the same instance (matches bundle)", () => {
    const factory = createExtensionMcpServer();
    const a = factory.createServerConfig();
    const b = factory.createServerConfig();
    expect(a.instance).toBe(b.instance);
  });

  it("toolRegistry starts empty (zero tools by default)", () => {
    const factory = createExtensionMcpServer();
    expect(factory.toolRegistry.list()).toHaveLength(0);
  });

  it("debuggerController returns hasActiveSession:false", () => {
    const factory = createExtensionMcpServer();
    expect(factory.debuggerController.getState()).toEqual({ hasActiveSession: false });
  });

  it("jupyterController returns hasActiveSession:false", () => {
    const f = createExtensionMcpServer();
    const jc = f.jupyterController!;
    expect(jc.getState()).toEqual({ hasActiveSession: false });
  });
});