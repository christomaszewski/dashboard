import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../ros/graph";
import type { HealthService } from "../health/types";
import { VehicleStateClient } from "./client";
import { VehicleStateServer, type HealthSource } from "./server";
import { FakeStore, LoopbackTransport } from "./testkit";
import type { PollReply } from "./protocol";

const GPS = "@ros2_lv/0/z/1/2/MP/%/%/gps/%fix/sensor_msgs::msg::dds_::NavSatFix_/RIHS01_bb/2:2:1,10";
const BAT = "@ros2_lv/0/z/1/3/MP/%/%/bms/%battery/sensor_msgs::msg::dds_::BatteryState_/RIHS01_cc/2:2:1,10";
const NODE = "@ros2_lv/0/z/1/0/NN/%/%/gps";
const graph = buildGraph([GPS, BAT, NODE]);
const gpsKey = graph.topics.find((t) => t.name === "/fix")!.dataKeyexpr;
const batKey = graph.topics.find((t) => t.name === "/battery")!.dataKeyexpr;
const trailSpec = { topic: "/fix", fields: [{ p: "latitude", q: 1e-7 }, { p: "longitude", q: 1e-7 }], trail: 3 };
const seriesSpec = { topic: "/battery", fields: [{ p: "voltage", q: 0.01 }], series: { window_ms: 2000, bucket_ms: 500 } };

class FakeHealth implements HealthSource {
  services: HealthService[] = [];
  refs = 0;
  private cbs = new Set<() => void>();
  retain() { this.refs += 1; }
  release() { this.refs -= 1; }
  list() { return this.services; }
  subscribe(cb: () => void) { this.cbs.add(cb); return () => void this.cbs.delete(cb); }
  set(services: HealthService[]) { this.services = services; for (const cb of this.cbs) cb(); }
}
const service = (temp: number, at: number): HealthService => ({
  key: "fleet/r1/svc/cam0/health", vehicleId: "r1", instance: "cam0", alive: true, receivedAtMs: at, receivedMonoMs: at,
  source: "native", sourceLabel: "Zenoh JSON",
  snapshot: { schema_version: 1, service: "camera-service", instance: "cam0", stamp_unix_ns: 0, level: 0,
    status: [{ name: "cam0: sensor", level: 0, message: "ok", hardware_id: "", values: { "temp.sensor_c": temp }, receivedAtMs: at, receivedMonoMs: at }] },
});

describe("vehicle-kept trails, histories, nodes and health", () => {
  let t = 0;
  let store: FakeStore;
  let health: FakeHealth;
  let server: VehicleStateServer;
  let link: LoopbackTransport;
  let client: VehicleStateClient;
  const newServer = (epoch: string) => {
    const s = new VehicleStateServer({ store, health, epoch, now: () => t, wallNow: () => 1_000_000 + t });
    s.setGraph(graph);
    return s;
  };
  const advance = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const fix = (lat: number) => store.emit(gpsKey, { message: { latitude: lat, longitude: -79.9 }, lastAt: t });
  const volts = (v: number) => store.emit(batKey, { message: { voltage: v }, lastAt: t });

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    store = new FakeStore();
    health = new FakeHealth();
    server = newServer("e1");
    link = new LoopbackTransport(server);
    client = new VehicleStateClient({ transport: link, base: "fleet/r1/dash/d/state" });
  });
  afterEach(() => {
    client.close();
    server.close();
    vi.useRealTimers();
  });

  it("keep the trail on the vehicle: a continuation sends new points only, a reconnect gets them all", async () => {
    const h = client.acquire(trailSpec);
    for (const lat of [40.1, 40.2, 40.3, 40.4]) {
      fix(lat);
      await advance(300);
    }
    expect(client.getSnapshot(h.key)!.trail).toEqual([[40.2, -79.9], [40.3, -79.9], [40.4, -79.9]]);
    // On the wire: one new point after the first fill, not the whole trail again.
    const polls = server as unknown as { poll(raw: unknown): Promise<PollReply> };
    const view = server.register({ v: 1, items: [trailSpec] });
    const all = await polls.poll({ v: 1, view: view.view, epoch: "e1", since: 0 });
    const since = "seq" in all ? all.seq : 0;
    fix(40.5);
    const next = polls.poll({ v: 1, view: view.view, epoch: "e1", since });
    await advance(20);
    const reply = await next;
    expect("items" in reply && reply.items[0][1].tr).toEqual({ i: 4, p: [[40.5, -79.9]] });
    // A page that reloads (a new client) gets the trail kept so far at once.
    const fresh = new VehicleStateClient({ transport: link, base: "fleet/r1/dash/d/state" });
    const f = fresh.acquire(trailSpec);
    await advance(300);
    expect(fresh.getSnapshot(f.key)!.trail).toEqual([[40.3, -79.9], [40.4, -79.9], [40.5, -79.9]]);
    fresh.close();
  });

  it("keep a min/max/last history per bucket, slide the window, keep the newest bucket", async () => {
    const h = client.acquire(seriesSpec);
    volts(24.0);
    await advance(100);
    volts(23.5);
    await advance(100);
    volts(24.2);
    await advance(600); // next bucket
    volts(23.0);
    await advance(300);
    const history = client.getSnapshot(h.key)!.history!;
    expect(history.map(({ min, max, last }) => [min, max, last])).toEqual([[23.5, 24.2, 24.2], [23, 23, 23]]);
    expect(history[0].t).toBeLessThan(history[1].t);
    await advance(5000); // nothing changes for longer than the window: no new bucket, no traffic
    volts(23.0);
    await advance(300);
    expect(client.getSnapshot(h.key)!.history!.length).toBe(2);
    volts(22.5); // the next change starts a bucket; the ones older than the window go
    await advance(300);
    expect(client.getSnapshot(h.key)!.history!.map((p) => p.last)).toEqual([22.5]);
  });

  it("report node presence from the vehicle's graph", async () => {
    const h = client.acquire({ node: "/gps" });
    const other = client.acquire({ node: "/nope" });
    await advance(300);
    expect(client.getSnapshot(h.key)!.alive).toBe(true);
    expect(client.getSnapshot(other.key)!.alive).toBe(false);
    server.setGraph(buildGraph([GPS]));
    await advance(2100);
    expect(client.getSnapshot(h.key)!.alive).toBe(false);
  });

  it("serve health while watched, with ages turned into this browser's clock", async () => {
    health.set([service(41, 1_000_000)]);
    const keys = client.acquire({ health: "*" });
    const one = client.acquire({ health: "fleet/r1/svc/cam0/health" });
    await advance(300);
    expect(health.refs).toBe(1);
    expect(client.getSnapshot(keys.key)!.healthKeys).toEqual(["fleet/r1/svc/cam0/health"]);
    const s = client.getSnapshot(one.key)!.health!;
    expect(s.snapshot.status[0].values["temp.sensor_c"]).toBe(41);
    // received 300 ms before the reply, on the vehicle; here: about 300 ms ago
    expect(Date.now() - s.receivedAtMs).toBeGreaterThanOrEqual(250);
    health.set([service(43, 1_000_000 + t)]);
    await advance(300);
    expect(client.getSnapshot(one.key)!.health!.snapshot.status[0].values["temp.sensor_c"]).toBe(43);
    one.release();
    keys.release();
    // The page's old view expires a minute after its last poll; the health source stops with it.
    await advance(61_000);
    server.tick();
    expect(health.refs).toBe(0);
  });
});
