// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { health, renderWith } from "../test/harness";
import { TransportCtx } from "../transport/TransportContext";
import { HealthWidget } from "../home/widgets/HealthWidget";
import { diagnosticStatuses } from "./diagnostics";
import { HealthTab } from "./HealthTab";
import type { HealthService } from "./types";

vi.mock("../rig/RigContext", () => ({ useRigContext: () => ({ agents: [] }) }));
afterEach(() => { cleanup(); localStorage.clear(); });

// Exercise the same string KeyValue payloads Doodle publishes, through the ROS adapter.
function doodle(radio: Record<string, string | undefined> = {}, control: Record<string, string | undefined> = {},
  over: Partial<HealthService> = {}) {
  const service = health("mesh", {}, { source: "ros2", sourceLabel: "ROS /diagnostics" });
  const row = (component: string, values: Record<string, string | undefined>) => ({
    name: `mesh: ${component}`, level: 0, message: "OK", hardware_id: "Mesh Rider",
    values: Object.entries({ "health.service": "doodle", "health.instance": "mesh", "health.vehicle_id": "1",
      "health.availability": "current", "health.sample_age_s": "0", "health.stale_after_s": "15", ...values })
      .filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value })),
  });
  return { ...service, snapshot: { ...service.snapshot, service: "doodle", status: diagnosticStatuses({ status: [
    row("service", { "rf.target": "low", "rf.target_dbm": "23", "rf.tx_power_dbm": "23", "rf.state": "on",
      "rf.converged": "false", ...control }),
    row("radio", { "rf.tx_power_dbm": "27", "rf.state": "on", ...radio }),
  ] }) }, ...over };
}

const widget = <HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} />;
const readout = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}:`) });
const value = (label: string) => readout(label).querySelector(".row-value")?.textContent;

describe("radio health diagnostics", () => {
  it.each([['Home', widget], ['compact panel', <HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} compact />], ['Health tab', <HealthTab />]])(
    "shows observed TX power, target and RF state in %s", (_name, view) => {
      renderWith(view, { healths: [doodle()] });
      expect(value("TX power")).toBe("27 dBm");
      expect(value("Target")).toBe("low (23 dBm)");
      expect(value("RF state")).toBe("On");
      expect(document.querySelectorAll(".health-radio-metrics .health-summary-metric")).toHaveLength(3);
      fireEvent.focus(readout("Target"));
      expect(screen.getByRole("tooltip").textContent).toContain("rf.convergedfalse");
      expect(screen.getByRole("tooltip").textContent).toContain("rf.target_dbm23 dBm");
    });

  it("shows RF off without resurrecting the service component's old TX power", () => {
    renderWith(widget, { healths: [doodle({ "rf.state": "off", "rf.tx_power_dbm": undefined }, { "rf.target": "off", "rf.target_dbm": "null" })] });
    expect(value("TX power")).toBe("—");
    expect(readout("TX power").textContent).toContain("RF off");
    expect(readout("TX power").textContent).not.toContain("unavailable");
    expect(value("Target")).toBe("off");
    expect(value("RF state")).toBe("Off");
  });

  it.each(["null", "NaN", "Infinity", "true", "", undefined])("leaves invalid or missing TX power %s unavailable", (power) => {
    renderWith(widget, { healths: [doodle({ "rf.tx_power_dbm": power })] });
    expect(value("TX power")).toBe("—");
    expect(readout("TX power").textContent).toContain("unavailable");
    expect(value("RF state")).toBe("On");
  });

  it("preserves zero and avoids duplicating an explicit dBm target", () => {
    renderWith(widget, { healths: [doodle({ "rf.tx_power_dbm": "0" }, { "rf.target": "0 dBm", "rf.target_dbm": "0" })] });
    expect(value("TX power")).toBe("0 dBm");
    expect(value("Target")).toBe("0 dBm");
  });

  it.each(["unchanged", "standby", "high"])("keeps an unresolved %s target readable", (target) => {
    renderWith(widget, { healths: [doodle({}, { "rf.target": target, "rf.target_dbm": "null" })] });
    expect(value("Target")).toBe(target);
  });

  it("shows missing target and unknown RF state without inventing values", () => {
    renderWith(widget, { healths: [doodle({ "rf.state": "null" }, { "rf.target": "null", "rf.target_dbm": "null" })] });
    expect(value("RF state")).toBe("—");
    expect(value("Target")).toBe("—");
    expect(value("TX power")).toBe("27 dBm");
  });

  it.each([
    { "health.availability": "retrying" },
    { "health.availability": "stale" },
    { "health.sample_age_s": "20" },
  ])("marks old radio observations last known independently of the target (%j)", (quality) => {
    renderWith(widget, { healths: [doodle(quality)] });
    expect(value("TX power")).toBe("27 dBm");
    expect(readout("TX power").className).toContain("idle");
    expect(readout("RF state").textContent).toContain("last known");
    expect(readout("Target").className).toContain("ok");
  });

  it("keeps a stale target separate from a fresh radio sample", () => {
    renderWith(widget, { healths: [doodle({}, { "health.sample_age_s": "20" })] });
    expect(readout("Target").textContent).toContain("last known");
    expect(readout("TX power").className).toContain("ok");
  });

  it.each([{ alive: false }, { receivedAtMs: Date.now() - 20_000 }])("dims all readings when the reporter stops (%j)", (over) => {
    renderWith(widget, { healths: [doodle({}, {}, over)] });
    for (const label of ["TX power", "Target", "RF state"]) expect(readout(label).textContent).toContain("last known");
  });

  it("marks disconnected readings last known without changing the producer verdict", () => {
    renderWith(<TransportCtx.Provider value={{ transport: null, status: "reconnecting", error: "", locator: "test" }}>
      {widget}</TransportCtx.Provider>, { healths: [doodle()] });
    for (const label of ["TX power", "Target", "RF state"]) expect(readout(label).className).toContain("idle");
    expect(document.querySelector(".health-verdict")?.textContent).toBe("last known OK");
  });

  it("respects component filters and supports a service-only reporter", () => {
    const view = renderWith(<HealthWidget widget={{ type: "health", history_s: 0, precision: 1, components: ["radio"] }} />, { healths: [doodle()] });
    expect(value("TX power")).toBe("27 dBm");
    expect(screen.queryByRole("button", { name: /^Target:/ })).toBeNull();
    view.unmount();
    renderWith(<HealthWidget widget={{ type: "health", history_s: 0, precision: 1, components: ["service"] }} />, { healths: [doodle()] });
    expect(value("TX power")).toBe("23 dBm");
    expect(value("Target")).toBe("low (23 dBm)");
  });
});
