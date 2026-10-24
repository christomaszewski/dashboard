import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../ros/graph";
import { pluckField } from "../home/pluck";
import { VehicleStateClient } from "./client";
import { VehicleStateServer } from "./server";
import { FakeStore, LoopbackTransport } from "./testkit";

const IMU = "@ros2_lv/0/z/1/1/MP/%/%/imu/%imu%data/sensor_msgs::msg::dds_::Imu_/RIHS01_aa/2:2:1,10";
const GPS = "@ros2_lv/0/z/1/2/MP/%/%/gps/%fix/sensor_msgs::msg::dds_::NavSatFix_/RIHS01_bb/2:2:1,10";
const graph = buildGraph([IMU, GPS]);
const imuKey = graph.topics.find((t) => t.name === "/imu/data")!.dataKeyexpr;
const gpsKey = graph.topics.find((t) => t.name === "/fix")!.dataKeyexpr;
const heading = { topic: "/imu/data", fields: [{ p: "orientation.z", q: 0.01 }] };
const position = { topic: "/fix", fields: [{ p: "latitude", q: 1e-7 }, { p: "longitude", q: 1e-7 }] };

describe("VehicleStateClient ↔ VehicleStateServer", () => {
  let store: FakeStore;
  let server: VehicleStateServer;
  let link: LoopbackTransport;
  let client: VehicleStateClient;

  const newServer = (epoch: string) => {
    const s = new VehicleStateServer({ store, epoch });
    s.setGraph(graph);
    return s;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    server = newServer("e1");
    link = new LoopbackTransport(server);
    client = new VehicleStateClient({ transport: link, base: "fleet/r1/dash/d/state" });
  });
  afterEach(() => {
    client.close();
    server.close();
    vi.useRealTimers();
  });

  const ops = () => link.calls.map((c) => c.op).join(",");

  it("registers the mounted items once and delivers sparse messages", async () => {
    store.emit(imuKey, { message: { orientation: { z: 0.4567, w: 1 }, linear_acceleration: { x: 9 } } });
    const a = client.acquire(heading);
    const b = client.acquire(heading); // a second widget on the same field shares the item
    const seen = vi.fn();
    client.subscribe(a.key, seen);
    expect(b.key).toBe(a.key);
    await vi.advanceTimersByTimeAsync(50);
    expect(ops()).toBe("view,poll"); // the full snapshot; the next poll waits for the 200 ms floor
    await vi.advanceTimersByTimeAsync(200);
    expect(ops()).toBe("view,poll,poll"); // ...and is now held on the vehicle
    const snap = client.getSnapshot(a.key)!;
    expect(snap.typeName).toBe("sensor_msgs/msg/Imu");
    expect(snap.message).toEqual({ orientation: { z: 0.46 } });
    expect(pluckField(snap.message, "linear_acceleration.x")).toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("wakes on a change, sends only what changed and never polls faster than the floor", async () => {
    store.emit(imuKey, { message: { orientation: { z: 0 } } });
    store.emit(gpsKey, { message: { latitude: 40, longitude: -80 } });
    const h = client.acquire(heading);
    const p = client.acquire(position);
    await vi.advanceTimersByTimeAsync(50);
    const before = link.calls.length;
    for (let i = 1; i <= 10; i++) {
      store.emit(imuKey, { message: { orientation: { z: i / 10 } } });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(link.calls.length - before).toBeLessThanOrEqual(2); // 200 ms of changes, ≤ 5 Hz
    await vi.advanceTimersByTimeAsync(300);
    expect(client.getSnapshot(h.key)!.message).toEqual({ orientation: { z: 1 } });
    expect(client.getSnapshot(p.key)!.message).toEqual({ latitude: 40, longitude: -80 });
    const last = link.calls.at(-2)!.body as { since: number };
    expect(last.since).toBeGreaterThan(0); // deltas after the first snapshot
  });

  it("switches views without waiting out a held poll", async () => {
    client.acquire(heading);
    await vi.advanceTimersByTimeAsync(250);
    expect(ops()).toBe("view,poll,poll"); // a poll is held on the vehicle
    store.emit(gpsKey, { message: { latitude: 1, longitude: 2 } });
    const p = client.acquire(position);
    await vi.advanceTimersByTimeAsync(50); // far less than the 2 s hold
    expect(client.getSnapshot(p.key)!.message).toEqual({ latitude: 1, longitude: 2 });
    expect((link.calls.filter((c) => c.op === "view").at(-1)!.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it("re-registers after the vehicle restarts", async () => {
    store.emit(imuKey, { message: { orientation: { z: 0.1 } } });
    const h = client.acquire(heading);
    await vi.advanceTimersByTimeAsync(50);
    server.close();
    server = newServer("e2");
    link.server = server;
    store.emit(imuKey, { message: { orientation: { z: 0.2 } } });
    await vi.advanceTimersByTimeAsync(2500);
    expect(client.getSnapshot(h.key)!.message).toEqual({ orientation: { z: 0.2 } });
    expect(link.calls.filter((c) => c.op === "view")).toHaveLength(2);
  });

  it("marks items while nothing answers and restores them in full afterwards", async () => {
    store.emit(imuKey, { message: { orientation: { z: 0.3 } } });
    const h = client.acquire(heading);
    await vi.advanceTimersByTimeAsync(50);
    const answering = link.server;
    link.server = null;
    await vi.advanceTimersByTimeAsync(2100); // the held poll ends, the next finds no queryable
    expect(client.getSnapshot(h.key)!.error).toMatch(/not reachable \(fleet\/r1\/dash\/d\/state\/poll\)/);
    expect(client.getSnapshot(h.key)!.message).toEqual({ orientation: { z: 0.3 } });
    link.server = answering;
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getSnapshot(h.key)!.error).toBeUndefined();
  });

  it("keeps values through a link outage and resumes quickly after it", async () => {
    store.emit(imuKey, { message: { orientation: { z: 0.3 } } });
    const h = client.acquire(heading);
    await vi.advanceTimersByTimeAsync(50);
    link.down = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.getSnapshot(h.key)).toMatchObject({ message: { orientation: { z: 0.3 } }, error: undefined });
    store.emit(imuKey, { message: { orientation: { z: 0.9 } } });
    link.down = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(client.getSnapshot(h.key)!.message).toEqual({ orientation: { z: 0.9 } });
  });

  it("drops released items from the view after the linger", async () => {
    const h = client.acquire(heading);
    const p = client.acquire(position);
    await vi.advanceTimersByTimeAsync(50);
    p.release();
    p.release(); // idempotent
    await vi.advanceTimersByTimeAsync(1100);
    const views = link.calls.filter((c) => c.op === "view");
    expect((views.at(-1)!.body as { items: { topic: string }[] }).items.map((i) => i.topic)).toEqual(["/imu/data"]);
    expect(client.getSnapshot(h.key)).not.toBeNull();
    expect(client.getSnapshot(p.key)).toBeNull();
  });
});

describe("VehicleStateClient item validation", () => {
  it("keeps an invalid item out of the view and reports it on that item only", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const server = new VehicleStateServer({ store, epoch: "e1" });
    server.setGraph(graph);
    const link = new LoopbackTransport(server);
    const client = new VehicleStateClient({ transport: link, base: "fleet/r1/dash/d/state" });
    store.emit(imuKey, { message: { orientation: { z: 0.5 } } });
    const bad = client.acquire({ topic: "/imu/data", fields: [{ p: "ranges[0]" }] });
    const good = client.acquire(heading);
    await vi.advanceTimersByTimeAsync(50);
    expect(client.getSnapshot(bad.key)!.error).toBe("vehicle state: fields[0].p must be a field path");
    expect(client.getSnapshot(good.key)!.message).toEqual({ orientation: { z: 0.5 } });
    expect((link.calls[0].body as { items: unknown[] }).items).toHaveLength(1);
    client.close();
    server.close();
    vi.useRealTimers();
  });
});
