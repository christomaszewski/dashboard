import { describe, expect, it } from "vitest";
import type { HealthService } from "../health/types";
import { applyHealthUpdate, healthFromWire, healthStructureSignature, healthToWire, type HealthUpdate } from "./healthWire";

function service(): HealthService {
  return {
    key: "fleet/rig/svc/cam/health", vehicleId: "rig", instance: "cam", alive: true,
    source: "native", receivedAtMs: 10_000, receivedMonoMs: 500, periodMs: 1000,
    snapshot: { schema_version: 1, service: "camera-service", instance: "cam", stamp_unix_ns: 123, level: 0,
      status: [
        { name: "cam: camera", hardware_id: "serial", message: "ready", level: 0,
          receivedAtMs: 10_000, receivedMonoMs: 500,
          values: { "health.sample_id": 1, "health.sample_age_s": 0, frames: 20, optional: "present" } },
        { name: "cam: recorder", hardware_id: "", message: "idle", level: 0,
          receivedAtMs: 9000, receivedMonoMs: -500, values: { "alerts.log": "[]" } },
      ] },
  };
}

function update(): HealthUpdate {
  return { b: 3, c: 8, stamp: 456, level: 1, age: 10, sa: [10, 2010], periodMs: 1000,
    status: [[0, { level: 1, message: "warming", values: { frames: 30, optional: null, "health.sample_id": 2 } }]] };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("sparse health wire", () => {
  it("reconstructs changed scalars and complete observation clocks without mutating previous snapshots", () => {
    const base = freeze({ ...healthToWire(service(), 7, 3), age: 2, sa: [2, 1002] });
    const patch = freeze(update());
    const merged = applyHealthUpdate(base, patch)!;
    expect(merged.s.snapshot.status[0]).toMatchObject({ level: 1, message: "warming",
      values: { frames: 30, optional: null, "health.sample_id": 2, "health.sample_age_s": 0 } });
    expect(merged.s.snapshot.status[1]).toEqual(base.s.snapshot.status[1]);
    expect(merged.s.snapshot).toMatchObject({ stamp_unix_ns: 456, level: 1 });
    expect(merged).toMatchObject({ b: 3, c: 8, age: 10, sa: [10, 2010] });
    const decoded = healthFromWire(merged, 30_000, 5000);
    expect(decoded.receivedMonoMs).toBe(4990);
    expect(decoded.snapshot.status.map((s) => s.receivedMonoMs)).toEqual([4990, 2990]);
    expect(base.s.snapshot.status[0].values.frames).toBe(20);
    expect(base.s.snapshot.status[0].values.optional).toBe("present");
    expect(base.s.snapshot.stamp_unix_ns).toBe(123);
    expect(base.sa).toEqual([2, 1002]);
  });

  it("replaces optional metadata instead of retaining old ages or periods", () => {
    const base = { ...healthToWire(service(), 7, 3), age: 100, sa: [100, 300] };
    const merged = applyHealthUpdate(base, { b: 3, c: 7, stamp: 789, level: 0 })!;
    expect(merged).not.toHaveProperty("age");
    expect(merged).not.toHaveProperty("sa");
    expect(merged.s).not.toHaveProperty("periodMs");
    expect(healthFromWire(merged, 30_000, 5000).snapshot.status[0]).not.toHaveProperty("receivedMonoMs");
  });

  it.each([
    null, [], {}, { b: 2 }, { b: 0 }, { b: 3.5 }, { c: 6 }, { c: -1 }, { c: 8.5 },
    { c: Number.MAX_SAFE_INTEGER + 1 }, { stamp: NaN }, { stamp: "456" }, { level: 4 },
    { age: -1 }, { age: Infinity }, { periodMs: -1 }, { sa: [0] }, { sa: [0, -1] }, { sa: [0, "1"] },
    { status: {} }, { status: [[-1, {}]] }, { status: [[2, {}]] }, { status: [[0.5, {}]] },
    { status: [[0, {}], [0, {}]] }, { status: [[0, {}, "extra"]] }, { status: [[0, null]] },
    { status: [[0, { hardware_id: "changed" }]] }, { status: [[0, { level: 4 }]] },
    { status: [[0, { message: 1 }]] }, { status: [[0, { values: [] }]] },
    { status: [[0, { values: { new_key: 1 } }]] }, { status: [[0, { values: { frames: Infinity } }]] },
    { status: [[0, { values: { frames: { nested: true } } }]] },
  ])("rejects malformed or incompatible deltas (%j)", (bad) => {
    const base = healthToWire(service(), 7, 3);
    const candidate = bad === null || Array.isArray(bad) || (typeof bad === "object" && Object.keys(bad).length === 0)
      ? bad : { ...update(), ...bad };
    expect(applyHealthUpdate(base, candidate as HealthUpdate)).toBeNull();
  });

  it("cannot apply a delta to a legacy full snapshot", () => {
    expect(applyHealthUpdate(healthToWire(service(), 7), update())).toBeNull();
  });
});

describe("health baseline structure", () => {
  it("ignores observation clocks and content covered by sparse updates", () => {
    const original = service();
    const changed = service();
    changed.receivedAtMs += 1000;
    changed.receivedMonoMs! += 1000;
    delete changed.periodMs;
    changed.snapshot.stamp_unix_ns++;
    changed.snapshot.level = 2;
    const row = changed.snapshot.status[0];
    row.receivedAtMs! += 1000;
    row.receivedMonoMs! += 1000;
    row.level = 2;
    row.message = "error";
    row.values.frames = 500;
    row.values.optional = null;
    row.values = Object.fromEntries(Object.entries(row.values).reverse());
    expect(healthStructureSignature(changed)).toBe(healthStructureSignature(original));
  });

  it.each<(s: HealthService) => void>([
    (s) => { s.alive = false; },
    (s) => { s.source = "ros2"; },
    (s) => { s.sourceLabel = "ROS diagnostics"; },
    (s) => { s.fallbackTtlMs = 5000; },
    (s) => { s.vehicleId = "other"; },
    (s) => { s.instance = "other"; },
    (s) => { s.key = "fleet/rig/svc/other/health"; },
    (s) => { s.snapshot.schema_version++; },
    (s) => { s.snapshot.service = "other-service"; },
    (s) => { s.snapshot.instance = "other"; },
    (s) => { s.snapshot.status[0].name = "cam: sensor"; },
    (s) => { s.snapshot.status[0].hardware_id = "replacement"; },
    (s) => { s.snapshot.status[0].values.extra = null; },
    (s) => { delete s.snapshot.status[0].values.optional; },
    (s) => { s.snapshot.status.reverse(); },
    (s) => { s.snapshot.status.pop(); },
  ])("requires a full baseline when identity, layout, or value keys change", (change) => {
    const changed = service();
    change(changed);
    expect(healthStructureSignature(changed)).not.toBe(healthStructureSignature(service()));
  });
});
