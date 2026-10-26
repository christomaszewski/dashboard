// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { health } from "../test/harness";
import { diagnosticStatuses } from "./diagnostics";
import { parseHealthOptions } from "./config";
import { isRadioService, radioLink, radioNumber } from "./radioLink";
import type { HealthService } from "./types";

// Doodle publishes through ROS diagnostics, so every value arrives as a string.
function radio(components: Record<string, Record<string, string>>, over: Partial<HealthService> = {}): HealthService {
  const base = health("mesh", {}, { source: "ros2", sourceLabel: "ROS /diagnostics" });
  const status = diagnosticStatuses({
    status: Object.entries(components).map(([component, values]) => ({
      name: `mesh: ${component}`, level: 0, message: "OK", hardware_id: "",
      values: Object.entries({ "health.instance": "mesh", "health.vehicle_id": "1", "health.availability": "current",
        "health.sample_age_s": "0", "health.stale_after_s": "15", ...values }).map(([key, value]) => ({ key, value })),
    })),
  });
  return { ...base, snapshot: { ...base.snapshot, service: "doodle", status }, ...over };
}
const now = Date.now();

describe("radio link strength and interference", () => {
  it("reads Doodle's per-peer RSSI and the noise floor: SNR from signal minus noise", () => {
    const link = radioLink(radio({
      radio: { "rf.state": "on", "rf.tx_power_dbm": "23", "rf.noise_dbm": "-94.3", "rf.channel_activity_pct": "12" },
      links: { "links.stations": "1", "links.mesh_nodes": "0" },
      "link/aa:bb:cc:00:00:01": { "link.present": "true", "link.rssi": "-62" },
    }), now)!;
    expect(link.peer?.id).toBe("aa:bb:cc:00:00:01");
    expect(link.chosen).toBe("strongest");
    expect(link.snrDb).toBeCloseTo(32.3);
    expect([link.bars, link.basis]).toEqual([4, "snr"]);
    expect([link.noiseLevel, link.busyLevel, link.interference]).toEqual(["low", "low", "low"]);
    expect([link.txPowerDbm, link.stations, link.meshNodes, link.current]).toEqual([23, 1, 0, true]);
  });

  it("prefers the vendor-neutral keys and a reported SNR", () => {
    const link = radioLink(radio({
      radio: { "rf.noise_dbm": "-95" },
      "link/p1": { "link.present": "true", "link.signal_dbm": "-75", "link.rssi": "-40", "link.snr_db": "14", "link.loss_pct": "2.5" },
    }), now)!;
    expect([link.peer?.signalDbm, link.snrDb, link.bars, link.peer?.lossPct]).toEqual([-75, 14, 2, 2.5]);
  });

  it("picks the strongest peer in the report, ignoring departed ones", () => {
    const link = radioLink(radio({
      radio: { "rf.noise_dbm": "-95" },
      "link/near": { "link.present": "false", "link.rssi": "-40" },
      "link/weak": { "link.present": "true", "link.rssi": "-88" },
      "mesh/strong": { "mesh.present": "true", "mesh.rssi": "-70" },
    }), now)!;
    expect(link.peer?.id).toBe("strong");
    expect(link.peers.map((p) => p.id)).toEqual(["strong", "weak"]);
    expect(link.bars).toBe(3); // 25 dB SNR
  });

  it("follows a configured peer, and calls it no link when that peer is not heard", () => {
    const peers = { "link/ground": { "link.present": "true", "link.rssi": "-85" }, "link/relay": { "link.present": "true", "link.rssi": "-50" } };
    const configured = radioLink(radio(peers), now, { peer: "GROUND" })!;
    expect([configured.peer?.id, configured.chosen, configured.bars, configured.basis]).toEqual(["ground", "configured", 1, "signal"]);
    const missing = radioLink(radio({ ...peers, "link/ground": { "link.present": "false" } }), now, { peer: "ground" })!;
    expect([missing.peer, missing.missingPeer, missing.bars]).toEqual([null, true, 0]);
  });

  it("shows zero bars when the radio reports links but none are in range, or its transmitter is off", () => {
    expect(radioLink(radio({ links: { "links.stations": "0", "links.mesh_nodes": "0" } }), now)!.bars).toBe(0);
    const off = radioLink(radio({ radio: { "rf.state": "off" }, "link/p": { "link.present": "true", "link.rssi": "-50" } }), now)!;
    expect([off.rfOff, off.bars]).toEqual([true, 0]);
  });

  it("has no strength to show when the radio reports only RF state", () => {
    const link = radioLink(radio({ radio: { "rf.state": "on", "rf.noise_dbm": "-79" } }), now)!;
    expect([link.bars, link.interference]).toEqual([null, "high"]);
  });

  it("rates interference by the worse of noise floor and channel busy time", () => {
    const at = (noise: string, busy: string) => radioLink(radio({ radio: { "rf.noise_dbm": noise, "rf.channel_activity_pct": busy } }), now)!;
    expect(at("-85", "10").interference).toBe("moderate");
    expect(at("-95", "90").interference).toBe("high");
    expect(at("-95", "60").interference).toBe("moderate");
    expect(at("-95", "10").interference).toBe("low");
    expect(radioLink(radio({ radio: { "rf.noise_dbm": "-85" } }), now, { noise_dbm: [-80, -70] })!.interference).toBe("low");
  });

  it("uses link quality when a mesh reports only BATMAN TQ, and a summary on links for one-link radios", () => {
    const mesh = radioLink(radio({ "mesh/n1": { "mesh.present": "true", "mesh.tq": "204" } }), now)!;
    expect([mesh.peer?.qualityPct, mesh.bars, mesh.basis]).toEqual([80, 4, "quality"]);
    const single = radioLink(radio({ links: { "links.signal_dbm": "-68", "links.peer": "base" } }), now)!;
    expect([single.peer?.id, single.peer?.kind, single.bars, single.basis]).toEqual(["base", "links", 3, "signal"]);
  });

  it("marks a silent reporter, a retrying poll or a disconnected dashboard as not current", () => {
    const peers = { radio: { "rf.noise_dbm": "-95" }, "link/p": { "link.present": "true", "link.rssi": "-60" } };
    expect(radioLink(radio(peers), now, {}, false)!.current).toBe(false);
    expect(radioLink(radio(peers, { alive: false }), now)!.current).toBe(false);
    const retrying = radio({ radio: { "rf.noise_dbm": "-95", "health.availability": "retrying" }, "link/p": { "link.present": "true", "link.rssi": "-60" } });
    expect(radioLink(retrying, now)!.current).toBe(false);
  });

  it("is not a radio without radio keys or link components; rejects implausible numbers", () => {
    expect(isRadioService(health("cam0", { camera: { values: { "temp.sensor_c": 40 } } }))).toBe(false);
    expect(radioLink(health("cam0", { camera: { values: { "temp.sensor_c": 40 } } }), now)).toBeNull();
    for (const bad of ["", "NaN", "true", "-6 2", "Infinity"]) expect(radioNumber(bad)).toBeUndefined();
    expect(radioNumber(" -61.5 ")).toBe(-61.5);
    // An RSSI on a vendor scale (positive) is not a dBm reading.
    expect(radioLink(radio({ "link/p": { "link.present": "true", "link.rssi": "60" } }), now)!.basis).toBeNull();
  });
});

describe("health.radio options", () => {
  it("accepts services, a peer, header and ascending thresholds", () => {
    expect(parseHealthOptions({ radio: { services: ["1/mesh"], peer: "aa:bb", header: false, snr_db: [3, 10, 18, 25], busy_pct: [40, 70] } })?.radio)
      .toEqual({ services: ["1/mesh"], peer: "aa:bb", header: false, snr_db: [3, 10, 18, 25], busy_pct: [40, 70] });
    expect(parseHealthOptions({ ros_topics: ["/diagnostics"] })?.radio).toBeUndefined();
  });

  it.each([
    [{ radio: { snr_db: [10, 5, 20, 30] } }, /ascending/],
    [{ radio: { noise_dbm: [-90] } }, /2 ascending/],
    [{ radio: { peer: "" } }, /peer/],
    [{ radio: { colour: "red" } }, /unknown health.radio.colour/],
    [{ radio: [] }, /mapping/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseHealthOptions(raw)).toThrow(message);
  });
});
