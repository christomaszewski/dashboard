// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildGraph, EMPTY_GRAPH, type RosGraph } from "../ros/graph";
import type { HealthService, HealthStatus } from "../health/types";
import type { LifecycleService, RecordingSettings } from "../lifecycle/types";
import { changeState, type ChangeStateResult } from "../lifecycle/changeState";
import type { Transport } from "../transport/types";
import { callService, type ServiceCallResult } from "../services/callService";
import { PreflightWidget } from "./PreflightWidget";
import type { PreflightCheck, PreflightWidgetConfig } from "./spec";

const world = vi.hoisted(() => ({ healths: [] as HealthService[], cameras: [] as LifecycleService[], graph: {} as RosGraph,
  transport: {} as Transport, status: "connected", active: true }));
vi.mock("../health/HealthContext", () => ({ useHealthContext: () => ({ services: world.healths }) }));
vi.mock("../lifecycle/LifecycleContext", () => ({ useLifecycleContext: () => ({ services: world.cameras }) }));
vi.mock("../ros/RosGraphContext", () => ({ useRosGraphContext: () => ({ graph: world.graph }) }));
vi.mock("../transport/TransportContext", () => ({ useTransportContext: () => world }));
vi.mock("../shell/TabActivity", () => ({ useTabActive: () => world.active }));
vi.mock("../services/callService", async original => ({ ...(await original<typeof import("../services/callService")>()), callService: vi.fn() }));
vi.mock("../lifecycle/changeState", () => ({ changeState: vi.fn() }));
const call = vi.mocked(callService);
const change = vi.mocked(changeState);
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const response = (value: Record<string, unknown> = {}): ServiceCallResult => ({ response: value, raw: new Uint8Array(), serverKeyexpr: "key", rttMs: 1 });
const token = (base: string, leaf: string, domain = 4, type = leaf === "is_paused" ? "IsPaused" : leaf === "pause" ? "Pause" : "Resume", zid = "a", nid = "0") =>
  `@ros2_lv/${domain}/${zid}/${nid}/${base}_${leaf}/SS/%/%/logger/%${base}%${leaf}/rosbag2_interfaces::srv::dds_::${type}_/${type}hash/::,10:,:,:,,`;
const tokens = (base = "logger", domain = 4) => ["pause", "resume", "is_paused"].map(leaf => token(base, leaf, domain));
const bag: PreflightCheck = { type: "bag_recording", recorder: "/logger", domain_id: 4, label: "ROS bag" };
const cam: PreflightCheck = { type: "camera_recording", service: "truck/front", label: "Front" };
const config = (checks: PreflightCheck[] = [bag, cam]): PreflightWidgetConfig => ({ type: "preflight", display: "pills", poll_s: 3, recording_controls: true,
  groups: [{ label: "Logging", checks }] });
const camera = (vehicleId = "truck", instance = "front"): LifecycleService => ({ key: `fleet/${vehicleId}/svc/${instance}/lifecycle`, vehicleId, instance, alive: true,
  descriptor: { schema_version: 1, service: "camera-service", instance, state: "inactive", transitions: ["activate"], recording_enabled: true } });
const health = (state = "inactive", vehicleId = "truck", instance = "front"): HealthService => ({ key: `fleet/${vehicleId}/svc/${instance}/health`, vehicleId, instance, alive: true, receivedAtMs: Date.now(),
  snapshot: { schema_version: 1, service: "camera-service", instance, stamp_unix_ns: 0, level: 0,
    status: ["stream", "recording"].map<HealthStatus>(name => ({ name: `${instance}: ${name}`, level: 0, hardware_id: "", message: "OK", values: name === "recording" ? { state, enabled: true, frames: state === "active" ? 10 : 0 } : {} as HealthStatus["values"] })) } });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const commands = () => call.mock.calls.filter(args => !args[2].endsWith("/is_paused"));
const openIssues = () => {
  if (!screen.queryByRole("dialog", { name: "Recording issues" })) fireEvent.click(button("Recording issues"));
  return screen.getByRole("dialog", { name: "Recording issues" });
};
const expectQuiet = () => {
  expect(screen.queryByRole("button", { name: "Recording issues" })).toBeNull();
  expect(screen.queryByRole("status", { name: "Recording status" })).toBeNull();
  expect(screen.queryByRole("status", { name: "Recording command results" })).toBeNull();
};
let paused = true;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  world.healths = [health()]; world.cameras = [camera()]; world.graph = buildGraph(tokens());
  world.transport = {} as Transport; world.status = "connected"; world.active = true; paused = true;
  call.mockReset(); change.mockReset();
  call.mockImplementation(async (_t, _g, name) => {
    if (name.endsWith("/is_paused")) return response({ paused });
    paused = name.endsWith("/pause"); return response({ return_code: 0 });
  });
  change.mockImplementation(async (_t, key, transition) => {
    const state = transition === "activate" ? "active" : "inactive";
    const c = world.cameras.find(c => c.key === key)!;
    c.descriptor = { ...c.descriptor, state, transitions: [state === "active" ? "deactivate" : "activate"] };
    world.healths = [health(state, c.vehicleId, c.instance)];
    return { ok: true, state, rttMs: 1 };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("is opt-in and cannot command health-only selections", async () => {
  const view = render(<PreflightWidget widget={{ ...config(), recording_controls: false }} />); await tick();
  expect(screen.queryByRole("button", { name: "Record all" })).toBeNull();
  view.rerender(<PreflightWidget widget={config([{ type: "health" }])} />); await tick();
  expect(button("Record all").disabled).toBe(true);
  expect(button("Stop recording").disabled).toBe(true);
  expect(commands()).toHaveLength(0); expect(change).not.toHaveBeenCalled();
});

it("starts only configured recorders, deduplicates aliases, preserves domain and settings guards, and stays quiet on success", async () => {
  const expected = { generation: "g1", revision: 3 } as RecordingSettings;
  world.cameras[0].descriptor.recording_settings = expected;
  world.cameras.push(camera("truck", "unselected"));
  world.graph = buildGraph([...tokens(), ...tokens("unselected"), ...tokens("logger", 8)]);
  const widget = config([bag, cam, bag, { type: "camera_recording", service: "fleet/truck/svc/front/health" },
    { type: "health", service: "truck/unselected" }, { type: "ros_service", service: "/unselected/resume" }]);
  render(<PreflightWidget widget={widget} />); await tick(); expectQuiet();
  expect(button("Record all").textContent).toBe("");
  expect(button("Stop recording").textContent).toBe("");
  fireEvent.click(button("Record all")); fireEvent.click(button("Record all")); await tick();
  expect(commands().map(args => args[2])).toEqual(["/logger/resume"]);
  expect(commands()[0][4]).toEqual({ timeoutMs: 5000, domainId: 4 });
  expect(commands()[0][1].services.flatMap(s => s.servers).every(s => s.domainId === 4)).toBe(true);
  expect(change).toHaveBeenCalledExactlyOnceWith(world.transport, "fleet/truck/svc/front/lifecycle", "activate", { expected });
  expectQuiet();
  fireEvent.click(button("Stop recording")); await tick();
  expect(commands().map(args => args[2])).toEqual(["/logger/resume", "/logger/pause"]);
  expect(change.mock.calls.map(args => args[2])).toEqual(["activate", "deactivate"]);
  expectQuiet();
});

it("shows only an error indicator on partial failure, opens details on demand, and retries only failed targets", async () => {
  change.mockResolvedValueOnce({ ok: false, error: "Disk full", rttMs: 1 });
  render(<PreflightWidget widget={config()} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(button("Recording issues").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/Disk full/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
  const panel = openIssues();
  expect(panel.textContent).toContain("Front: Disk full");
  expect(panel.textContent).not.toContain("ROS bag");
  expect(panel.closest(".preflight-strip")).toBeNull(); // portal, not a growing preflight row
  expect(commands().map(args => args[2])).toEqual(["/logger/resume"]);
  fireEvent.click(button("Retry failed")); await tick();
  expect(commands().map(args => args[2])).toEqual(["/logger/resume"]);
  expect(change).toHaveBeenCalledTimes(2); expectQuiet();
});

it("supports keyboard and outside-click dismissal of issue details", async () => {
  change.mockRejectedValue(new Error("Disk full"));
  render(<PreflightWidget widget={config([cam])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  const panel = openIssues(); expect(document.activeElement).toBe(panel);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button("Recording issues"));
  openIssues(); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  openIssues(); fireEvent.click(button("Close recording issues"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retains never-seen targets as failures and permits retry after they appear", async () => {
  world.cameras = []; world.healths = [];
  const view = render(<PreflightWidget widget={config()} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(openIssues().textContent).toContain("Camera recording control unavailable");
  world.cameras = [camera()]; world.healths = [health()]; view.rerender(<PreflightWidget widget={config()} />);
  fireEvent.click(button("Retry failed")); await tick();
  expectQuiet(); expect(commands()).toHaveLength(1);
});

it("indicates pending finalization in the stop icon and preserves truncation warnings behind the indicator", async () => {
  let finish!: (reply: ChangeStateResult) => void;
  world.cameras[0].descriptor.state = "active"; world.cameras[0].descriptor.transitions = ["deactivate"];
  change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<PreflightWidget widget={config()} />); await tick();
  fireEvent.click(button("Stop recording")); await tick();
  expect(button("Record all").disabled).toBe(true);
  expect(button("Stop recording").title).toBe("Stopping recording…");
  expect(screen.getByRole("group", { name: "Recording controls" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText(/Stopping/)).toBeNull();
  await act(async () => finish({ ok: true, state: "inactive", session: { truncated: true, error: "Drain failed" }, rttMs: 1 }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(openIssues().textContent).toContain("Drain failed Recording file was truncated.");
  expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
  expect(button("Record all").disabled).toBe(false);
});

it.each(["refused", "wrong-state", "malformed", "warning"])("reports a bag failure for %s replies", async mode => {
  call.mockImplementation(async (_t, _g, name) => {
    if (name.endsWith("/resume")) return mode === "refused" ? response({ return_code: 1, error_string: "No bag open" }) : response();
    const r = response({ paused: mode === "malformed" ? undefined : true });
    return mode === "warning" ? { ...r, warning: "Unexpected reply bytes" } : r;
  });
  render(<PreflightWidget widget={config([bag])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(openIssues().textContent).toContain("ROS bag");
  expect(button("Retry failed").disabled).toBe(false);
});

it.each(["ambiguous-domain", "player", "wrong-type", "different-node"])("refuses unsafe bag target: %s", async mode => {
  const list = tokens();
  if (mode === "ambiguous-domain") list.push(...tokens("logger", 8));
  if (mode === "player") list.push(token("logger", "seek", 4, "Seek"));
  if (mode === "wrong-type") list[1] = token("logger", "resume", 4, "Other");
  if (mode === "different-node") list[1] = token("logger", "resume", 4, "Resume", "other");
  world.graph = buildGraph(list);
  render(<PreflightWidget widget={config([{ type: "bag_recording", recorder: "/logger" }])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(commands()).toHaveLength(0); expect(button("Recording issues")).toBeTruthy();
});

it.each(["ambiguous", "disabled", "offline", "other-service"])("reports camera %s without mutating it", async mode => {
  if (mode === "ambiguous") world.healths.push(health("inactive", "other"));
  if (mode === "disabled") world.cameras[0].descriptor.recording_enabled = false;
  if (mode === "offline") world.cameras[0].alive = false;
  if (mode === "other-service") world.cameras[0].descriptor.service = "motor-controller";
  render(<PreflightWidget widget={config([{ type: "camera_recording", service: "front" }])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(change).not.toHaveBeenCalled(); expect(button("Recording issues")).toBeTruthy();
});

it("invalidates pending commands on disconnect, ignores late replies and never replays automatically", async () => {
  let finish!: (reply: ChangeStateResult) => void;
  change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const widget = config([cam]);
  const view = render(<PreflightWidget widget={widget} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  world.status = "disconnected"; view.rerender(<PreflightWidget widget={widget} />); await tick();
  expect(openIssues().textContent).toContain("Connection changed");
  expect(button("Retry failed").disabled).toBe(true);
  await act(async () => finish({ ok: true, state: "active", rttMs: 1 }));
  expect(button("Recording issues")).toBeTruthy();
  world.status = "connected"; view.rerender(<PreflightWidget widget={widget} />); await tick();
  expect(change).toHaveBeenCalledTimes(1);
  fireEvent.click(button("Retry failed")); await tick();
  expect(change).toHaveBeenCalledTimes(2); expectQuiet();
});

it("pins retries to the original camera identity when a short-name match moves to another vehicle", async () => {
  change.mockRejectedValueOnce(new Error("Link lost"));
  const widget = config([{ type: "camera_recording", service: "front" }]);
  const view = render(<PreflightWidget widget={widget} />); await tick();
  fireEvent.click(button("Record all")); await tick(); openIssues();
  world.cameras = [camera("other")]; world.healths = [health("inactive", "other")];
  view.rerender(<PreflightWidget widget={widget} />);
  fireEvent.click(button("Retry failed")); await tick();
  expect(change).toHaveBeenCalledTimes(1);
  expect(openIssues().textContent).toContain("Camera recording control unavailable");
});

it("bounds hung commands and never fabricates health status from command acknowledgements", async () => {
  let finish!: (reply: ChangeStateResult) => void;
  change.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<PreflightWidget widget={config([cam])} />); await tick();
  fireEvent.click(button("Record all")); await tick(25_000);
  expect(openIssues().textContent).toContain("command timed out");
  expect(button("Record all").disabled).toBe(false);
  await act(async () => finish({ ok: true, state: "active", rttMs: 1 }));
  expect(button("Recording issues")).toBeTruthy();
  change.mockResolvedValue({ ok: true, state: "active", rttMs: 1 });
  fireEvent.click(button("Retry failed")); await tick(); expectQuiet();
  expect(button("Front: Health reporter silent")).toBeTruthy();
});

it("reports missing bags without issuing commands", async () => {
  world.graph = EMPTY_GRAPH;
  render(<PreflightWidget widget={config([bag])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(commands()).toHaveLength(0); expect(openIssues().textContent).toContain("Recorder unavailable");
});

it("resolves full reporter keys to camera lifecycle identity", async () => {
  world.healths[0].key = "ros-health/4/front-diagnostics";
  render(<PreflightWidget widget={config([{ type: "camera_recording", service: world.healths[0].key }])} />); await tick();
  fireEvent.click(button("Record all")); await tick();
  expect(change.mock.calls[0][1]).toBe("fleet/truck/svc/front/lifecycle"); expectQuiet();
});

it("pins a health-discovered camera even if its control plane was unavailable on the first attempt", async () => {
  world.cameras = [];
  const widget = config([{ type: "camera_recording", service: "front" }]);
  const view = render(<PreflightWidget widget={widget} />); await tick();
  fireEvent.click(button("Record all")); await tick(); openIssues();
  world.cameras = [camera("other")]; world.healths = [health("inactive", "other")];
  view.rerender(<PreflightWidget widget={widget} />);
  fireEvent.click(button("Retry failed")); await tick();
  expect(change).not.toHaveBeenCalled(); expect(button("Recording issues")).toBeTruthy();
});

it("shares one retry when previously missing aliases resolve to the same recorder", async () => {
  world.cameras = []; world.healths = [];
  const widget = config([{ type: "camera_recording", service: "front" }, cam]);
  const view = render(<PreflightWidget widget={widget} />); await tick();
  fireEvent.click(button("Record all")); await tick(); openIssues();
  world.cameras = [camera()]; world.healths = [health()]; view.rerender(<PreflightWidget widget={widget} />);
  fireEvent.click(button("Retry failed")); await tick();
  expect(change).toHaveBeenCalledTimes(1); expectQuiet();
});

it("pins a failed bag retry to the original inferred ROS domain", async () => {
  call.mockImplementation(async (_t, _g, name) => name.endsWith("/resume") ? response({ return_code: 1 }) : response({ paused: true }));
  const widget = config([{ type: "bag_recording", recorder: "/logger" }]);
  const view = render(<PreflightWidget widget={widget} />); await tick();
  fireEvent.click(button("Record all")); await tick(); openIssues();
  world.graph = buildGraph(tokens("logger", 8)); view.rerender(<PreflightWidget widget={widget} />);
  fireEvent.click(button("Retry failed")); await tick();
  expect(commands()).toHaveLength(1); expect(commands()[0][4]?.domainId).toBe(4);
  expect(button("Recording issues")).toBeTruthy();
});

it("retries a failed stop without restarting or re-commanding successful targets", async () => {
  paused = false;
  world.cameras[0].descriptor.state = "active"; world.cameras[0].descriptor.transitions = ["deactivate"];
  let first = true;
  call.mockImplementation(async (_t, _g, name) => {
    if (name.endsWith("/is_paused")) return response({ paused });
    if (first) { first = false; return response({ return_code: 1, error_string: "Recorder busy" }); }
    paused = true; return response();
  });
  render(<PreflightWidget widget={config()} />); await tick();
  fireEvent.click(button("Stop recording")); await tick();
  expect(openIssues().textContent).toContain("ROS bag: Recorder busy");
  fireEvent.click(button("Retry failed")); await tick();
  expect(commands().map(args => args[2])).toEqual(["/logger/pause", "/logger/pause"]);
  expect(change.mock.calls.map(args => args[2])).toEqual(["deactivate"]); expectQuiet();
});
