// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { health, renderWith } from "../test/harness";
import { HealthWidget } from "../home/widgets/HealthWidget";
import { diagnosticStatuses } from "./diagnostics";
import { RadioIndicators, RadioOptionsCtx } from "./RadioIndicator";
import type { RadioOptions } from "./radioLink";
import type { HealthService } from "./types";

vi.mock("../rig/RigContext", () => ({ useRigContext: () => ({ agents: [] }) }));
afterEach(() => { cleanup(); localStorage.clear(); });

function radio(instance: string, components: Record<string, Record<string, string>>): HealthService {
  const base = health(instance, {}, { source: "ros2", sourceLabel: "ROS /diagnostics" });
  const status = diagnosticStatuses({ status: Object.entries(components).map(([component, values]) => ({
    name: `${instance}: ${component}`, level: 0, message: "OK", hardware_id: "Mesh Rider",
    values: Object.entries({ "health.instance": instance, "health.vehicle_id": "1", "health.availability": "current",
      "health.sample_age_s": "0", "health.stale_after_s": "15", ...values }).map(([key, value]) => ({ key, value })),
  })) });
  return { ...base, snapshot: { ...base.snapshot, service: "doodle", status } };
}
const mesh = (rssi: string, noise = "-94", busy = "10") => radio("mesh", {
  service: { "rf.target": "low", "rf.target_dbm": "23", "rf.state": "on" },
  radio: { "rf.state": "on", "rf.tx_power_dbm": "23", "rf.noise_dbm": noise, "rf.channel_activity_pct": busy },
  links: { "links.stations": "1", "links.mesh_nodes": "0" },
  "link/aa:bb:cc:00:00:01": { "link.present": "true", "link.rssi": rssi },
});
const header = (services: HealthService[], options?: RadioOptions) =>
  renderWith(<RadioOptionsCtx.Provider value={options}><RadioIndicators /></RadioOptionsCtx.Provider>, { healths: services });
const indicator = () => screen.getByRole("button", { name: /radio:/ });
const lit = () => indicator().querySelectorAll(".radio-bars rect.on").length;

describe("the header radio indicator", () => {
  it("shows bars for the strongest peer and the numbers behind them", () => {
    header([mesh("-62")]);
    expect(indicator().getAttribute("aria-label")).toBe("mesh radio: excellent (4/4), 32 dB SNR");
    expect(lit()).toBe(4);
    expect(indicator().className).toContain("ok");
    expect(indicator().querySelector(".radio-interference")).toBeNull(); // a quiet channel shows no mark
    fireEvent.focus(indicator());
    const tip = screen.getByRole("tooltip").textContent!;
    for (const text of ["Strongest of 1 peer aa:bb:cc:00:00:01", "Signal-62 dBm", "SNR32 dB (signal − noise)", "Noise floor-94 dBm", "Channel busy10%", "Interferencelow", "TX power23 dBm", "Peers1 station(s), 0 mesh node(s)"]) {
      expect(tip).toContain(text);
    }
  });

  it("colors a weak link and marks interference", () => {
    header([mesh("-81", "-84", "85")]);
    expect(indicator().getAttribute("aria-label")).toBe("mesh radio: very weak (0/4), 3 dB SNR, high interference");
    expect(indicator().className).toContain("err");
    expect(indicator().querySelector(".radio-interference.err")).not.toBeNull();
  });

  it("dims last-known values when the reporter goes silent", () => {
    header([{ ...mesh("-62"), alive: false }]);
    expect(indicator().getAttribute("aria-label")).toMatch(/, last known$/);
    expect(indicator().className).toContain("stale");
  });

  it("is absent without a radio reporter, and when turned off or filtered out", () => {
    header([health("cam0", { camera: { values: { "temp.sensor_c": 40 } } })]);
    expect(screen.queryByRole("button", { name: /radio:/ })).toBeNull();
    cleanup();
    header([mesh("-62")], { header: false });
    expect(screen.queryByRole("button", { name: /radio:/ })).toBeNull();
    cleanup();
    header([mesh("-62")], { services: ["other"] });
    expect(screen.queryByRole("button", { name: /radio:/ })).toBeNull();
  });

  it("names each radio when there are several", () => {
    header([mesh("-62"), radio("backup", { links: { "links.stations": "0" } })]);
    const all = screen.getAllByRole("button", { name: /radio:/ });
    expect(all.map((b) => b.querySelector(".radio-name")?.textContent)).toEqual(["mesh", "backup"]);
    expect(all[1].getAttribute("aria-label")).toBe("backup radio: no peers in range");
  });

  it("says when the configured peer is not heard", () => {
    header([mesh("-62")], { peer: "aa:bb:cc:00:00:99" });
    expect(indicator().getAttribute("aria-label")).toBe("mesh radio: peer aa:bb:cc:00:00:99 not heard");
    expect(lit()).toBe(0);
  });
});

describe("radio link in the health summary", () => {
  const widget = <HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} />;
  const value = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}:`) }).querySelector(".row-value");

  it("adds Signal and Interference next to TX power", () => {
    renderWith(widget, { healths: [mesh("-70", "-86", "20")] });
    expect(value("Signal")?.textContent).toBe("fair · 16 dB SNR");
    expect(value("Signal")?.className).toContain("warn");
    expect(value("Interference")?.textContent).toBe("moderate · -86 dBm noise, 20% busy");
    expect(value("TX power")?.textContent).toBe("23 dBm");
  });
});
