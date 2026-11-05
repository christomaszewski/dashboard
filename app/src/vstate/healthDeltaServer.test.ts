import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthService, HealthStatus } from "../health/types";
import { encodeMessage, validatePollRequest, type PollReply, type PollRequest } from "./protocol";
import { VehicleStateServer, type HealthSource } from "./server";
import { FakeStore } from "./testkit";

const KEY = "fleet/r1/svc/cam0/health";
class FakeHealth implements HealthSource {
  services: HealthService[] = [];
  private listeners = new Set<() => void>();
  retain() {}
  release() {}
  list() { return this.services; }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  set(...services: HealthService[]) { this.services = services; for (const cb of this.listeners) cb(); }
}
const status = (name: string): HealthStatus => ({
  name, level: 0, message: "ok", hardware_id: "camera-serial", receivedMonoMs: 0,
  values: { "temp.sensor_c": 41, "health.sequence": 1, "health.sample_age_s": 0, "health.sample_id": "sample-1",
    ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`metric.${i}`, `stable diagnostic value ${i}`])) },
});
const service = (): HealthService => ({
  key: KEY, vehicleId: "r1", instance: "cam0", alive: true, source: "native", sourceLabel: "Zenoh JSON",
  receivedAtMs: 1_000_000, receivedMonoMs: 0, periodMs: 1000,
  snapshot: { schema_version: 1, service: "camera-service", instance: "cam0", stamp_unix_ns: 1, level: 0,
    status: [status("cam0: sensor"), status("cam0: recorder")] },
});
const data = (reply: PollReply) => {
  if ("error" in reply) throw new Error(reply.error);
  return reply;
};

describe("negotiated health deltas on the vehicle", () => {
  let clock: number, health: FakeHealth, server: VehicleStateServer, current: HealthService, view: string;
  const poll = async (since: number, healthDelta = true, extra: Partial<PollRequest> = {}) => data(await server.poll({
    v: 1, view, epoch: server.epoch, since, ...(healthDelta ? { health_delta: 1 } : {}), ...extra,
  }));
  const update = (change: (s: HealthService) => void = () => undefined) => {
    current = structuredClone(current);
    clock += 1000;
    current.receivedMonoMs = clock;
    current.receivedAtMs = 1_000_000 + clock;
    current.snapshot.stamp_unix_ns += 1;
    change(current);
    health.set(current);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    health = new FakeHealth();
    current = service();
    health.set(current);
    server = new VehicleStateServer({ store: new FakeStore(), health, epoch: "boot", now: () => clock,
      wallNow: () => 1_000_000 + clock, holdMs: 100, coalesceMs: 10 });
    view = server.register({ v: 1, items: [{ health: KEY }] }).view;
  });
  afterEach(() => { server.close(); vi.useRealTimers(); });

  it("advertises optional support and validates opt-in without changing legacy requests", () => {
    expect(server.register({ v: 1, items: [{ health: KEY }] }).health_delta).toBe(1);
    const request = { v: 1, view, epoch: "boot", since: 0 };
    expect(validatePollRequest(request)).toEqual(request);
    expect(validatePollRequest({ ...request, health_delta: 1 }).health_delta).toBe(1);
    expect(() => validatePollRequest({ ...request, health_delta: true })).toThrow(/health_delta/);
  });

  it("keeps old and new callers of the same view independent, including held polls", async () => {
    const first = await poll(0);
    expect(first.items[0][1].hd?.b).toBe(1);
    const modern = poll(first.seq);
    const legacy = poll(first.seq, false);
    update();
    await vi.advanceTimersByTimeAsync(10);
    const compact = await modern, full = await legacy;
    expect(compact.items[0][1].hd).toBeUndefined();
    expect(compact.items[0][1].hu).toMatchObject({ b: 1, c: 2, stamp: 2, level: 0, age: 0 });
    expect(compact.items[0][1].hu?.status).toBeUndefined();
    expect(full.items[0][1].hu).toBeUndefined();
    expect(full.items[0][1].hd?.s.snapshot.status).toHaveLength(2);
    expect(encodeMessage(compact).length).toBeLessThan(encodeMessage(full).length / 3);
  });

  it("sends full state initially, for fresh view indices, and after an epoch reset", async () => {
    const first = await poll(0);
    expect((await poll(first.seq, true, { fresh: [0] })).items[0][1].hd?.b).toBe(1);
    expect((await poll(first.seq, true, { epoch: "previous-boot" })).items[0][1].hd?.b).toBe(1);
    const second = server.register({ v: 1, items: [{ node: "/node" }, { health: KEY }] });
    const reused = await poll(first.seq, true, { view: second.view, fresh: [1] });
    expect(reused.items.find(([i]) => i === 1)?.[1].hd?.b).toBe(1);
  });

  it("resends all fields changed since an unacknowledged response, including A to B to A", async () => {
    const first = await poll(0);
    update((s) => {
      s.snapshot.status[0].values["temp.sensor_c"] = 42;
      s.snapshot.status[0].message = "warm";
      s.snapshot.status[1].level = 1;
    });
    const lost = await poll(first.seq);
    update((s) => {
      s.snapshot.status[0].values["temp.sensor_c"] = 41;
      s.snapshot.status[0].message = "ok";
      s.snapshot.status[0].values["health.sequence"] = 3;
    });
    const retry = await poll(first.seq);
    expect(retry.items[0][1].hu?.status).toEqual([
      [0, { message: "ok", values: { "temp.sensor_c": 41, "health.sequence": 3 } }],
      [1, { level: 1 }],
    ]);
    expect((await poll(lost.seq)).items[0][1].hu?.status).toEqual([
      [0, { message: "ok", values: { "temp.sensor_c": 41, "health.sequence": 3 } }],
    ]);
  });

  it("preserves changed health metadata and every scalar value without resending stable metrics", async () => {
    const first = await poll(0);
    update((s) => {
      const values = s.snapshot.status[0].values;
      values["health.sequence"] = 2;
      values["health.sample_age_s"] = 2.5;
      values["health.sample_id"] = "sample-2";
      values["metric.0"] = null;
      values["metric.1"] = false;
      values["metric.2"] = 0;
      s.snapshot.level = 1;
      delete s.periodMs;
    });
    const hu = (await poll(first.seq)).items[0][1].hu;
    expect(hu).toMatchObject({ stamp: 2, level: 1 });
    expect(hu?.periodMs).toBeUndefined();
    expect(hu?.status).toEqual([[0, { values: { "health.sequence": 2, "health.sample_age_s": 2.5,
      "health.sample_id": "sample-2", "metric.0": null, "metric.1": false, "metric.2": 0 } }]]);
  });

  it("replaces the baseline for key removal, reordered components, and metadata changes", async () => {
    let last = await poll(0);
    update((s) => { delete s.snapshot.status[0].values["metric.0"]; });
    last = await poll(last.seq);
    expect(last.items[0][1].hd?.b).toBe(2);
    expect(last.items[0][1].hd?.s.snapshot.status[0].values).not.toHaveProperty("metric.0");
    update((s) => { s.snapshot.status.reverse(); });
    last = await poll(last.seq);
    expect(last.items[0][1].hd?.b).toBe(3);
    expect(last.items[0][1].hd?.s.snapshot.status[0].name).toBe("cam0: recorder");
    update((s) => { s.alive = false; });
    last = await poll(last.seq);
    expect(last.items[0][1].hd?.b).toBe(4);
    expect(last.items[0][1].hd?.s.alive).toBe(false);
  });

  it("keeps a structural reset pending until the caller's cursor passes it", async () => {
    const first = await poll(0);
    update((s) => { s.snapshot.status[0].values.added = "new"; });
    await poll(first.seq); // lost full replacement
    update();
    const retry = await poll(first.seq);
    expect(retry.items[0][1].hd?.b).toBe(2);
    expect(retry.items[0][1].hu).toBeUndefined();
    update();
    expect((await poll(retry.seq)).items[0][1].hu?.b).toBe(2);
  });

  it("rebuilds component positions after insertion and removal", async () => {
    let last = await poll(0);
    update((s) => { s.snapshot.status.unshift(status("cam0: power")); });
    last = await poll(last.seq);
    expect(last.items[0][1].hd?.b).toBe(2);
    expect(last.items[0][1].hd?.s.snapshot.status).toHaveLength(3);
    update((s) => { s.snapshot.status.splice(1, 1); });
    last = await poll(last.seq);
    expect(last.items[0][1].hd?.b).toBe(3);
    update((s) => { s.snapshot.status[1].message = "recording"; });
    expect((await poll(last.seq)).items[0][1].hu?.status).toEqual([[1, { message: "recording" }]]);
  });

  it("clears missing services and gives their next appearance a new full baseline", async () => {
    const first = await poll(0);
    health.set();
    const gone = await poll(first.seq);
    expect(gone.items[0][1]).toEqual({});
    health.set(current);
    const back = await poll(gone.seq);
    expect(back.items[0][1].hd?.b).toBe(2);
    expect(back.items[0][1].hu).toBeUndefined();
  });

  it("computes reporter and independent component ages at reply time", async () => {
    const first = await poll(0);
    update((s) => {
      s.snapshot.status[0].receivedMonoMs = 800;
      s.snapshot.status[1].receivedMonoMs = 200;
    });
    clock = 1500;
    const hu = (await poll(first.seq)).items[0][1].hu;
    expect(hu).toMatchObject({ age: 500, sa: [700, 1300] });
    expect(hu?.status).toBeUndefined();
  });

  it("does not advance a quiet service on another service's notification or an empty poll", async () => {
    const first = await poll(0);
    clock = 4000;
    const pending = poll(first.seq);
    health.set(current, { ...service(), key: "fleet/r1/svc/other/health", instance: "other" });
    await vi.advanceTimersByTimeAsync(100);
    const idle = await pending;
    expect(idle).toMatchObject({ seq: first.seq, items: [] });
    const full = await poll(first.seq, true, { fresh: [0] });
    expect(full.items[0][1].hd?.age).toBe(4000);
  });

  it.each([true, false])("includes a change coalescing when a held poll expires (compact %s)", async (compact) => {
    const first = await poll(0, compact);
    const pending = poll(first.seq, compact);
    await vi.advanceTimersByTimeAsync(95); // hold is 100 ms; wake batching takes 10 ms
    update((s) => { s.snapshot.status[0].values["temp.sensor_c"] = 45; });
    await vi.advanceTimersByTimeAsync(5);
    const deadline = await pending;
    expect(deadline.seq).toBeGreaterThan(first.seq);
    if (compact) expect(deadline.items[0]?.[1].hu?.status).toEqual([[0, { values: { "temp.sensor_c": 45 } }]]);
    else expect(deadline.items[0]?.[1].hd?.s.snapshot.status[0].values["temp.sensor_c"]).toBe(45);
  });

  it("does not acknowledge unsent changes when closing a held poll", async () => {
    const first = await poll(0);
    const pending = poll(first.seq);
    update((s) => { s.snapshot.status[0].message = "stopping"; });
    server.close();
    expect((await pending).items[0]?.[1].hu?.status).toEqual([[0, { message: "stopping" }]]);
  });
});
