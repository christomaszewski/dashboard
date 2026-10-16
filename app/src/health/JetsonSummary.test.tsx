// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { health, renderWith } from "../test/harness";
import { HealthWidget } from "../home/widgets/HealthWidget";
import { buildGraph } from "../ros/graph";
import { buildRos2StaticDecoder } from "../schema/decoders/staticDefs";
import type { Transport } from "../transport/types";
import { TransportCtx } from "../transport/TransportContext";
import { HealthDiscovery } from "./discovery";
import { diagnosticStatuses } from "./diagnostics";
import { HealthTab } from "./HealthTab";
import { statusCurrent, type HealthService } from "./types";
import fixture from "./jetson-fixture.json";

vi.mock("../rig/RigContext", () => ({ useRigContext: () => ({ agents: [] }) }));
afterEach(() => { cleanup(); localStorage.clear(); });

async function jetson() {
  // Actual rclpy serialization, not a hand-written approximation of CDR byte fields.
  const decoder = await buildRos2StaticDecoder(fixture.type);
  const message = decoder.decode(Uint8Array.from(atob(fixture.diagnostics), (c) => c.charCodeAt(0)));
  expect(decoder.lastWarning?.()).toBeUndefined();
  const service = health("jetson", {}, { vehicleId: "veh1", source: "ros2", sourceLabel: "ROS /diagnostics" });
  service.snapshot = { ...service.snapshot, service: "jetson-manager", status: diagnosticStatuses(message) };
  return { service, message };
}

const widget = <HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} />;
const profile = () => screen.getByRole("button", { name: /^Power profile:/ });
const mode = (service: HealthService) => service.snapshot.status.find((s) => s.name === "jetson: power_mode")!;

describe("Jetson ROS health", () => {
  it.each([["Home", widget], ["compact panel", <HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} compact />], ["Health tab", <HealthTab />]])(
    "shows real producer temperatures and observed power profile in %s", async (_name, view) => {
      const { service } = await jetson();
      renderWith(view, { healths: [service] });
      for (const name of ["CPU", "GPU", "SOC0", "Tj"]) {
        const reading = screen.getByRole("button", { name: new RegExp(`^${name} temperature:`) });
        expect(reading.textContent).toContain("°C");
        expect(reading.textContent).not.toContain("last known");
      }
      expect(profile().textContent).toContain("MODE_30W (id 2)");
      fireEvent.focus(profile());
      expect(screen.getByRole("tooltip").textContent).toContain("Observed nvpmodel setting");
    });

  it("routes serialized diagnostics to the correct fleet identity and temperature history", async () => {
    const { message } = await jetson();
    const transport = { liveliness: { subscribe: vi.fn(async () => ({ close: vi.fn() })) },
      subscribe: vi.fn(async () => ({ close: vi.fn() })) } as unknown as Transport;
    const discovery = new HealthDiscovery(transport);
    let services: HealthService[] = [];
    await discovery.start((s) => { services = s; });
    try {
      const topic = buildGraph(["@ros2_lv/0/z/1/2/MP/%/%/reporter/%diagnostics/diagnostic_msgs::msg::dds_::DiagnosticArray_/hash/::,10::::"]).topics[0];
      discovery.ingestRos(topic, message);
      expect(services).toHaveLength(1);
      const service = services[0];
      expect(service.key).toBe("fleet/veh1/svc/jetson/health");
      expect(service.snapshot.service).toBe("jetson-manager");
      expect(mode(service).values["power.mode_id"]).toBe(2);
      expect(statusCurrent(service, mode(service), Date.now())).toBe(true);
      expect(discovery.series(service.key, "jetson: temperature/CPU", "temp.CPU_c")).toHaveLength(1);
    } finally { await discovery.stop(); }
  });

  it("shows the observed mode during a switch, not the requested target; preserves mode zero", async () => {
    const { service } = await jetson();
    Object.assign(mode(service).values, { "power.switching": true, "power.target_name": "MODE_50W",
      "power.mode_name": "MAXN", "power.mode_id": 0 });
    renderWith(widget, { healths: [service] });
    expect(profile().textContent).toContain("MAXN (id 0)");
    expect(profile().textContent).toContain("switching");
    expect(profile().textContent).not.toContain("MODE_50W");
  });

  it.each(["", "null"])("leaves unavailable profile %s as a dash, never a guessed mode", async (name) => {
    const { service } = await jetson();
    mode(service).values["power.mode_name"] = name;
    renderWith(widget, { healths: [service] });
    expect(profile().querySelector(".row-value")?.textContent).toBe("—");
    expect(profile().textContent).toContain("unavailable");
  });

  it.each([
    { "health.availability": "stale" }, { "health.availability": "retrying" },
    { "health.sample_age_s": 10 }, { "health.metric.power.mode_name.state": "unavailable" },
  ])("labels a stale power profile last known independently of fresh temperatures (%j)", async (values) => {
    const { service } = await jetson();
    Object.assign(mode(service).values, values);
    renderWith(widget, { healths: [service] });
    expect(profile().textContent).toContain("MODE_30W (id 2)");
    expect(profile().textContent).toContain("last known");
    expect(screen.getByRole("button", { name: /^CPU temperature:/ }).textContent).not.toContain("last known");
  });

  it("dims the profile on disconnect without inventing a hardware fault", async () => {
    const { service } = await jetson();
    renderWith(<TransportCtx.Provider value={{ transport: null, status: "reconnecting", error: "", locator: "test" }}>
      {widget}</TransportCtx.Provider>, { healths: [service] });
    expect(profile().textContent).toContain("last known");
  });

  it("respects component filtering", async () => {
    const { service } = await jetson();
    renderWith(<HealthWidget widget={{ type: "health", history_s: 0, precision: 1, components: ["temperature/CPU"] }} />, { healths: [service] });
    expect(screen.queryByRole("button", { name: /^Power profile:/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^CPU temperature:/ })).toBeTruthy();
  });
});
