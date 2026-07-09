import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpHostBridge, type ControlRequestMsg } from "./bridge";
import { InMemoryTransport, SUPPRESS_CONTROL_RESPONSE } from "./transport";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { CanUseToolCallback } from "./bridge";

/** Minimal fake child process. */
function fakeChild(): ChildProcessWithoutNullStreams {
  return {
    stdin: { write: vi.fn() as any } as any,
    stdout: { on: vi.fn(), setEncoding: vi.fn() } as any,
    stderr: { on: vi.fn(), setEncoding: vi.fn() } as any,
    killed: false,
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    connected: true,
    ref: vi.fn(),
    unref: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    emit: vi.fn(),
    eventNames: vi.fn(),
    listenerCount: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    [Symbol.toStringTag]: "ChildProcess",
  } as any;
}

describe("McpHostBridge", () => {
  let child: ChildProcessWithoutNullStreams;
  let permissionCb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    child = fakeChild();
    permissionCb = vi.fn();
  });

  describe("connectSdkMcpServer", () => {
    it("registers a server and calls server.connect", async () => {
      const bridge = new McpHostBridge(child, permissionCb as any);
      const fakeServer = {
        connect: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };

      bridge.connectSdkMcpServer("test-server", fakeServer as any);

      expect(fakeServer.connect).toHaveBeenCalledTimes(1);
      const transportArg = fakeServer.connect.mock.calls[0][0];
      expect(transportArg).toBeInstanceOf(InMemoryTransport);
    });
  });

  describe("processControlRequest — can_use_tool", () => {
    it("returns allow when callback allows", async () => {
      permissionCb.mockResolvedValue({ behavior: "allow", updatedInput: {} });
      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);

      const msg: ControlRequestMsg = {
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "read",
          tool_input: { path: "/tmp/x" },
          tool_use_id: "tu-1",
          agent_id: "agent-1",
        },
      };

      const resp = await bridge.processControlRequest(msg);
      expect(resp).toBeDefined();
      expect(resp!.type).toBe("control_response");
      expect(resp!.request_id).toBe("req-1");
      expect(resp!.response).toMatchObject({
        behavior: "allow",
        toolUseID: "tu-1",
      });
    });

    it("returns deny when callback denies", async () => {
      permissionCb.mockResolvedValue({ behavior: "deny", message: "no" });
      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);

      const msg: ControlRequestMsg = {
        type: "control_request",
        request_id: "req-2",
        request: { subtype: "can_use_tool", tool_name: "write" },
      };

      const resp = await bridge.processControlRequest(msg);
      expect(resp!.response).toMatchObject({ behavior: "deny" });
    });

    it("returns undefined (suppress) when callback returns null", async () => {
      permissionCb.mockResolvedValue(null);
      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);

      const msg: ControlRequestMsg = {
        type: "control_request",
        request_id: "req-3",
        request: { subtype: "can_use_tool", tool_name: "exec" },
      };

      const resp = await bridge.processControlRequest(msg);
      expect(resp).toBeUndefined();
    });

    it("aborts when handleControlCancelRequest is called", async () => {
      let resolvePerm: ((v: any) => void) | null = null;
      permissionCb.mockImplementation(
        async (_name: string, _input: Record<string, unknown>, ctx: any) => {
          await new Promise<void>((r) => { resolvePerm = r; });
          if (ctx.signal?.aborted) return null;
          return { behavior: "allow" };
        }
      );

      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);
      const msg: ControlRequestMsg = {
        type: "control_request",
        request_id: "req-4",
        request: { subtype: "can_use_tool", tool_name: "read" },
      };

      const respPromise = bridge.processControlRequest(msg);

      bridge.handleControlCancelRequest("req-4");
      resolvePerm!();

      const resp = await respPromise;
      expect(resp).toBeUndefined();
    });
  });

  describe("processControlRequest — unknown subtype", () => {
    it("returns a benign ack", async () => {
      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);

      const msg: ControlRequestMsg = {
        type: "control_request",
        request_id: "req-10",
        request: { subtype: "elicitation", mode: "quick" },
      };

      const resp = await bridge.processControlRequest(msg);
      expect(resp).toBeDefined();
      expect(resp!.type).toBe("control_response");
      expect(resp!.response).toMatchObject({ ack: "elicitation" });
    });
  });

  describe("write", () => {
    it("writes JSON to child stdin", () => {
      const bridge = new McpHostBridge(child, permissionCb as CanUseToolCallback);
      (child.stdin.write as any).mockClear();
      bridge.write({ hello: "world" });
      expect(child.stdin.write).toHaveBeenCalledWith(
        '{"hello":"world"}\n',
        expect.any(Function)
      );
    });
  });
});