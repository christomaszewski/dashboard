import { describe, expect, it } from "vitest";
import { ConnectionDiagnostics } from "./connectionDiagnostics";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("connection diagnostic trace", () => {
  it("retains vehicle and localhost failures independently, including app-vs-peer closure", () => {
    const trace = new ConnectionDiagnostics({ now: () => 10_000 });
    trace.record("connection-drop", { endpoint: "ws/vehicle:10000", reason: "link probe: no answer within 4000 ms" });
    trace.record("ws-close", { endpoint: "ws/vehicle:10000", socketId: "one", appInitiated: true, code: 1000 });
    trace.record("bridge-dial-failure", { endpoint: "ws/127.0.0.1:10000", route: "local", error: "refused" });
    trace.record("ws-close", { endpoint: "ws/vehicle:10000", socketId: "two", appInitiated: false, code: 1006, wasClean: false });
    expect(trace.snapshot().events.map(e => e.event)).toEqual(["connection-drop", "ws-close", "bridge-dial-failure", "ws-close"]);
    expect(trace.snapshot().events[0].detail.reason).toContain("link probe");
    expect(trace.snapshot().events[3].detail).toMatchObject({ code: 1006, appInitiated: false });
  });

  it("bounds retained history and removes payloads while preserving counters", () => {
    const trace = new ConnectionDiagnostics();
    for (let i = 0; i < 500; i++) trace.record("ws-snapshot", { rxBytes: i, payload: "private", nested: { request: "private" } });
    const snapshot = trace.snapshot();
    expect(snapshot.events).toHaveLength(240);
    expect(snapshot.events[0].detail.rxBytes).toBe(260);
    expect(JSON.stringify(snapshot)).not.toContain("private");
    snapshot.events.length = 0;
    expect(trace.snapshot().events).toHaveLength(240);
  });

  it("persists failure evidence across a reload even if later loopback attempts fail", async () => {
    const saved = storage();
    const trace = new ConnectionDiagnostics({ storage: saved });
    trace.record("ws-snapshot", { rxBytes: 128_000, lastReceivedAgeMs: 10 });
    trace.record("connection-drop", { reason: "probe timed out", endpoint: "ws/vehicle:10000" });
    await Promise.resolve();
    const reloaded = new ConnectionDiagnostics({ storage: saved });
    reloaded.record("bridge-dial-failure", { endpoint: "ws/127.0.0.1:10000" });
    expect(reloaded.snapshot().events.map(e => e.event)).toEqual(["ws-snapshot", "connection-drop", "bridge-dial-failure"]);
    reloaded.clear();
    expect(new ConnectionDiagnostics({ storage: saved }).snapshot().events).toEqual([]);
  });

  it("ignores broken storage and log sinks, and never retains oversized diagnostics", () => {
    const trace = new ConnectionDiagnostics({ storage: { getItem() { throw Error("denied"); },
      setItem() { throw Error("quota"); }, removeItem() { throw Error("denied"); } }, write() { throw Error("console unavailable"); } });
    expect(() => trace.record("connection-drop", { reason: "x".repeat(10000) })).not.toThrow();
    expect((trace.snapshot().events[0].detail.reason as string).length).toBe(500);
    trace.clear();
    const saved = storage(), bounded = new ConnectionDiagnostics({ storage: saved });
    for (let i = 0; i < 240; i++) bounded.record("metadata", Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`field${j}`, "x".repeat(500)])));
    bounded.persist();
    expect([...saved.values.values()][0].length).toBeLessThanOrEqual(256 * 1024);
  });

  it("preserves the originating build for retained failures after upgrading and reloading", async () => {
    const saved = storage();
    const oldBuild = { revision: "old", sourceHash: "aaa", builtAt: "yesterday", dirty: false };
    const newBuild = { revision: "new", sourceHash: "bbb", builtAt: "today", dirty: true };
    const oldTrace = new ConnectionDiagnostics({ storage: saved, build: oldBuild });
    oldTrace.record("page-connection-start");
    for (let i = 0; i < 250; i++) oldTrace.record("ws-snapshot");
    oldTrace.record("connection-drop", { reason: "old failure" });
    await Promise.resolve();
    const newTrace = new ConnectionDiagnostics({ storage: saved, build: newBuild });
    newTrace.record("page-connection-start");
    const report = newTrace.snapshot();
    expect(report.build).toEqual(newBuild);
    expect(report.events.find(e => e.event === "connection-drop")?.build).toEqual(oldBuild);
    expect(report.events.at(-1)?.build).toEqual(newBuild);
  });

  it("bounds a single oversized Unicode event and coalesces a burst of failure writes", async () => {
    const saved = storage();
    let writes = 0;
    const trace = new ConnectionDiagnostics({ storage: { ...saved, setItem: (key, value) => { writes++; saved.setItem(key, value); } } });
    const huge = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`,
      Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`nested${j}`, "界".repeat(500)]))]));
    trace.record("connection-drop", huge);
    for (let i = 0; i < 100; i++) trace.record("declaration-failure", { reason: "timed out" });
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(trace.snapshot().events[0].detail.truncated).toBe(true);
    expect(new TextEncoder().encode([...saved.values.values()][0]).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(new ConnectionDiagnostics({ storage: saved }).snapshot().events).toHaveLength(101);
  });

  it("keeps escaped metadata within the per-event byte limit", () => {
    const trace = new ConnectionDiagnostics();
    const escaped = Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
      [String(i).padStart(2, "0") + "\0".repeat(38), "\0".repeat(500)]));
    trace.record("connection-drop", escaped);
    const event = trace.snapshot().events[0];
    expect(event.detail.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeLessThanOrEqual(8 * 1024);
  });
});
