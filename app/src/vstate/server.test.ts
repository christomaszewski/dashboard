import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph, type RosGraph } from "../ros/graph";
import type { IncomingQuery } from "../transport/types";
import { LIMITS, decodeMessage, encodeMessage, type ItemSpec, type PollReply } from "./protocol";
import { VehicleStateServer, serveQuery } from "./server";
import { FakeStore } from "./testkit";

const IMU = "@ros2_lv/0/z/1/1/MP/%/%/imu/%imu%data/sensor_msgs::msg::dds_::Imu_/RIHS01_aa/2:2:1,10";
const MAP = "@ros2_lv/0/z/1/2/MP/%/%/mapper/%map/nav_msgs::msg::dds_::OccupancyGrid_/RIHS01_bb/1:1:1,1";
const graph = (...tokens: string[]): RosGraph => buildGraph(tokens);

const heading: ItemSpec = { topic: "/imu/data", fields: [{ p: "orientation.z", q: 0.01 }] };
const rate: ItemSpec = { topic: "/imu/data", hz: true };

describe("VehicleStateServer", () => {
  let store: FakeStore;
  let clock: number;
  let server: VehicleStateServer;
  const imuKey = () => graph(IMU).topics[0].dataKeyexpr;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    clock = 1000;
    server = new VehicleStateServer({ store, now: () => clock, epoch: "e1" });
  });
  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });

  const poll = (view: string, since: number, epoch = "e1") => server.poll({ v: 1, view, epoch, since });
  const ok = (r: PollReply) => {
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  it("returns a full snapshot, then only items that changed at their display quantum", async () => {
    const { view } = server.register({ v: 1, items: [heading, { topic: "/missing" }] });
    const first = ok(await poll(view, 0));
    expect(first.items).toEqual([[0, {}], [1, {}]]);

    server.setGraph(graph(IMU));
    expect(store.acquired).toEqual([{ key: imuKey(), opts: { windowMs: undefined, decode: true }, released: false }]);
    store.emit(imuKey(), { message: { orientation: { z: 0.123 } }, lastAt: clock });
    const second = ok(await poll(view, first.seq));
    expect(second.items).toEqual([[0, { t: "sensor_msgs/msg/Imu", d: 0, f: [0.12] }]]);

    // 0.123 → 0.124 renders identically at 0.01: no change, so the poll waits and heartbeats.
    store.emit(imuKey(), { message: { orientation: { z: 0.124 } }, lastAt: clock });
    const held = poll(view, second.seq);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void held.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ok(await held)).toEqual({ v: 1, epoch: "e1", seq: second.seq, items: [] });
  });

  it("wakes a held poll as soon as a change lands, coalescing a burst", async () => {
    server.setGraph(graph(IMU));
    const { view } = server.register({ v: 1, items: [heading, rate] });
    const base = ok(await poll(view, 0)).seq;
    const held = poll(view, base);
    store.emit(imuKey(), { message: { orientation: { z: 0.5 } }, hz: 200, lastAt: clock });
    await vi.advanceTimersByTimeAsync(10);
    const reply = ok(await held);
    expect(reply.items.map(([i]) => i)).toEqual([0, 1]);
    expect(reply.items[1][1]).toEqual({ t: "sensor_msgs/msg/Imu", d: 0, hz: 200 });
  });

  it("only reports rate when asked and never decodes rate-only items", async () => {
    server.setGraph(graph(IMU));
    server.register({ v: 1, items: [rate] });
    expect(store.acquired[0].opts).toEqual({ windowMs: undefined, decode: false });
    const { view } = server.register({ v: 1, items: [heading] });
    store.emit(imuKey(), { message: { orientation: { z: 1 } }, hz: 50 });
    expect(ok(await poll(view, 0)).items[0][1]).not.toHaveProperty("hz");
  });

  it("answers a foreign epoch with everything and an unknown view with an error", async () => {
    const { view } = server.register({ v: 1, items: [heading] });
    expect(ok(await poll(view, 999, "old")).items).toHaveLength(1);
    expect(await poll("vnope", 0)).toEqual({ v: 1, error: "unknown-view" });
  });

  it("shares items between views and releases subscriptions with the last view", async () => {
    server.setGraph(graph(IMU));
    const a = server.register({ v: 1, items: [heading] }).view;
    const b = server.register({ v: 1, items: [heading, rate] }).view;
    expect(store.live(imuKey())).toBe(2); // one per distinct item, both on the same topic
    expect(server.stats()).toMatchObject({ views: 2, items: 2, topics: 1 });
    clock += 30_000;
    await poll(a, 0);
    clock += 31_000;
    server.tick(); // b has not polled for 61 s
    expect(server.stats()).toMatchObject({ views: 1, items: 1 });
    expect(await poll(b, 0)).toEqual({ v: 1, error: "unknown-view" });
    clock += 61_000;
    server.tick();
    expect(store.live(imuKey())).toBe(0);
  });

  it("rebinds when a topic disappears and reappears", async () => {
    const { view } = server.register({ v: 1, items: [heading] });
    server.setGraph(graph(IMU));
    store.emit(imuKey(), { message: { orientation: { z: 0.2 } } });
    const seen = ok(await poll(view, 0)).seq;
    server.setGraph(graph());
    expect(store.live(imuKey())).toBe(0);
    const gone = ok(await poll(view, seen));
    expect(gone.items).toEqual([[0, {}]]);
    server.setGraph(graph(IMU));
    expect(store.live(imuKey())).toBe(1);
  });

  it("marks silence as stale, scaled to the topic's usual interval, never for latched topics", async () => {
    server.setGraph(graph(IMU, MAP));
    const mapKey = graph(MAP).topics[0].dataKeyexpr;
    const { view } = server.register({ v: 1, items: [heading, { topic: "/map", fields: [{ p: "info.width" }] }] });
    store.emit(imuKey(), { message: { orientation: { z: 0 } }, lastAt: clock });
    store.emit(mapKey, { message: { info: { width: 4 } }, lastAt: clock });
    const start = ok(await poll(view, 0)).seq;
    clock += 5001;
    server.tick();
    const stale = ok(await poll(view, start));
    expect(stale.items).toEqual([[0, { t: "sensor_msgs/msg/Imu", d: 0, f: [0], s: 1 }]]);
    // A slow topic (10 s between samples) is only stale after 3 intervals.
    clock = 11_000; // the first sample was at 1000
    store.emit(imuKey(), { message: { orientation: { z: 0 } }, lastAt: clock });
    clock += 20_000;
    server.tick();
    expect(ok(await poll(view, stale.seq)).items[0][1]).not.toHaveProperty("s");
    clock += 10_001;
    server.tick();
    expect(ok(await poll(view, 0)).items[0][1]).toHaveProperty("s", 1);
  });

  it("turns oversized values into an item error instead of a huge reply", async () => {
    server.setGraph(graph(IMU));
    const { view } = server.register({ v: 1, items: [{ topic: "/imu/data", fields: [{ p: "blob" }] }] });
    store.emit(imuKey(), { message: { blob: "x".repeat(LIMITS.stateBytes) } });
    const state = ok(await poll(view, 0)).items[0][1];
    expect(state.e).toMatch(/value too large/);
    expect(state.f).toBeUndefined();
  });

  it("evicts the longest-idle view when full", async () => {
    const ids = Array.from({ length: LIMITS.views }, (_, i) => {
      clock += 1;
      return server.register({ v: 1, items: [{ topic: `/t${i}` }] }).view;
    });
    server.register({ v: 1, items: [{ topic: "/new" }] });
    expect(await poll(ids[0], 0)).toEqual({ v: 1, error: "unknown-view" });
    expect("error" in (await poll(ids[1], 0))).toBe(false);
  });

  it("serves queries and rejects malformed ones with a reply error", async () => {
    const replies: string[] = [];
    const query = (payload?: Uint8Array): IncomingQuery => ({
      keyexpr: "k",
      payload,
      reply: async (b) => void replies.push(JSON.stringify(decodeMessage(b))),
      replyErr: async (m) => void replies.push(`ERR ${m}`),
    });
    await serveQuery(server, "view", query(encodeMessage({ v: 1, items: [heading] })));
    await serveQuery(server, "view", query(new TextEncoder().encode("{")));
    await serveQuery(server, "poll", query(encodeMessage({ v: 1, view: "x y", epoch: "", since: 0 })));
    expect(replies[0]).toMatch(/"view":"v[0-9a-f]+","epoch":"e1"/);
    expect(replies[1]).toMatch(/^ERR /);
    expect(replies[2]).toBe("ERR poll.view must be a view id");
  });
});
