import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const SERVER_NAME = "claude-vscode-extension";
export const SERVER_VERSION = "2.1.204";

export type ToolHandler<T extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<T>>,
  extra: { signal?: AbortSignal }
) => Promise<{ content: { type: "text"; text: string }[] }>;

export interface ToolRegistration<T extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: T;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  handler: ToolHandler<T>;
}

/**
 * Tool registry exposed to the bundled `claude` binary over stdio. Controllers
 * (debugger, jupyter, ...) push tools here at activation time, mirroring the
 * official extension's `extensionMcpServer.{debuggerController,jupyterController}`
 * plug-in model.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration<any>>();

  registerTool<T extends z.ZodRawShape>(tool: ToolRegistration<T>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  list(): ToolRegistration<any>[] {
    return [...this.tools.values()];
  }
}

export interface Controller {
  getState(): { hasActiveSession: boolean };
  onStateChange(cb: (s: { hasActiveSession: boolean }) => void): () => void;
  /** Attach this controller's *dynamically discovered* tools to a live server. */
  registerTool(server: McpServer): void;
}

export interface ExtensionMcpServer extends OmeFactory {}
interface OmeFactory {
  /**
   * Build (or reuse) an SDK server instance. The instance is left UN-connected
   * to a transport; the host bridge owns the transport and calls
   * `server.connect(transport)` itself (mirrors `connectSdkMcpServer`).
   */
  createServerConfig(): ServerConfig;
  debuggerController: Controller;
  jupyterController?: Controller;
  toolRegistry: ToolRegistry;
}

export interface ServerConfig {
  type: "sdk";
  name: string;
  version: string;
  instance: McpServer;
}

/**
 * Replica of the official extension's `Ome(context, output)` factory
 * (`extension.js:2042701`). The only meaningful change vs. the bundle is
 * that the SDK server is connected to an `InMemoryTransport` here so the
 * host can pipe JSON-RPC between Claude and the SDK without an OS pipe.
 */
export function createExtensionMcpServer(): ExtensionMcpServer {
  const toolRegistry = new ToolRegistry();

  const debuggerController: Controller = {
    getState: () => ({ hasActiveSession: false }),
    onStateChange: () => () => {},
    registerTool: (_server) => {},
  };

  const jupyterController: Controller = {
    getState: () => ({ hasActiveSession: false }),
    onStateChange: () => () => {},
    registerTool: (_server) => {},
  };

  let cached: ServerConfig | undefined;

  function createServerConfig(): ServerConfig {
    if (cached) return cached;

    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );

    // TOOL REGISTRATION — exact envelope used by the bundle:
    //   server.registerTool(name, {description, inputSchema, annotations, _meta}, handler)
    for (const tool of toolRegistry.list()) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations as any,
          _meta: tool._meta,
        },
        async (args: any, extra: any) => tool.handler(args, extra)
      );
    }

    // Controllers attach their own (live) tools to the same server instance.
    debuggerController.registerTool(server);
    jupyterController.registerTool(server);

    cached = {
      type: "sdk",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      instance: server,
    };
    return cached;
  }

  return {
    createServerConfig,
    debuggerController,
    jupyterController,
    toolRegistry,
  };
}