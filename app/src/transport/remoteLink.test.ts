import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Exercise the installed, patched SDK itself, including its internal dial implementation.
import { RemoteLink } from "../../node_modules/@eclipse-zenoh/zenoh-ts/dist/link.js";
import { Config, Session } from "@eclipse-zenoh/zenoh-ts";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  send = vi.fn();
  constructor(readonly url: string) { super(); FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); this.onopen?.(); }
  error() { this.dispatchEvent(new Event("error")); this.onerror?.(); }
  receive(data: ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
    this.onmessage?.({ data });
  }
  remoteClose(code = 1006, reason = "", wasClean = false) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean }));
    this.onclose?.();
  }
  close = vi.fn(() => {
    this.remoteClose(1000, "", true);
  });
}
type Diagnostic = (event: string, detail: Record<string, unknown>) => void;
const dial = RemoteLink.new.bind(RemoteLink) as (locator: string, timeoutMs?: number, signal?: AbortSignal, onDiagnostic?: Diagnostic) => Promise<RemoteLink>;
beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; vi.stubGlobal("WebSocket", FakeSocket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded SDK WebSocket dial", () => {
  it.each(["wss/localhost:11000/zenoh", "wss://localhost:11000/zenoh"])("preserves proxy paths and URL syntax: %s", async locator => {
    const pending = dial(locator);
    expect(FakeSocket.all[0].url).toBe("wss://localhost:11000/zenoh");
    FakeSocket.all[0].open();
    await (await pending).close();
  });
  it("makes only one attempt and closes a socket that never opens", async () => {
    const pending = dial("ws/127.0.0.1:10000", 100).catch(e => e);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeInstanceOf(Error);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
  it("immediately releases refused or browser-blocked sockets", async () => {
    const pending = dial("ws/localhost:10000").catch(e => e);
    FakeSocket.all[0].onerror?.();
    expect(await pending).toBeInstanceOf(Error);
    expect(FakeSocket.all[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels pending dials and can close a just-opened session on cancellation", async () => {
    const controller = new AbortController();
    const pending = dial("ws/localhost:10000", 100, controller.signal).catch(e => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(FakeSocket.all[0].readyState).toBe(3);
    const next = new AbortController();
    const connected = dial("ws/localhost:10000", 100, next.signal);
    FakeSocket.all[1].open();
    await connected;
    next.abort();
    expect(FakeSocket.all[1].readyState).toBe(3);
  });
  it("refuses sends on a closed socket instead of silently losing commands", async () => {
    const pending = dial("ws/localhost:10000");
    FakeSocket.all[0].open();
    const link = await pending;
    await link.close();
    await expect(link.send(new Uint8Array([1]))).rejects.toThrow("closed");
    expect(FakeSocket.all[0].send).not.toHaveBeenCalled();
  });
  it("closes a WebSocket when the remote-API protocol handshake times out", async () => {
    const config = Object.assign(new Config("ws/localhost:10000", 20), { openTimeoutMs: 100 });
    const pending = Session.open(config).catch(e => e);
    FakeSocket.all[0].open();
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toBeInstanceOf(Error);
    expect(FakeSocket.all[0].close).toHaveBeenCalledOnce();
  });
  it("clears the acknowledgement timer if the socket closes before the handshake send", async () => {
    const config = Object.assign(new Config("ws/localhost:10000", 20), { openTimeoutMs: 100 });
    const pending = Session.open(config).catch(e => e);
    FakeSocket.all[0].open();
    FakeSocket.all[0].close();
    expect(await pending).toMatchObject({ message: "WebSocket is closed" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
  });
});

describe("passive SDK WebSocket diagnostics", () => {
  it("counts binary wire metadata without replacing SDK callbacks, then cleans up on peer close", async () => {
    const diagnostic = vi.fn<Diagnostic>();
    const pending = dial("ws/localhost:10000", 100, undefined, diagnostic);
    const socket = FakeSocket.all[0];
    socket.open();
    const link = await pending;
    const onMessage = vi.fn();
    link.onmessage(onMessage);
    const frame = new Uint8Array([7, 8, 9, 10]);
    socket.receive(frame.buffer);
    socket.receive(new Uint8Array([11, 12, 13]).buffer);
    await link.send(new Uint8Array([1, 2]));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, frame);
    socket.bufferedAmount = 17;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(diagnostic.mock.calls.map(([event]) => event)).toEqual(["ws-open"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostic).toHaveBeenLastCalledWith("ws-snapshot", {
      rxBytes: 7, rxMessages: 2, txBytes: 2, txMessages: 1, lastReceivedAgeMs: 5_000,
      bufferedAmount: 17, readyState: 1, appInitiated: false,
    });
    socket.error();
    socket.remoteClose(1011, "upstream failure", false);
    expect(diagnostic.mock.calls.map(([event]) => event)).toEqual(["ws-open", "ws-snapshot", "ws-error", "ws-snapshot", "ws-close"]);
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ code: 1011, reason: "upstream failure", wasClean: false, appInitiated: false }));
    expect(vi.getTimerCount()).toBe(0);
    const calls = diagnostic.mock.calls.length;
    socket.receive(frame.buffer); socket.error(); socket.remoteClose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(diagnostic).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("payload");
  });

  it.each(["sdk-close", "abort"])("identifies %s before the browser reports its close code", async cause => {
    const diagnostic = vi.fn<Diagnostic>();
    const controller = new AbortController();
    const pending = dial("ws/localhost:10000", 100, controller.signal, diagnostic);
    FakeSocket.all[0].open();
    const link = await pending;
    if (cause === "abort") controller.abort(); else await link.close();
    expect(diagnostic.mock.calls.map(([event]) => event)).toEqual(["ws-open", "ws-close-request", "ws-snapshot", "ws-close"]);
    expect(diagnostic).toHaveBeenCalledWith("ws-close-request", expect.objectContaining({ cause, appInitiated: true }));
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ code: 1000, reason: "", wasClean: true, appInitiated: true }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["dial-timeout", "abort", "dial-error"])("reports a failed dial's %s cleanup", async cause => {
    const diagnostic = vi.fn<Diagnostic>();
    const controller = new AbortController();
    const pending = dial("ws/localhost:10000", 100, controller.signal, diagnostic).catch(error => error);
    if (cause === "abort") controller.abort();
    else if (cause === "dial-error") FakeSocket.all[0].error();
    else await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeInstanceOf(Error);
    expect(diagnostic).toHaveBeenCalledWith("ws-close-request", expect.objectContaining({ cause, appInitiated: true }));
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ appInitiated: true }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an unsolicited close during dial as peer initiated", async () => {
    const diagnostic = vi.fn<Diagnostic>();
    const pending = dial("ws/localhost:10000", 100, undefined, diagnostic).catch(error => error);
    FakeSocket.all[0].remoteClose(1006, "", false);
    expect(await pending).toBeInstanceOf(Error);
    expect(diagnostic.mock.calls.map(([event]) => event)).toEqual(["ws-snapshot", "ws-close"]);
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ code: 1006, appInitiated: false }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps observing the eventual close code without a timer when browser close is delayed", async () => {
    const diagnostic = vi.fn<Diagnostic>();
    const pending = dial("ws/localhost:10000", 100, undefined, diagnostic);
    const socket = FakeSocket.all[0]; socket.open();
    const link = await pending;
    socket.close.mockImplementation(() => { socket.readyState = FakeSocket.CLOSING; });
    const closing = link.close();
    await vi.advanceTimersByTimeAsync(251);
    await closing;
    expect(vi.getTimerCount()).toBe(0);
    socket.remoteClose(1001, "going away", true);
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ code: 1001, reason: "going away", wasClean: true, appInitiated: true }));
  });

  it("isolates observer exceptions from dial, messages, sends and cleanup", async () => {
    const diagnostic = vi.fn<Diagnostic>(() => { throw new Error("diagnostic sink failed"); });
    const pending = dial("ws/localhost:10000", 100, undefined, diagnostic);
    FakeSocket.all[0].open();
    const link = await pending;
    const onMessage = vi.fn(); link.onmessage(onMessage);
    FakeSocket.all[0].receive(new Uint8Array([1]).buffer);
    await link.send(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(5_000);
    FakeSocket.all[0].error();
    await link.close();
    expect(onMessage).toHaveBeenCalledWith(new Uint8Array([1]));
    expect(FakeSocket.all[0].send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("threads diagnostics through Session.open and records handshake failure cleanup", async () => {
    const diagnostic = vi.fn<Diagnostic>();
    const config = Object.assign(new Config("ws/localhost:10000", 20), { openTimeoutMs: 100, onDiagnostic: diagnostic });
    const pending = Session.open(config).catch(error => error);
    FakeSocket.all[0].open();
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toBeInstanceOf(Error);
    expect(diagnostic).toHaveBeenCalledWith("ws-close-request", expect.objectContaining({ cause: "sdk-close", appInitiated: true, txMessages: 1 }));
    expect(diagnostic).toHaveBeenLastCalledWith("ws-close", expect.objectContaining({ appInitiated: true }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
