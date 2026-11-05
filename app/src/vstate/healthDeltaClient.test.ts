import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reporterCurrent, sampleAgeMs, statusCurrent, type HealthService } from "../health/types";
import { TransportError } from "../transport/reconnecting";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";
import { VehicleStateClient } from "./client";
import { healthToWire, type HealthUpdate, type HealthWire } from "./healthWire";
import { decodeMessage, encodeMessage, type ItemSpec, type ItemState, type PollReply, type PollRequest, type RegisterReply } from "./protocol";

const KEY = "fleet/rover/svc/cam0/health";
const OTHER = "fleet/rover/svc/cam1/health";
const HEALTH = { health: KEY };
const SERIES = { topic: "/battery", fields: [{ p: "voltage" }], series: { window_ms: 60_000, bucket_ms: 1000 } };

function full(options: { key?: string; b?: number; c?: number; value?: number; age?: number; sa?: number[] } = {}): HealthWire {
  const key = options.key ?? KEY;
  const instance = key.split("/")[3];
  const service: HealthService = {
    key, vehicleId: "rover", instance, alive: true, source: "ros2", sourceLabel: "ROS 2 · domain 0 · /diagnostics",
    receivedAtMs: Date.now(), receivedMonoMs: performance.now(), periodMs: 1000,
    snapshot: { schema_version: 1, service: "camera-service", instance, stamp_unix_ns: 100, level: 0,
      status: ["stream", "recording"].map(name => ({ name: `${instance}: ${name}`, level: 0, message: "ok", hardware_id: "camera",
        values: { "health.sequence": 1, "health.sample_age_s": 0, "health.stale_after_s": 2, "health.sample_id": "sample-1",
          "health.publisher_id": "camera-boot", "temp.sensor_c": options.value ?? 40 },
      })) },
  };
  return { ...healthToWire(service, options.c ?? 1), b: options.b ?? 10, age: options.age ?? 0, sa: options.sa ?? [0, 0] };
}

function update(options: Partial<HealthUpdate> = {}): HealthUpdate {
  return { b: 10, c: 2, age: 0, sa: [0, 0], stamp: 200, level: 0, ...options };
}

/** Manual replies make malformed, missing and older-version responses testable independently. */
class ScriptedTransport implements Transport {
  register: RegisterReply = { v: 1, view: "view1", epoch: "epoch1", fresh: 1, health_delta: 1 };
  registrations: ItemSpec[][] = [];
  polls: PollRequest[] = [];
  replies: PollReply[] = [];
  pending: ((reply: PollReply) => void)[] = [];
  disconnected = false;
  unavailable = false;
  async get(key: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    if (this.disconnected) throw new TransportError("disconnected", "test link lost");
    if (this.unavailable) return [];
    let reply: PollReply | RegisterReply;
    if (key.endsWith("/view")) {
      this.registrations.push((decodeMessage(opts?.payload) as { items: ItemSpec[] }).items);
      reply = { ...this.register };
    } else {
      this.polls.push(decodeMessage(opts?.payload) as PollRequest);
      reply = this.replies.shift() ?? await new Promise<PollReply>(resolve => this.pending.push(resolve));
    }
    return [{ keyexpr: key, payload: encodeMessage(reply) }];
  }
  answer(reply: PollReply) {
    const pending = this.pending.shift();
    if (pending) pending(reply); else this.replies.push(reply);
  }
  index(spec: ItemSpec) {
    return this.registrations.at(-1)!.findIndex(item => JSON.stringify(item) === JSON.stringify(spec));
  }
  subscribe = async () => ({ close: async () => undefined });
  liveliness = { subscribe: this.subscribe, get: async () => [] };
  close = async () => undefined;
}

describe("negotiated client health updates", () => {
  let link: ScriptedTransport;
  let client: VehicleStateClient;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    link = new ScriptedTransport();
    client = new VehicleStateClient({ transport: link, base: "fleet/rover/dash/main/state" });
  });
  afterEach(() => { client.close(); vi.useRealTimers(); });
  const advance = (ms = 250) => vi.advanceTimersByTimeAsync(ms);
  const send = async (seq: number, states: [ItemSpec, ItemState][], epoch = "epoch1") => {
    link.answer({ v: 1, epoch, seq, items: states.map(([spec, state]) => [link.index(spec), state]) });
    await advance();
  };

  it.each([true, false])("uses negotiated deltas when available (%s), preserving legacy full health otherwise", async negotiated => {
    if (!negotiated) delete link.register.health_delta;
    const h = client.acquire(HEALTH);
    await advance(50);
    expect(link.polls[0].health_delta).toBe(negotiated ? 1 : undefined);
    const initial = full();
    if (!negotiated) delete initial.b;
    await send(1, [[HEALTH, { hd: initial }]]);
    const previous = client.getSnapshot(h.key)!.health!;
    await send(2, [[HEALTH, negotiated ? { hu: update({ status: [[0, { values: { "temp.sensor_c": 42, "health.sequence": 2 } }]] }) }
      : { hd: { ...full({ c: 2, value: 42 }), b: undefined } }]]);
    const next = client.getSnapshot(h.key)!.health!;
    expect(next).not.toBe(previous);
    expect(next.snapshot.status[0].values["temp.sensor_c"]).toBe(42);
    expect(previous.snapshot.status[0].values["temp.sensor_c"]).toBe(40);
    expect(link.polls.every(poll => poll.health_delta === (negotiated ? 1 : undefined))).toBe(true);
  });

  it("repairs only a rejected health item while accepting other health and topic history", async () => {
    const bad = client.acquire(HEALTH);
    const goodSpec = { health: OTHER };
    const good = client.acquire(goodSpec);
    const series = client.acquire(SERIES);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }], [goodSpec, { hd: full({ key: OTHER, b: 20 }) }],
      [SERIES, { t: "Battery", f: [24], hs: [[0, 1000, 24, 24, 24]] }]]);
    const previous = client.getSnapshot(bad.key);
    const firstBucket = client.getSnapshot(series.key)!.history![0];
    await send(2, [[HEALTH, { hu: update({ b: 999, status: [[0, { values: { "temp.sensor_c": 99 } }]] }) }],
      [goodSpec, { hu: update({ b: 20, status: [[0, { values: { "temp.sensor_c": 41 } }]] }) }],
      [SERIES, { t: "Battery", f: [23], hs: [[1, 0, 23, 23, 23]] }]]);
    expect(client.getSnapshot(bad.key)).toBe(previous);
    expect(client.getSnapshot(good.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(41);
    expect(client.getSnapshot(series.key)!.history).toEqual([firstBucket, expect.objectContaining({ last: 23 })]);
    expect(link.polls.at(-1)).toMatchObject({ since: 2, fresh: [link.index(HEALTH)] });
    // An incomplete reply must not bless the item as complete or clear its pending full request.
    await send(3, []);
    expect(link.polls.at(-1)).toMatchObject({ since: 3, fresh: [link.index(HEALTH)] });
    await send(4, [[HEALTH, { hd: full({ b: 30, c: 4, value: 43 }) }]]);
    expect(client.getSnapshot(bad.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(43);
    expect(client.getSnapshot(series.key)!.history).toHaveLength(2);
    expect(link.polls.at(-1)!.fresh).toBeUndefined();
  });

  it.each(["unnegotiated", "initial-full", "fresh", "malformed"])("rejects a %s update without replacing the last report", async mode => {
    if (mode === "unnegotiated") delete link.register.health_delta;
    const h = client.acquire(HEALTH);
    await advance(50);
    if (mode !== "initial-full") await send(1, [[HEALTH, { hd: full() }]]);
    if (mode === "fresh") await send(2, [[HEALTH, { hu: update({ b: 999 }) }]]);
    const previous = client.getSnapshot(h.key);
    const hu = mode === "malformed" ? update({ status: [[99, { message: "wrong component" }]] }) : update();
    await send(3, [[HEALTH, { hu }]]);
    expect(client.getSnapshot(h.key)).toBe(previous);
    expect(link.polls.at(-1)!.fresh).toEqual([link.index(HEALTH)]);
    await send(4, [[HEALTH, { hd: full({ c: 4, value: 44 }) }]]);
    expect(client.getSnapshot(h.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(44);
    expect(link.polls.at(-1)!.fresh).toBeUndefined();
  });

  it("does not turn empty successful polls into health heartbeats", async () => {
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }]]);
    const before = client.getSnapshot(h.key)!.health!;
    await advance(6000);
    await send(1, []);
    expect(client.getSnapshot(h.key)!.health).toBe(before);
    expect(reporterCurrent(before, Date.now())).toBe(false);
    expect(statusCurrent(before, before.snapshot.status[0], Date.now())).toBe(false);
    expect(performance.now() - client.lastResponseMonoMs()!).toBeLessThan(300);
  });

  it("refreshes only independently observed ROS components across a browser wall-clock change", async () => {
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }]]);
    await advance(3000);
    vi.setSystemTime(Date.now() + 365 * 24 * 3600 * 1000);
    await send(2, [[HEALTH, { hu: update({ sa: [0, 3500], status: [[0, { values: {
      "health.sequence": 2, "health.sample_id": "sample-2", "health.sample_age_s": 0,
    } }]] }) }]]);
    const service = client.getSnapshot(h.key)!.health!;
    expect(reporterCurrent(service, Date.now())).toBe(true);
    expect(statusCurrent(service, service.snapshot.status[0], Date.now())).toBe(true);
    expect(statusCurrent(service, service.snapshot.status[1], Date.now())).toBe(false);
    expect(sampleAgeMs(service, service.snapshot.status[1], Date.now())).toBeGreaterThanOrEqual(3500);
    expect(service.snapshot.status[0].values["health.sample_id"]).toBe("sample-2");
    expect(service.snapshot.status[1].values["health.sample_id"]).toBe("sample-1");
  });

  it("keeps increasing source sample ages stale despite a fresh reporter heartbeat", async () => {
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }]]);
    await advance(3000);
    await send(2, [[HEALTH, { hu: update({ status: [[0, { values: { "health.sample_age_s": 3, "health.sequence": 2 } }]] }) }]]);
    const service = client.getSnapshot(h.key)!.health!;
    expect(reporterCurrent(service, Date.now())).toBe(true);
    expect(statusCurrent(service, service.snapshot.status[0], Date.now())).toBe(false);
    expect(sampleAgeMs(service, service.snapshot.status[0], Date.now())).toBeGreaterThanOrEqual(3000);
    expect(service.periodMs).toBeUndefined(); // the complete heartbeat header omitted it
  });

  it("discards baselines when a service disappears or an item is recreated", async () => {
    const node = client.acquire({ node: "/gps" });
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }], [{ node: "/gps" }, { a: 1 }]]);
    await send(2, [[HEALTH, {}]]);
    expect(client.getSnapshot(h.key)!.health).toBeUndefined();
    await send(3, [[HEALTH, { hu: update() }]]);
    expect(client.getSnapshot(h.key)!.health).toBeUndefined();
    expect(link.polls.at(-1)!.fresh).toEqual([link.index(HEALTH)]);
    await send(4, [[HEALTH, { hd: full() }]]);
    h.release();
    await advance(1100);
    // The previous view's held poll remains in flight but its late result is ignored.
    await send(5, []);
    await send(5, []);
    const again = client.acquire(HEALTH);
    await advance(50);
    expect(client.getSnapshot(again.key)).toBeNull();
    await send(6, [[HEALTH, { hu: update() }]]); // superseded poll
    await send(6, [[HEALTH, { hu: update() }]]); // current view: no baseline
    expect(client.getSnapshot(again.key)).toBeNull();
    expect(link.polls.at(-1)!.fresh).toEqual([link.index(HEALTH)]);
    expect(client.getSnapshot(node.key)!.alive).toBe(true);
  });

  it("retains health during a link outage and resumes only from valid updates", async () => {
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }]]);
    const previous = client.getSnapshot(h.key);
    link.disconnected = true;
    await send(1, []);
    await advance(6000);
    expect(client.getSnapshot(h.key)).toBe(previous);
    expect(reporterCurrent(previous!.health!, Date.now())).toBe(false);
    link.disconnected = false;
    link.answer({ v: 1, epoch: "epoch1", seq: 2, items: [[link.index(HEALTH), { hu: update() }]] });
    await advance(750);
    expect(client.getSnapshot(h.key)!.health).not.toBe(previous!.health);
    expect(reporterCurrent(client.getSnapshot(h.key)!.health!, Date.now())).toBe(true);
  });

  it("requires full health after service outage and after restart even if baseline tokens repeat", async () => {
    const h = client.acquire(HEALTH);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }]]);
    const previous = client.getSnapshot(h.key)!.health!;
    link.unavailable = true;
    await send(1, []);
    await advance(4000);
    expect(client.getSnapshot(h.key)!.health).toBe(previous);
    expect(client.getSnapshot(h.key)!.error).toContain("not reachable");
    link.unavailable = false;
    link.answer({ v: 1, epoch: "epoch1", seq: 2, items: [[link.index(HEALTH), { hu: update() }]] });
    await advance(2500);
    expect(client.getSnapshot(h.key)!.health).toBe(previous);
    expect(link.polls.at(-1)!.fresh).toEqual([link.index(HEALTH)]);
    await send(3, [[HEALTH, { hd: full({ value: 41 }) }]]);
    link.register = { ...link.register, epoch: "epoch2", health_delta: undefined };
    link.answer({ v: 1, error: "unknown-view" });
    await advance(250);
    expect(link.polls.at(-1)).toMatchObject({ epoch: "epoch2", since: 0 });
    expect(link.polls.at(-1)!.health_delta).toBeUndefined();
    const beforeRestart = client.getSnapshot(h.key)!.health;
    await send(1, [[HEALTH, { hu: update() }]], "epoch2");
    expect(client.getSnapshot(h.key)!.health).toBe(beforeRestart);
    await send(2, [[HEALTH, { hd: full({ value: 42 }) }]], "epoch2");
    expect(client.getSnapshot(h.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(42);
  });

  it.each([false, true])("renegotiates after an unsolicited epoch change and preserves pending health recovery (%s)", async incomplete => {
    const h = client.acquire(HEALTH);
    const nodeSpec = { node: "/gps" };
    const node = client.acquire(nodeSpec);
    await advance(50);
    await send(1, [[HEALTH, { hd: full() }], [nodeSpec, { a: 0 }]]);
    const previous = client.getSnapshot(h.key)!.health;
    // Another caller has already registered the identical hashed view on the restarted server,
    // so our old view ID is accepted and the server answers with its new epoch directly.
    link.register = { v: 1, view: "view1", epoch: "epoch2", fresh: 1 };
    await send(1, [[HEALTH, incomplete ? { hu: update() } : { hd: full({ value: 45 }) }], [nodeSpec, { a: 1 }]], "epoch2");
    expect(link.registrations).toHaveLength(2);
    expect(link.polls.at(-1)).toMatchObject({ epoch: "epoch2", since: 1 });
    expect(link.polls.at(-1)!.health_delta).toBeUndefined();
    expect(client.getSnapshot(node.key)!.alive).toBe(true);
    if (incomplete) {
      expect(client.getSnapshot(h.key)!.health).toBe(previous);
      expect(link.polls.at(-1)!.fresh).toEqual([link.index(HEALTH)]);
      await send(2, [[HEALTH, { hd: full({ value: 46 }) }]], "epoch2");
      expect(client.getSnapshot(h.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(46);
    } else {
      expect(client.getSnapshot(h.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(45);
      expect(link.polls.at(-1)!.fresh).toBeUndefined();
    }
  });
});
