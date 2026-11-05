// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HealthProvider, useHealthContext } from "../health/HealthContext";
import { HEALTH_PATTERN, HEALTH_STATE_PATTERN, type HealthSnapshot } from "../health/types";
import { LifecycleProvider } from "../lifecycle/LifecycleContext";
import { LIFECYCLE_PATTERN, LIFECYCLE_STATE_PATTERN, type LifecycleDescriptor } from "../lifecycle/types";
import { buildGraph } from "../ros/graph";
import { RosGraphCtx } from "../ros/RosGraphContext";
import type { SchemaResolver } from "../schema/types";
import { TransportCtx } from "../transport/TransportContext";
import type { GetReply, LivelinessEvent, Sample, Transport, TransportGetOptions } from "../transport/types";
import { VehicleStateCtx } from "../vstate/VehicleStateContext";
import { PreflightWidget } from "./PreflightWidget";
import type { PreflightWidgetConfig } from "./spec";

vi.mock("../config/ConfigContext", () => ({ useConfig: () => ({ phase: "absent" }) }));

const KEY = "fleet/vehicle1/svc/cam0/health";
const OTHER_KEY = "fleet/vehicle2/svc/cam0/health";
const LIFECYCLE_KEY = "fleet/vehicle1/svc/cam0/lifecycle";
const REPLAY_KEY = "ros2/0/%2Fother_topic/cam0";
const graph = buildGraph(["@ros2_lv/0/z/1/2/MP/%/%/replay/%other_topic/diagnostic_msgs::msg::dds_::DiagnosticArray_/hash/::,10::::"]);
const replayTopic = graph.topics[0];
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const tick = (ms = 50) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function nativeSnapshot(state: "active" | "inactive"): HealthSnapshot {
  return { schema_version: 1, service: "camera-service", instance: "cam0", stamp_unix_ns: 0, level: 0,
    status: [
      { name: "cam0: stream", level: 0, message: "Capturing", hardware_id: "camera", values: { frames: 100 } },
      { name: "cam0: recording", level: 0, message: state, hardware_id: "camera",
        values: { enabled: true, state, frames: state === "active" ? 30 : 0 } },
    ] };
}

function descriptor(state: "active" | "inactive"): LifecycleDescriptor {
  return { schema_version: 1, service: "camera-service", instance: "cam0", state, recording_enabled: true,
    transitions: [state === "active" ? "deactivate" : "activate"] };
}

/** Exercise discovery and command parsing; only the transport and DiagnosticArray decoder are fake. */
function cameraAndReplay() {
  let health = nativeSnapshot("inactive");
  let lifecycle = descriptor("inactive");
  const samples = new Map<string, (sample: Sample) => void>();
  const tokens = new Map<string, (event: LivelinessEvent) => void>();
  const publishNative = (state: "active" | "inactive" = "inactive") => {
    health = nativeSnapshot(state);
    samples.get(HEALTH_STATE_PATTERN)?.({ keyexpr: `${KEY}/state`, kind: "put", payload: encode(health) });
  };
  const transport: Transport = {
    get: vi.fn(async (key: string, opts?: TransportGetOptions): Promise<GetReply[]> => {
      if (key === KEY || key === OTHER_KEY) return [{ keyexpr: key, payload: encode(health) }];
      if (key === LIFECYCLE_KEY) return [{ keyexpr: key, payload: encode(lifecycle) }];
      if (key === `${LIFECYCLE_KEY}/change_state`) {
        const request = JSON.parse(new TextDecoder().decode(opts?.payload));
        const state = request.transition === "activate" ? "active" : "inactive";
        lifecycle = descriptor(state);
        samples.get(LIFECYCLE_STATE_PATTERN)?.({ keyexpr: `${LIFECYCLE_KEY}/state`, kind: "put", payload: encode(lifecycle) });
        publishNative(state);
        return [{ keyexpr: key, payload: encode({ ok: true, state, descriptor: lifecycle,
          ...(state === "inactive" ? { session: { files: ["cam0.mkv"], frames: 30, truncated: false } } : {}) }) }];
      }
      throw new Error(`Unexpected query ${key}`);
    }),
    subscribe: async (pattern, cb) => {
      expect([HEALTH_STATE_PATTERN, LIFECYCLE_STATE_PATTERN, replayTopic.dataKeyexpr]).toContain(pattern);
      samples.set(pattern, cb);
      return { close: async () => { samples.delete(pattern); } };
    },
    liveliness: {
      subscribe: async (pattern, cb) => {
        expect([HEALTH_PATTERN, LIFECYCLE_PATTERN]).toContain(pattern);
        tokens.set(pattern, cb);
        if (pattern === LIFECYCLE_PATTERN) cb({ keyexpr: LIFECYCLE_KEY, alive: true });
        return { close: async () => { tokens.delete(pattern); } };
      },
      get: async () => [],
    },
    close: async () => undefined,
  };
  return {
    transport,
    announce: (key = KEY) => tokens.get(HEALTH_PATTERN)?.({ keyexpr: key, alive: true }),
    offline: () => tokens.get(HEALTH_PATTERN)?.({ keyexpr: KEY, alive: false }),
    replay: (sampleAge = 0) => samples.get(replayTopic.dataKeyexpr)?.({ keyexpr: replayTopic.dataKeyexpr, kind: "put",
      payload: encode({ status: nativeSnapshot("active").status.map(row => ({ ...row,
        // The replay has an instance but no fleet identity. Its active state conflicts with the
        // live camera's initial inactive state, even when the recorded sample appears fresh.
        values: Object.entries({ ...row.values, "health.instance": "cam0", "health.service": "camera-service",
          "health.sample_age_s": sampleAge, "health.stale_after_s": 5 }).map(([key, value]) => ({ key, value: String(value) })),
      })) }) }),
    commands: () => vi.mocked(transport.get).mock.calls.filter(([key]) => key.endsWith("/change_state")),
  };
}

function HealthInventory() {
  const { services } = useHealthContext();
  return <output data-testid="health-keys">{JSON.stringify(services.map(service => service.key).sort())}</output>;
}

function mount(service = "cam0") {
  const camera = cameraAndReplay();
  const resolver: SchemaResolver = { resolve: vi.fn(async () => ({ decode: (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) })) };
  const widget: PreflightWidgetConfig = { type: "preflight", display: "pills", poll_s: 3, recording_controls: true,
    groups: [{ label: "Cameras", checks: [{ type: "camera_recording", service, label: "Camera" }] }] };
  render(<TransportCtx.Provider value={{ transport: camera.transport, status: "connected", error: "", locator: "test" }}>
    <VehicleStateCtx.Provider value={{ enabled: false, client: null }}>
      <RosGraphCtx.Provider value={{ graph, resolver, store: null }}>
        <LifecycleProvider><HealthProvider><HealthInventory /><PreflightWidget widget={widget} /></HealthProvider></LifecycleProvider>
      </RosGraphCtx.Provider>
    </VehicleStateCtx.Provider>
  </TransportCtx.Provider>);
  return camera;
}

function expectBothReporters() {
  expect(JSON.parse(screen.getByTestId("health-keys").textContent!)).toEqual([KEY, REPLAY_KEY]);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each([
  ["native-first", 0], ["native-first", 3600], ["replay-first", 0], ["replay-first", 3600],
] as const)("keeps %s native camera status and recording controls authoritative over replay age %s", async (order, age) => {
  const camera = mount();
  await tick();
  act(() => order === "native-first" ? camera.announce() : camera.replay(age));
  await tick();
  act(() => order === "native-first" ? camera.replay(age) : camera.announce());
  await tick();
  expectBothReporters();
  expect(screen.getByRole("button", { name: "Camera: Camera up, not recording" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record all" }));
  await tick();
  expect(camera.commands()).toHaveLength(1);
  expect(camera.commands()[0][0]).toBe(`${LIFECYCLE_KEY}/change_state`);
  expect(JSON.parse(new TextDecoder().decode(camera.commands()[0][1]?.payload))).toEqual({ transition: "activate" });
  expect(screen.getByRole("button", { name: "Camera: Recording" }).className).toContain("ok");
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await tick();
  expect(camera.commands()).toHaveLength(2);
  expect(camera.commands()[1][0]).toBe(`${LIFECYCLE_KEY}/change_state`);
  expect(JSON.parse(new TextDecoder().decode(camera.commands()[1][1]?.payload))).toEqual({ transition: "deactivate" });
  expect(camera.commands()[1][1]?.timeoutMs).toBe(20_000);
  expect(screen.getByRole("button", { name: "Camera: Camera up, not recording" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Recording issues" })).toBeNull();
  expectBothReporters();
});

it.each(["offline", "silent"])("does not substitute fresh replay for a native reporter that is %s", async condition => {
  const camera = mount();
  await tick();
  act(() => camera.announce()); await tick();
  if (condition === "offline") act(() => camera.offline());
  else await tick(6000);
  act(() => camera.replay()); await tick();
  expectBothReporters();
  const reason = condition === "offline" ? "Service offline" : "Health reporter silent";
  expect(screen.getByRole("button", { name: `Camera: ${reason}` }).className).toContain("err");
});

it("keeps genuine fleet identities ambiguous and sends no recording command", async () => {
  const camera = mount();
  await tick();
  act(() => { camera.announce(); camera.announce(OTHER_KEY); camera.replay(); });
  await tick();
  expect(screen.getByRole("button", { name: "Camera: Ambiguous health service" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record all" })); await tick();
  expect(camera.commands()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Recording issues" })).toBeTruthy();
});

it("keeps an explicit replay health key from commanding the native camera", async () => {
  const camera = mount(REPLAY_KEY);
  await tick();
  act(() => { camera.announce(); camera.replay(); });
  await tick();
  expectBothReporters();
  expect(screen.getByRole("button", { name: "Camera: Recording" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" })); await tick();
  expect(camera.commands()).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Recording issues" })).toBeTruthy();
});
