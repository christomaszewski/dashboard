import { describe, expect, it } from "vitest";
import {
  componentOf,
  healthVerdict,
  parseHealthKey,
  parseHealthSnapshot,
  selectStatuses,
  staleAfterMs,
  temperatureWhere,
  temperatures,
  type HealthService,
} from "./types";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

// camera-service docs/HEALTH.md's example, verbatim in shape (a Boson with a lossy stream).
const BOSON = {
  schema_version: 1,
  service: "camera-service",
  instance: "cam_thermal",
  stamp_unix_ns: 1759200000000000000,
  level: 1,
  status: [
    {
      level: 0,
      name: "cam_thermal: camera",
      message: "41.2 C",
      hardware_id: "FLIR Boson sn 123",
      values: { "temp.sensor_c": 41.2, uptime_s: 5231 },
    },
    {
      level: 1,
      name: "cam_thermal: stream",
      message: "3 frame(s) lost in the last 10s",
      hardware_id: "",
      values: { "fps.delivered": 59.9, source_gaps: 1 },
    },
  ],
};

function service(over: Partial<HealthService> = {}): HealthService {
  return {
    key: "fleet/veh1/svc/cam_thermal/health",
    vehicleId: "veh1",
    instance: "cam_thermal",
    snapshot: parseHealthSnapshot(enc(BOSON))!,
    alive: true,
    receivedAtMs: 100_000,
    periodMs: 1000,
    ...over,
  };
}

describe("parseHealthKey", () => {
  it("accepts exactly fleet/<vehicle>/svc/<instance>/health", () => {
    expect(parseHealthKey("fleet/veh1/svc/cam0/health")).toEqual({ vehicleId: "veh1", instance: "cam0" });
  });

  it("rejects the state sub-key, other planes, and empty segments", () => {
    expect(parseHealthKey("fleet/veh1/svc/cam0/health/state")).toBeNull();
    expect(parseHealthKey("fleet/veh1/svc/cam0/lifecycle")).toBeNull();
    expect(parseHealthKey("fleet/veh1/media/cam0")).toBeNull();
    expect(parseHealthKey("fleet//svc/cam0/health")).toBeNull();
    expect(parseHealthKey("fleet/veh1/svc//health")).toBeNull();
  });
});

describe("parseHealthSnapshot", () => {
  it("reads the contract's snapshot", () => {
    const snap = parseHealthSnapshot(enc(BOSON))!;
    expect(snap.instance).toBe("cam_thermal");
    expect(snap.level).toBe(1);
    expect(snap.status.map((s) => s.name)).toEqual(["cam_thermal: camera", "cam_thermal: stream"]);
    expect(snap.status[0].values["temp.sensor_c"]).toBe(41.2);
    expect(snap.status[0].hardware_id).toBe("FLIR Boson sn 123");
  });

  it("rejects non-JSON, non-objects, a missing status list, and a schema it does not read", () => {
    expect(parseHealthSnapshot(new TextEncoder().encode("{nope"))).toBeNull();
    expect(parseHealthSnapshot(enc([BOSON]))).toBeNull();
    expect(parseHealthSnapshot(enc({ ...BOSON, status: undefined }))).toBeNull();
    expect(parseHealthSnapshot(enc({ ...BOSON, instance: 7 }))).toBeNull();
    expect(parseHealthSnapshot(enc({ ...BOSON, schema_version: 2 }))).toBeNull();
  });

  it("drops a malformed status and non-scalar values without losing the rest", () => {
    const snap = parseHealthSnapshot(
      enc({
        ...BOSON,
        level: 0,
        status: [
          { level: 7, name: "cam_thermal: bogus", message: "", hardware_id: "", values: {} },
          "not a status",
          { level: 2, name: "cam_thermal: camera", values: { "temp.sensor_c": 80, nested: { a: 1 }, list: [1], gone: null } },
        ],
      }),
    )!;
    expect(snap.status).toHaveLength(1);
    expect(snap.status[0]).toMatchObject({ message: "", hardware_id: "", values: { "temp.sensor_c": 80, gone: null } });
    expect(Object.keys(snap.status[0].values)).toEqual(["temp.sensor_c", "gone"]);
    expect(snap.level).toBe(2); // recomputed from what survived, not trusted from the payload
  });
});

describe("temperatures", () => {
  it("finds every temp.<where>_c with no knowledge of the device", () => {
    expect(temperatureWhere("temp.sensor_c")).toBe("sensor");
    expect(temperatureWhere("temp.mainboard_c")).toBe("mainboard");
    expect(temperatureWhere("temp.state")).toBeNull(); // the device's verdict: a string, not a reading
    expect(temperatureWhere("uptime_s")).toBeNull();
  });

  it("lists numeric temperatures by component, in snapshot order", () => {
    const snap = parseHealthSnapshot(
      enc({
        ...BOSON,
        instance: "cam_gige",
        status: [
          {
            level: 0,
            name: "cam_gige: camera",
            message: "44.5 C",
            hardware_id: "Basler acA1920 sn 4",
            values: { "temp.sensor_c": 44.5, "temp.mainboard_c": 39, "temp.state": "Ok", "temp.fpga_c": null },
          },
          { level: 0, name: "cam_gige: stream", message: "OK", hardware_id: "", values: { "fps.delivered": 24 } },
        ],
      }),
    )!;
    expect(temperatures(snap.status, "cam_gige").map((t) => [t.component, t.where, t.celsius])).toEqual([
      ["camera", "sensor", 44.5],
      ["camera", "mainboard", 39],
    ]);
  });

  it("names components by stripping the instance prefix, and filters by them", () => {
    const snap = service().snapshot;
    expect(componentOf(snap.status[0], "cam_thermal")).toBe("camera");
    expect(componentOf(snap.status[0], "other")).toBe("cam_thermal: camera");
    expect(selectStatuses(snap, ["camera"]).map((s) => s.name)).toEqual(["cam_thermal: camera"]);
    expect(selectStatuses(snap)).toHaveLength(2);
    expect(selectStatuses(snap, [])).toHaveLength(2);
  });
});

describe("healthVerdict", () => {
  it("is the worst level of the statuses in view while snapshots keep arriving", () => {
    const s = service();
    expect(healthVerdict(s, s.snapshot.status, 100_500)).toEqual({ level: "warn", text: "WARN", current: true });
    expect(healthVerdict(s, selectStatuses(s.snapshot, ["camera"]), 100_500)).toEqual({ level: "ok", text: "OK", current: true });
  });

  it("says offline when the token is gone, before anything else", () => {
    const s = service({ alive: false });
    expect(healthVerdict(s, s.snapshot.status, 100_500)).toMatchObject({ level: "warn", text: "offline", current: false });
  });

  it("says silent once the producer misses ~3 of its own intervals (never under the floor)", () => {
    const s = service();
    expect(staleAfterMs(s)).toBe(5_000); // 3 × 1 s is under the floor
    expect(healthVerdict(s, s.snapshot.status, 104_900).current).toBe(true);
    expect(healthVerdict(s, s.snapshot.status, 107_000)).toEqual({ level: "idle", text: "silent 7s", current: false });
    const slow = service({ periodMs: 10_000 });
    expect(staleAfterMs(slow)).toBe(30_000);
    expect(healthVerdict(slow, slow.snapshot.status, 125_000).current).toBe(true);
  });

  it("maps STALE to idle: the component has no data, which is not an alarm color", () => {
    const snap = parseHealthSnapshot(
      enc({ ...BOSON, status: [{ level: 3, name: "cam_thermal: camera", message: "camera reconnecting", hardware_id: "", values: {} }] }),
    )!;
    expect(healthVerdict(service({ snapshot: snap }), snap.status, 100_500)).toEqual({ level: "idle", text: "STALE", current: true });
  });
});
