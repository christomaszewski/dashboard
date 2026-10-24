// @vitest-environment jsdom
// Home widgets on the vehicle-state path: a real client talks to a real VehicleStateServer through
// the in-process loopback transport, so the fields each widget declares are what the vehicle sees.
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_GRAPH, buildGraph } from "../ros/graph";
import { RosGraphCtx } from "../ros/RosGraphContext";
import { parseWidget } from "../config/schema";
import type { TopicValueWidgetConfig, StatusWidgetConfig } from "../config/schema";
import { TopicValueWidget } from "../home/widgets/TopicValueWidget";
import { StatusWidget } from "../home/widgets/StatusWidget";
import { GaugeWidget } from "../home/widgets/primitives/GaugeWidget";
import type { GaugeWidgetConfig } from "../home/widgets/primitives/specs";
import { VehicleStateClient } from "./client";
import { VehicleStateServer } from "./server";
import { FakeStore, LoopbackTransport } from "./testkit";
import { VehicleStateCtx, WidgetTopicSource, type VehicleStateValue } from "./VehicleStateContext";

const BATTERY = "@ros2_lv/0/z/1/1/MP/%/%/bms/%battery/sensor_msgs::msg::dds_::BatteryState_/RIHS01_aa/2:2:1,10";
const batteryKey = buildGraph([BATTERY]).topics[0].dataKeyexpr;

let store: FakeStore;
let server: VehicleStateServer;
let link: LoopbackTransport;
let client: VehicleStateClient;

beforeEach(() => {
  vi.useFakeTimers();
  store = new FakeStore();
  server = new VehicleStateServer({ store, epoch: "e1" });
  server.setGraph(buildGraph([BATTERY]));
  link = new LoopbackTransport(server);
  client = new VehicleStateClient({ transport: link, base: "fleet/r1/dash/d/state" });
});
afterEach(() => {
  cleanup();
  client.close();
  server.close();
  vi.useRealTimers();
});

function show(ui: ReactElement, value: Partial<VehicleStateValue> = {}, vehicle = true) {
  return render(
    <RosGraphCtx.Provider value={{ graph: EMPTY_GRAPH, resolver: null, store: null }}>
      <VehicleStateCtx.Provider value={{ enabled: true, client, ...value }}>
        <WidgetTopicSource setting={vehicle}>{ui}</WidgetTopicSource>
      </VehicleStateCtx.Provider>
    </RosGraphCtx.Provider>,
  );
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(300));
const registered = () => (link.calls.find((c) => c.op === "view")?.body as { items: unknown[] } | undefined)?.items;
const readout = (yaml: object) => parseWidget({ type: "topic_value", label: "Battery", topic: "/battery", ...yaml }) as TopicValueWidgetConfig;

describe("Home widgets on vehicle state", () => {
  it("asks for exactly the readout's field at its display precision", async () => {
    store.emit(batteryKey, { message: { voltage: 24.4567, cell_voltage: new Float32Array(12) } });
    show(<TopicValueWidget widget={readout({ field: "voltage", precision: 2, unit: "V" })} />);
    await settle();
    expect(registered()).toEqual([{ topic: "/battery", fields: [{ p: "voltage", q: 0.01 }] }]);
    expect(screen.getByText("24.46")).toBeTruthy();
    expect(screen.getByText("/battery · voltage")).toBeTruthy();
  });

  it("asks for every placeholder of a format line", async () => {
    store.emit(batteryKey, { message: { voltage: 24.4567, percentage: 0.8123 } });
    show(<TopicValueWidget widget={readout({ format: "{voltage:.1f} V · {percentage}" })} />);
    await settle();
    expect(registered()).toEqual([{ topic: "/battery", fields: [{ p: "voltage", q: 0.1 }, { p: "percentage", q: 0.001 }] }]);
    expect(screen.getByText("24.5 V · 0.812")).toBeTruthy();
  });

  it("marks a stale reading", async () => {
    store.emit(batteryKey, { message: { voltage: 24 }, lastAt: performance.now() });
    show(<TopicValueWidget widget={readout({ field: "voltage" })} />);
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    act(() => server.tick());
    await settle();
    expect(screen.getByText("/battery · voltage · stale")).toBeTruthy();
    expect(screen.getByText("24").className).toContain("stale");
  });

  it("measures a rate-only status on the vehicle and never decodes it", async () => {
    store.emit(batteryKey, { hz: 9.9 });
    const widget = parseWidget({ type: "status", label: "BMS", source: "topic_hz", topic: "/battery", min_hz: 5, window_s: 2 }) as StatusWidgetConfig;
    show(<StatusWidget widget={widget} />);
    await settle();
    expect(registered()).toEqual([{ topic: "/battery", hz: true, window_ms: 2000 }]);
    expect(store.acquired[0].opts).toEqual({ windowMs: 2000, decode: false });
    expect(screen.getByText("9.9 Hz")).toBeTruthy();
  });

  it("rounds a gauge finely enough for its arc", async () => {
    store.emit(batteryKey, { message: { percentage: 0.5 } });
    const widget = parseWidget({ type: "gauge", label: "SoC", topic: "/battery", field: "percentage", min: 0, max: 1, precision: 0 }) as GaugeWidgetConfig;
    show(<GaugeWidget widget={widget} />);
    await settle();
    expect(registered()).toEqual([{ topic: "/battery", fields: [{ p: "percentage", q: 0.001 }] }]);
  });

  it("stays on the direct path when the widget opts out", async () => {
    show(<TopicValueWidget widget={readout({ field: "voltage", vehicle_state: false })} />, {}, false);
    await settle();
    expect(link.calls).toHaveLength(0);
    expect(screen.getByText("/battery — waiting for topic")).toBeTruthy();
  });

  it("shows why vehicle state is unusable instead of waiting forever", async () => {
    show(<TopicValueWidget widget={readout({ field: "voltage" })} />, { client: null, error: "vehicle state: /config/runtime.json is missing (HTTP 404)" });
    await settle();
    expect(screen.getByText("!")).toBeTruthy();
    expect(screen.getByText(/runtime\.json is missing/)).toBeTruthy();
  });
});
