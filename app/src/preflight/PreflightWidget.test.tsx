// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildGraph, EMPTY_GRAPH, type RosGraph } from "../ros/graph";
import type { HealthService } from "../health/types";
import type { Transport } from "../transport/types";
import { callService, type ServiceCallResult } from "../services/callService";
import { PreflightWidget } from "./PreflightWidget";
import type { PreflightWidgetConfig } from "./spec";

const world = vi.hoisted(() => ({ healths: [] as HealthService[], graph: {} as RosGraph,
  transport: {} as Transport, status: "connected", active: true }));
vi.mock("../health/HealthContext", () => ({ useHealthContext: () => ({ services: world.healths }) }));
vi.mock("../ros/RosGraphContext", () => ({ useRosGraphContext: () => ({ graph: world.graph }) }));
vi.mock("../transport/TransportContext", () => ({ useTransportContext: () => world }));
vi.mock("../shell/TabActivity", () => ({ useTabActive: () => world.active }));
vi.mock("../services/callService", async (original) => ({ ...(await original<typeof import("../services/callService")>()), callService: vi.fn() }));
const call = vi.mocked(callService);
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const reply = (paused: unknown): ServiceCallResult => ({ response: { paused }, raw: new Uint8Array(), serverKeyexpr: "key", rttMs: 1 });
const token = (name: string, zid = "a") => `@ros2_lv/0/${zid}/0/${name.replaceAll("/", "_")}/SS/%/%/recorder/${name.replaceAll("/", "%")}/rosbag2_interfaces::srv::dds_::IsPaused_/hash/::,10:,:,:,,`;
const graph = (zid = "a") => buildGraph([token("/logger/is_paused", zid), token("/logger/pause", zid)]);
const config = (groups: PreflightWidgetConfig["groups"]): PreflightWidgetConfig => ({ type: "preflight", display: "pills", poll_s: 3, groups });
const bag = config([{ label: "Logging", checks: [{ type: "bag_recording", recorder: "/logger", label: "ROS bag" }] }]);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  world.healths = []; world.graph = EMPTY_GRAPH; world.transport = {} as Transport; world.status = "connected"; world.active = true;
  call.mockReset(); call.mockResolvedValue(reply(false));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows ordered groups, persistent missing checks, and keyboard/tap details without calling services", async () => {
  const widget = config([
    { label: "Services", checks: [{ type: "health", service: "ouster", label: "Lidar" }] },
    { label: "Readiness", checks: [{ type: "ros_service", service: "/start", label: "Start" }] },
  ]);
  world.graph = buildGraph([token("/start")]);
  render(<PreflightWidget widget={{ ...widget, display: "dots" }} />);
  expect(screen.getAllByRole("group").map((e) => e.getAttribute("aria-label"))).toEqual(["Services", "Readiness"]);
  expect(screen.getByRole("button", { name: "Lidar: No health report" }).className).toContain("err");
  const ready = screen.getByRole("button", { name: "Start: Service advertised" });
  fireEvent.focus(ready);
  expect(screen.getByRole("tooltip").textContent).toContain("response readiness is not verified");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(ready); expect(screen.getByRole("tooltip")).toBeTruthy();
  expect(call).not.toHaveBeenCalled();
});

it("ages live health to red and invalidates cached green on disconnect", async () => {
  world.healths = [{ key: "fleet/1/svc/ins/health", vehicleId: "1", instance: "ins", alive: true, receivedAtMs: 10_000,
    snapshot: { schema_version: 1, service: "ins", instance: "ins", stamp_unix_ns: 0, level: 0,
      status: [{ name: "ins: gps", message: "GPS locked", level: 0, hardware_id: "", values: {} }] } }];
  const widget = config([{ label: "Services", checks: [{ type: "health" }] }]);
  const view = render(<PreflightWidget widget={widget} />);
  expect(screen.getByRole("button", { name: "1/ins: Healthy" }).className).toContain("ok");
  await tick(6000);
  expect(screen.getByRole("button", { name: "1/ins: Health reporter silent" }).className).toContain("err");
  world.status = "disconnected"; view.rerender(<PreflightWidget widget={widget} />);
  expect(screen.getByRole("button", { name: "1/ins: Dashboard disconnected" }).className).toContain("err");
});

it("polls only is_paused, updates recording/paused/error, and ignores unrelated graph rebuilds", async () => {
  world.graph = graph();
  const view = render(<PreflightWidget widget={bag} />); await tick();
  expect(screen.getByRole("button", { name: "ROS bag: Recording" }).className).toContain("ok");
  expect(call).toHaveBeenCalledTimes(1);
  world.graph = graph(); view.rerender(<PreflightWidget widget={bag} />); await tick();
  expect(call).toHaveBeenCalledTimes(1);
  call.mockResolvedValue(reply(true)); await tick(3000);
  expect(screen.getByRole("button", { name: "ROS bag: Recorder paused" }).className).toContain("warn");
  call.mockResolvedValue(reply(undefined)); await tick(3000);
  expect(screen.getByRole("button", { name: "ROS bag: Recorder not responding" }).className).toContain("err");
  expect(call.mock.calls.every((args) => args[2] === "/logger/is_paused" && Object.keys(args[3]).length === 0)).toBe(true);
  view.unmount(); const calls = call.mock.calls.length; await tick(20_000); expect(call).toHaveBeenCalledTimes(calls);
});

it("bounds a hung poll, pauses queries when hidden, and checks afresh when visible", async () => {
  world.graph = graph(); call.mockImplementation(() => new Promise(() => {}));
  const view = render(<PreflightWidget widget={bag} />); await tick(1000);
  expect(call).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "ROS bag: Checking recorder" })).toBeTruthy();
  await tick(1000);
  expect(screen.getByRole("button", { name: "ROS bag: Recorder not responding" })).toBeTruthy();
  world.active = false; view.rerender(<PreflightWidget widget={bag} />); await tick(20_000);
  expect(call).toHaveBeenCalledTimes(1);
  call.mockResolvedValue(reply(false)); world.active = true; view.rerender(<PreflightWidget widget={bag} />); await tick();
  expect(call).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "ROS bag: Recording" })).toBeTruthy();
});

it("drops late replies after disappearance, disconnect and a changed endpoint", async () => {
  let resolve!: (r: ServiceCallResult) => void;
  world.graph = graph(); call.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const view = render(<PreflightWidget widget={bag} />); await tick();
  world.graph = EMPTY_GRAPH; view.rerender(<PreflightWidget widget={bag} />);
  await act(async () => resolve(reply(false)));
  expect(screen.getByRole("button", { name: "ROS bag: Recorder unavailable" })).toBeTruthy();
  world.graph = graph("restart"); view.rerender(<PreflightWidget widget={bag} />); await tick();
  expect(screen.getByRole("button", { name: "ROS bag: Recording" })).toBeTruthy();
  world.status = "disconnected"; view.rerender(<PreflightWidget widget={bag} />); await tick(10_000);
  expect(screen.getByRole("button", { name: "ROS bag: Dashboard disconnected" })).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(2);
  world.status = "connected"; call.mockResolvedValue(reply(true)); view.rerender(<PreflightWidget widget={bag} />); await tick();
  expect(screen.getByRole("button", { name: "ROS bag: Recorder paused" })).toBeTruthy();
});
