import { describe, it, expect, vi } from "vitest";
import {
  InMemoryTransport,
  SUPPRESS_CONTROL_RESPONSE,
  type JsonRpcMessage,
} from "./transport";

describe("SUPPRESS_CONTROL_RESPONSE", () => {
  it("is a symbol", () => {
    expect(typeof SUPPRESS_CONTROL_RESPONSE).toBe("symbol");
    expect(String(SUPPRESS_CONTROL_RESPONSE)).toMatch(/suppressControl/i);
  });
});

describe("InMemoryTransport", () => {
  it("calls the send callback on send()", () => {
    const sendCb = vi.fn();
    const t = new InMemoryTransport(sendCb);

    const msg: JsonRpcMessage = { jsonrpc: "2.0", method: "ping", id: 1 };
    t.send(msg);

    expect(sendCb).toHaveBeenCalledTimes(1);
    expect(sendCb).toHaveBeenCalledWith(msg);
  });

  it("routes messages via sendMcpMessage (outbound), not onmessage", () => {
    const sendCb = vi.fn();
    const t = new InMemoryTransport(sendCb);

    const handler = vi.fn();
    t.onmessage = handler;

    // send() goes to sendMcpMessage, NOT onmessage
    const msg: JsonRpcMessage = { jsonrpc: "2.0", result: "ok", id: 1 };
    t.send(msg);

    // send callback was invoked
    expect(sendCb).toHaveBeenCalledWith(msg);
    // onmessage was NOT — it's for inbound messages from the bridge
    expect(handler).not.toHaveBeenCalled();
  });

  it("start() resolves immediately without error", async () => {
    const t = new InMemoryTransport(() => {});
    await expect(t.start()).resolves.toBeUndefined();
  });

  it("start() can be called multiple times (in-memory, no error)", async () => {
    const t = new InMemoryTransport(() => {});
    await t.start();
    // InMemoryTransport.start() is a no-op, so calling twice is fine
    await expect(t.start()).resolves.toBeUndefined();
  });

  it("close() sets isClosed flag", async () => {
    const t = new InMemoryTransport(() => {});
    expect(t.isClosed).toBe(false);
    await t.close();
    expect(t.isClosed).toBe(true);
  });

  it("close() calls onclose", async () => {
    const t = new InMemoryTransport(() => {});
    const closeFn = vi.fn();
    t.onclose = closeFn;
    await t.close();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("close() twice does not call onclose twice", async () => {
    const t = new InMemoryTransport(() => {});
    const closeFn = vi.fn();
    t.onclose = closeFn;
    await t.close();
    await t.close();
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("send() throws after close()", async () => {
    const t = new InMemoryTransport(() => {});
    await t.close();
    await expect(t.send({ jsonrpc: "2.0", method: "test", id: 1 })).rejects.toThrow(
      /transport is closed/i
    );
  });

  it("delivers inbound message onmessage when bridge calls it directly", () => {
    const t = new InMemoryTransport(() => {});
    const handler = vi.fn();
    t.onmessage = handler;

    // The bridge calls transport.onmessage(msg) directly for inbound messages
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method: "tools/list", id: 5 };
    t.onmessage!(msg);

    expect(handler).toHaveBeenCalledWith(msg);
  });
});