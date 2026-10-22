// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTransport } from "./useTransport";
import { connectionDiagnostics } from "./connectionDiagnostics";

const sockets = vi.hoisted(() => [] as { locator: string; report: (event: string, detail: Record<string, unknown>) => void }[]);
vi.mock("./zenohRemoteApi", () => ({ ZenohRemoteApiTransport: { open: vi.fn(async (locator, _signal, _timeout, report) => {
  sockets.push({ locator, report });
  if (locator.includes("127.0.0.1")) {
    report("ws-error", { readyState: 3 });
    throw new Error("WebSocket connection failed or browser access denied");
  }
  report("ws-open", { readyState: 1 });
  return { bridgeId: async () => "abc", checkConnection: async () => {},
    subscribe: async () => ({ close: async () => {} }),
    liveliness: { subscribe: async () => ({ close: async () => {} }), get: async () => [] },
    get: async () => [], close: async () => { report("ws-close", { appInitiated: true, code: 1000, wasClean: true }); } };
}) } }));

afterEach(() => { cleanup(); connectionDiagnostics().clear(); sockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps the failed loopback endpoint distinct from the selected vehicle in the exported trace", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {});
  const view = renderHook(() => useTransport("ws/10.1.2.3:10000", "ws/127.0.0.1:10000"));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(view.result.current.status).toBe("connected");
  expect(view.result.current.activeLocator).toBe("ws/10.1.2.3:10000");
  const trace = window.dashboardConnectionDiagnostics!.snapshot();
  expect(trace.events.find(e => e.event === "ws-error")?.detail).toMatchObject({ endpoint: "ws/127.0.0.1:10000", route: "local" });
  expect(trace.events.find(e => e.event === "ws-open")?.detail).toMatchObject({ endpoint: "ws/10.1.2.3:10000", route: "vehicle" });
  expect(trace.events.some(e => e.event === "page-connection-start")).toBe(true);
  expect(new Set(sockets.map(s => s.locator)).size).toBe(2);
  await act(async () => view.unmount());
  expect(vi.getTimerCount()).toBe(0);
  expect(window.dashboardConnectionDiagnostics!.snapshot().events.filter(e => e.event === "ws-close")[0].detail)
    .toMatchObject({ endpoint: "ws/10.1.2.3:10000", appInitiated: true });
});
