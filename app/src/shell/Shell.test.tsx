// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportCtx } from "../transport/TransportContext";
import type { Transport } from "../transport/types";
import { RigProvider, useRigContext } from "../rig/RigContext";
import { CURRENT_RUN_STALE_MS } from "../rig/CurrentRunIndicators";
import type { TransportStatus } from "../transport/useTransport";
import type { RigCurrentRun } from "../rig/types";
import { VehicleStateProvider, useVehicleState, useViaVehicle, TopicSourceCtx } from "../vstate/VehicleStateContext";
import { VehicleStateServer } from "../vstate/server";
import { FakeStore, LoopbackTransport } from "../vstate/testkit";
import type { CurrentRunSource } from "../vstate/currentRun";
import { useVehicleItem } from "../vstate/useVehicleItem";
import { RosGraphProvider } from "../ros/RosGraphContext";
import { Shell } from "./Shell";

vi.mock("../home/HomeTab", () => ({ HomeTab: () => <p>home</p> }));

describe("the tab shell", () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let transport: Transport;
  beforeEach(() => {
    vi.useFakeTimers();
    window.location.hash = "#/home";
    subscribe = vi.fn(async () => ({ close: async () => undefined }));
    transport = {
      subscribe: async () => ({ close: async () => undefined }),
      get: async () => [],
      liveliness: { subscribe, get: async () => [] },
      close: async () => undefined,
    } as unknown as Transport;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a hidden tab from holding the whole ROS graph open", async () => {
    render(
      <TransportCtx.Provider value={{ transport, status: "connected", error: "", locator: "ws://test" }}>
        <RosGraphProvider><Shell tabs={{ ros: true }} /></RosGraphProvider>
      </TransportCtx.Provider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(subscribe).not.toHaveBeenCalled(); // the ROS tab is mounted, but hidden behind Home
    await act(async () => {
      window.location.hash = "#/ros";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(subscribe).toHaveBeenCalledWith("@ros2_lv/**", expect.any(Function));
  });
});

const BASE = "fleet/local-vehicle/dash/main/state";
const run = (id = "20261105T140000Z_mapping-flight"): RigCurrentRun => ({
  schema_version: 1, vehicle_id: "local-vehicle", epoch: "registry-boot", revision: 1, at_unix_s: 1,
  ok: true, run_id: id, run_dir: `/data/runs/${id}`, label: "Mapping flight", started: "2026-11-05T14:00:00Z", error: null,
});

class RunSource implements CurrentRunSource {
  doc = run();
  listeners = new Set<() => void>();
  current() { return this.doc; }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  set(next: Partial<RigCurrentRun>) {
    this.doc = { ...this.doc, ...next, revision: this.doc.revision + 1 };
    for (const cb of this.listeners) cb();
  }
}

describe("the independent current-run header", () => {
  let source: RunSource;
  let server: VehicleStateServer;
  let link: LoopbackTransport;
  let subscribe: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    window.location.hash = "#/home";
    source = new RunSource();
    server = new VehicleStateServer({ store: new FakeStore(), currentRun: source });
    link = new LoopbackTransport(server);
    subscribe = vi.spyOn(link.liveliness, "subscribe");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ vehicle_state_key: BASE, current_run_state_key: BASE }) })));
  });
  afterEach(() => { cleanup(); server.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  const tick = async (ms = 300) => {
    await act(async () => {}); // Resolve runtime metadata and mount the client before advancing its debounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  function ScopeProbe({ acquireNode }: { acquireNode: boolean }) {
    const value = useVehicleState();
    const via = useViaVehicle();
    useVehicleItem(acquireNode ? { node: "/gps" } : null);
    return <output data-testid="scope">{JSON.stringify({ enabled: value.enabled, via, main: !!value.client,
      run: !!value.currentRun?.client, shared: !!value.client && value.client === value.currentRun?.client })}</output>;
  }

  function RigProbe() {
    const { agents } = useRigContext();
    return <output data-testid="rig-agents">{agents.map(agent => `${agent.vehicleId}:${agent.state?.run?.id}`).join(",")}</output>;
  }

  function mount(enabled = false, rigEnabled = false) {
    const ui = (status: TransportStatus) => <TransportCtx.Provider value={{ transport: link, status, error: "", locator: "ws://test" }}>
      <VehicleStateProvider enabled={enabled}>
        <RigProvider enabled={rigEnabled}>
          {rigEnabled && <RigProbe />}
          <TopicSourceCtx.Provider value="vehicle"><ScopeProbe acquireNode={enabled} /></TopicSourceCtx.Provider>
          <Shell />
        </RigProvider>
      </VehicleStateProvider>
    </TransportCtx.Provider>;
    const view = render(ui("connected"));
    return { ...view, setStatus: (status: TransportStatus) => view.rerender(ui(status)) };
  }

  it("shows the local run with Rig disabled and keeps other widgets on the direct path", async () => {
    mount(); await tick();
    const header = screen.getByRole("banner");
    const pill = within(header).getByRole("button", { name: `local-vehicle Run: ${run().run_id}` });
    expect(pill.textContent).toContain(run().run_id);
    expect(within(header).queryByText("Rig")).toBeNull();
    fireEvent.focus(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("Mapping flight");
    expect(screen.getByRole("tooltip").textContent).toContain(run().run_dir);
    expect(JSON.parse(screen.getByTestId("scope").textContent!)).toEqual({ enabled: false, via: false, main: false, run: true, shared: false });
    expect(subscribe).not.toHaveBeenCalled();
    expect(link.calls.filter(c => c.op === "view").map(c => c.body)).toEqual([{ v: 1, items: [{ current_run: true }] }]);
  });

  it("shares one optimized view and poll stream with full vehicle state", async () => {
    mount(true); await tick();
    expect(JSON.parse(screen.getByTestId("scope").textContent!)).toEqual({ enabled: true, via: true, main: true, run: true, shared: true });
    const views = link.calls.filter(c => c.op === "view");
    expect(views).toHaveLength(1);
    expect(views[0].body).toEqual({ v: 1, items: [{ current_run: true }, { node: "/gps" }] });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("updates the header when the run opens, changes or closes, and reports registry errors", async () => {
    source.set({ run_id: null, run_dir: null, label: null, started: null });
    mount(); await tick();
    expect(screen.getByRole("button", { name: "local-vehicle Run: no open run" })).toBeTruthy();
    act(() => source.set(run("new-run"))); await tick();
    expect(screen.getByRole("button", { name: "local-vehicle Run: new-run" })).toBeTruthy();
    act(() => source.set({ run_id: "next-run", run_dir: "/data/runs/next-run" })); await tick();
    expect(screen.getByRole("button", { name: "local-vehicle Run: next-run" })).toBeTruthy();
    act(() => source.set({ run_id: null, run_dir: null, label: null, started: null })); await tick();
    expect(screen.getByRole("button", { name: "local-vehicle Run: no open run" })).toBeTruthy();
    act(() => source.set({ ok: false, error: "Registry unreadable" })); await tick();
    fireEvent.focus(screen.getByRole("button", { name: "local-vehicle Run: unavailable" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Registry unreadable");
    act(() => source.set({ ...run("recovered-run"), error: null })); await tick();
    expect(screen.getByRole("button", { name: "local-vehicle Run: recovered-run" })).toBeTruthy();
  });

  it("keeps unchanged runs fresh through empty polls, independently of vehicle and browser wall clocks", async () => {
    mount(); await tick();
    vi.setSystemTime(Date.now() + 365 * 24 * 3600 * 1000);
    await tick(CURRENT_RUN_STALE_MS + 5000);
    expect(screen.getByRole("button", { name: `local-vehicle Run: ${run().run_id}` })).toBeTruthy();
    expect(link.calls.filter(c => c.op === "view")).toHaveLength(1);
    expect(subscribe).not.toHaveBeenCalled();
    expect(link.calls.filter(c => c.op === "poll").length).toBeGreaterThan(2);
  });

  it("distinguishes disconnect from a stalled poll", async () => {
    const view = mount(); await tick();
    view.setStatus("reconnecting");
    expect(screen.getByRole("button", { name: "local-vehicle Run: offline" })).toBeTruthy();
    const original = link.get.bind(link);
    vi.spyOn(link, "get").mockImplementation((...args) => args[0].endsWith("/poll") ? new Promise(() => {}) : original(...args));
    view.setStatus("connected");
    await tick(CURRENT_RUN_STALE_MS + 5000);
    fireEvent.focus(screen.getByRole("button", { name: "local-vehicle Run: unavailable" }));
    expect(screen.getByRole("tooltip").textContent).toContain("No current run report has arrived recently");
  });

  it("re-registers after a state-service restart and shows the new current run", async () => {
    mount(); await tick();
    expect(screen.getByRole("button", { name: `local-vehicle Run: ${run().run_id}` })).toBeTruthy();
    act(() => {
      server.close();
      source = new RunSource();
      source.set({ epoch: "registry-restarted", run_id: "after-restart", run_dir: "/data/runs/after-restart" });
      server = new VehicleStateServer({ store: new FakeStore(), currentRun: source });
      link.server = server;
    });
    await tick(1500);
    expect(screen.getByRole("button", { name: "local-vehicle Run: after-restart" })).toBeTruthy();
  });

  it("hides the run header when no run registry is configured and makes no Rig discovery calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    mount(); await tick();
    expect(screen.queryByRole("group", { name: "Current runs" })).toBeNull();
    expect(link.calls).toHaveLength(0);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("never substitutes a discovered remote Rig run while local runtime metadata is pending or unavailable", async () => {
    let rejectRuntime!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { rejectRuntime = reject; })));
    const transport: Transport = link;
    const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    vi.spyOn(transport, "subscribe").mockImplementation(async (pattern, onSample) => {
      if (pattern === "fleet/*/rig/state") onSample({ keyexpr: "fleet/remote-vehicle/rig/state", kind: "put", payload: enc({
        schema_version: 1, vehicle_id: "remote-vehicle", vehicle: "remote", at_unix_s: Date.now() / 1000, ok: true, error: null,
        run: { id: "remote-run", label: "Remote flight", started: null, stacks: [] },
        registry: { data_dir: "/remote", free_kb: null, problem: null }, stacks: [], job: null,
      }) });
      return { close: async () => undefined };
    });
    const originalGet = link.get.bind(link);
    vi.spyOn(transport, "get").mockImplementation(async (key, opts) => key === "fleet/remote-vehicle/rig"
      ? [{ keyexpr: key, payload: enc({ schema_version: 1, service: "rig-agent", vehicle_id: "remote-vehicle", poll_s: 10 }) }]
      : originalGet(key, opts));
    mount(false, true); await tick();
    expect(screen.getByTestId("rig-agents").textContent).toBe("remote-vehicle:remote-run");
    expect(screen.queryByRole("group", { name: "Current runs" })).toBeNull();
    await act(async () => rejectRuntime(new Error("Runtime metadata unavailable")));
    await tick();
    expect(screen.queryByRole("group", { name: "Current runs" })).toBeNull();
    await tick(5000);
    expect(screen.getByTestId("rig-agents").textContent).toBe("remote-vehicle:remote-run");
    expect(screen.queryByRole("group", { name: "Current runs" })).toBeNull();
  });

  it("recovers invalid run runtime metadata without enabling Rig discovery", async () => {
    const metadata = { current_run_state_key: "fleet/*/dash/main/state" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => metadata })));
    mount(); await tick();
    fireEvent.focus(screen.getByRole("button", { name: "Local Run: unavailable" }));
    expect(screen.getByRole("tooltip").textContent).toContain("current_run_state_key");
    expect(link.calls).toHaveLength(0);
    metadata.current_run_state_key = BASE;
    await tick(5000); await tick();
    expect(screen.getByRole("button", { name: `local-vehicle Run: ${run().run_id}` })).toBeTruthy();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
