// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HealthProvider } from "../health/HealthContext";
import { HEALTH_PATTERN, HEALTH_STATE_PATTERN, type HealthSnapshot } from "../health/types";
import { LifecycleProvider } from "../lifecycle/LifecycleContext";
import { LIFECYCLE_PATTERN, LIFECYCLE_STATE_PATTERN, type LifecycleDescriptor } from "../lifecycle/types";
import { EMPTY_GRAPH } from "../ros/graph";
import { RosGraphCtx } from "../ros/RosGraphContext";
import type { SchemaResolver } from "../schema/types";
import { TransportCtx } from "../transport/TransportContext";
import type { GetReply, LivelinessEvent, Sample, Transport, TransportGetOptions } from "../transport/types";
import { VehicleStateClient } from "../vstate/client";
import { HealthHub } from "../vstate/healthHub";
import { VehicleStateServer } from "../vstate/server";
import { FakeStore, LoopbackTransport } from "../vstate/testkit";
import { TopicSourceCtx, VehicleStateCtx } from "../vstate/VehicleStateContext";
import { PreflightWidget } from "./PreflightWidget";
import type { PreflightWidgetConfig } from "./spec";

vi.mock("../config/ConfigContext", () => ({ useConfig: () => ({ phase: "absent" }) }));

const KEY = "fleet/vehicle1/svc/cam0/health";
const RETIRED_KEY = "fleet/previous-container/svc/cam0/health";
const LIFECYCLE_KEY = "fleet/vehicle1/svc/cam0/lifecycle";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const snapshot = (state: "active" | "inactive" = "active"): HealthSnapshot => ({
  schema_version: 1, service: "camera-service", instance: "cam0", stamp_unix_ns: 0, level: 0,
  status: [
    { name: "cam0: stream", level: 0, message: "Capturing", hardware_id: "", values: { frames: 100 } },
    { name: "cam0: recording", level: 0, message: state, hardware_id: "", values: { enabled: true, state, frames: 30 } },
  ],
});

const descriptor = (state: string): LifecycleDescriptor => ({
  schema_version: 1, service: "camera-service", instance: "cam0", state,
  transitions: state === "active" ? ["deactivate"] : state === "inactive" ? ["activate"] : [],
});

/** Native health is relayed by vehicle state; lifecycle reads/commands remain direct. */
function nativeCamera(options: { initialState?: string; failFirstDescriptor?: boolean } = {}) {
  let current = snapshot();
  let lifecycle = descriptor(options.initialState ?? "active");
  let descriptorFailed = false;
  let finishCommand: ((replies: GetReply[]) => void) | undefined;
  const sampleHandlers = new Map<string, (sample: Sample) => void>();
  const tokenHandlers = new Map<string, (event: LivelinessEvent) => void>();
  const publish = (next = current) => {
    current = next;
    sampleHandlers.get(HEALTH_STATE_PATTERN)?.({ keyexpr: `${KEY}/state`, kind: "put", payload: encode(current) });
  };
  const setLifecycle = (state: string, announce = true) => {
    lifecycle = descriptor(state);
    if (announce) sampleHandlers.get(LIFECYCLE_STATE_PATTERN)?.({ keyexpr: `${LIFECYCLE_KEY}/state`, kind: "put", payload: encode(lifecycle) });
  };
  const transport: Transport = {
    get: vi.fn(async (keyexpr: string, _opts?: TransportGetOptions): Promise<GetReply[]> => {
      if (keyexpr === KEY || keyexpr === RETIRED_KEY) return [{ keyexpr, payload: encode(current) }];
      if (keyexpr === LIFECYCLE_KEY) {
        if (options.failFirstDescriptor && !descriptorFailed) {
          descriptorFailed = true;
          throw new Error("Temporary descriptor read failure");
        }
        return [{ keyexpr, payload: encode(lifecycle) }];
      }
      if (keyexpr === `${LIFECYCLE_KEY}/change_state`) return new Promise((resolve) => { finishCommand = resolve; });
      throw new Error(`Unexpected native query: ${keyexpr}`);
    }),
    subscribe: async (pattern, handler) => {
      expect([HEALTH_STATE_PATTERN, LIFECYCLE_STATE_PATTERN]).toContain(pattern);
      sampleHandlers.set(pattern, handler);
      return { close: async () => { sampleHandlers.delete(pattern); } };
    },
    liveliness: {
      subscribe: async (pattern, handler) => {
        expect([HEALTH_PATTERN, LIFECYCLE_PATTERN]).toContain(pattern);
        tokenHandlers.set(pattern, handler);
        handler({ keyexpr: pattern === HEALTH_PATTERN ? KEY : LIFECYCLE_KEY, alive: true });
        return { close: async () => { tokenHandlers.delete(pattern); } };
      },
      get: async () => [KEY],
    },
    close: async () => undefined,
  };
  return {
    transport, publish, setLifecycle,
    announcePrevious: () => tokenHandlers.get(HEALTH_PATTERN)?.({ keyexpr: RETIRED_KEY, alive: true }),
    withdrawPrevious: () => tokenHandlers.get(HEALTH_PATTERN)?.({ keyexpr: RETIRED_KEY, alive: false }),
    reads: () => vi.mocked(transport.get).mock.calls.filter(([key]) => key === LIFECYCLE_KEY),
    commands: () => vi.mocked(transport.get).mock.calls.filter(([key]) => key.endsWith("/change_state")),
    finishStop() {
      expect(finishCommand).toBeDefined();
      setLifecycle("inactive");
      publish(snapshot("inactive"));
      finishCommand?.([{ keyexpr: `${LIFECYCLE_KEY}/change_state`, payload: encode({
        ok: true, state: "inactive", descriptor: lifecycle,
        session: { files: ["cam0-0.mkv"], frames: 30, truncated: false },
      }) }]);
      finishCommand = undefined;
    },
    offline: () => tokenHandlers.get(HEALTH_PATTERN)?.({ keyexpr: KEY, alive: false }),
  };
}

const widget: PreflightWidgetConfig = {
  type: "preflight", display: "pills", poll_s: 3,
  groups: [{ label: "Cameras", checks: [{ type: "camera_recording", service: "cam0", label: "Camera" }] }],
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
let client: VehicleStateClient;
let server: VehicleStateServer;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  client.close();
  server.close();
  vi.useRealTimers();
});

function mount(options: Parameters<typeof nativeCamera>[0] & { controls?: boolean } = {}) {
  const camera = nativeCamera(options);
  const resolver: SchemaResolver = { resolve: vi.fn(async () => { throw new Error("Native health needs no ROS decoder"); }) };
  const health = new HealthHub(camera.transport, resolver);
  server = new VehicleStateServer({ store: new FakeStore(), health });
  const browser = new LoopbackTransport(server);
  const transport: Transport = {
    ...camera.transport,
    get: (key, opts) => key.startsWith("fleet/vehicle1/dash/") ? browser.get(key, opts) : camera.transport.get(key, opts),
  };
  client = new VehicleStateClient({ transport, base: "fleet/vehicle1/dash/main/state" });
  render(
    <TransportCtx.Provider value={{ transport, status: "connected", error: "", locator: "test" }}>
      <VehicleStateCtx.Provider value={{ enabled: true, client }}>
        <TopicSourceCtx.Provider value="vehicle">
          <RosGraphCtx.Provider value={{ graph: EMPTY_GRAPH, resolver: null, store: null }}>
            <LifecycleProvider>
              <HealthProvider><PreflightWidget widget={{ ...widget, recording_controls: options.controls }} /></HealthProvider>
            </LifecycleProvider>
          </RosGraphCtx.Provider>
        </TopicSourceCtx.Provider>
      </VehicleStateCtx.Provider>
    </TransportCtx.Provider>,
  );
  return { camera, browser, health };
}

it("discovers native camera health through vehicle state and follows recording transitions and silence", async () => {
  const { camera, browser } = mount();
  expect(screen.getByRole("button", { name: "Camera: No health report" })).toBeTruthy();
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Recording" }).className).toContain("ok");
  // useVehicleHealth first requests the index, then expands its view with the discovered camera.
  const views = browser.calls.filter((call) => call.op === "view").map((call) => call.body);
  expect(views).toHaveLength(2);
  expect(views[1]).toMatchObject({ items: [{ health: "*" }, { health: KEY }] });
  expect(camera.transport.get).toHaveBeenCalledWith(KEY);

  act(() => camera.publish(snapshot("inactive")));
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Camera up, not recording" }).className).toContain("warn");
  await advance(6000);
  expect(screen.getByRole("button", { name: "Camera: Health reporter silent" }).className).toContain("err");
  act(() => camera.publish(snapshot()));
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Recording" }).className).toContain("ok");
  act(() => camera.offline());
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Service offline" }).className).toContain("err");
});

it("keeps unchanged native heartbeats fresh beyond the health timeout", async () => {
  const { camera } = mount();
  await advance(500);
  for (let i = 0; i < 8; i++) {
    await advance(1000);
    act(() => camera.publish()); // Identical payload: fresh receipt alone must propagate.
    await advance(250);
    expect(screen.getByRole("button", { name: "Camera: Recording" }).className).toContain("ok");
  }
});

async function stopAndFinalize(camera: ReturnType<typeof nativeCamera>) {
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await advance(0);
  const commands = camera.commands();
  expect(commands).toHaveLength(1);
  expect(commands[0][0]).toBe(`${LIFECYCLE_KEY}/change_state`);
  expect(JSON.parse(new TextDecoder().decode(commands[0][1]?.payload))).toEqual({ transition: "deactivate" });
  expect(commands[0][1]?.timeoutMs).toBe(20_000);
  expect(screen.getByRole("group", { name: "Recording controls" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "Camera: Recording" })).toBeTruthy();
  act(() => camera.finishStop());
  await advance(500);
  expect(screen.getByRole("group", { name: "Recording controls" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByRole("button", { name: "Recording issues" })).toBeNull();
  expect(screen.getByRole("button", { name: "Camera: Camera up, not recording" }).className).toContain("warn");
  expect(camera.commands()).toHaveLength(1);
}

it("recovers a lost final lifecycle publication before stopping the recording through its real control path", async () => {
  const { camera } = mount({ initialState: "activating", controls: true });
  await advance(500);
  expect(camera.reads()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Camera: Recording" })).toBeTruthy();
  camera.setLifecycle("active", false); // Final publication lost; only a descriptor refresh can recover it.
  for (let i = 0; i < 15; i++) {
    act(() => camera.publish());
    await advance(1000);
  }
  expect(camera.reads()).toHaveLength(2);
  await stopAndFinalize(camera);
});

it("retries a failed initial lifecycle descriptor read so the recording can be stopped", async () => {
  const { camera } = mount({ failFirstDescriptor: true, controls: true });
  await advance(500);
  expect(camera.reads()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Camera: Recording" })).toBeTruthy();
  await advance(2000);
  expect(camera.reads()).toHaveLength(2);
  await stopAndFinalize(camera);
});

it("retains withdrawn vehicle health without making the current camera ambiguous or blocking Stop", async () => {
  const { camera, health } = mount({ controls: true });
  await advance(500);
  act(() => camera.announcePrevious());
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Ambiguous health service" })).toBeTruthy();
  act(() => camera.withdrawPrevious());
  await advance(500);
  expect(screen.getByRole("button", { name: "Camera: Recording" }).className).toContain("ok");
  expect(health.list()).toHaveLength(2);
  expect(health.list().find(s => s.key === RETIRED_KEY)?.alive).toBe(false);
  const retained = client.acquire({ health: RETIRED_KEY });
  expect(client.getSnapshot(retained.key)?.health?.alive).toBe(false);
  retained.release();
  await stopAndFinalize(camera);
  expect(health.list().find(s => s.key === RETIRED_KEY)?.alive).toBe(false);
});
