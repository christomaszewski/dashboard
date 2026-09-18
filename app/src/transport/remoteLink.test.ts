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
  open() { this.readyState = 1; this.onopen?.(); }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
    this.dispatchEvent(new Event("close"));
  });
}
const dial = RemoteLink.new.bind(RemoteLink) as (locator: string, timeoutMs?: number, signal?: AbortSignal) => Promise<RemoteLink>;
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
