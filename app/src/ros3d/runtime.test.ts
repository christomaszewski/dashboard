import { describe, expect, it, vi } from "vitest";
import { buildGraph, type TopicEntry } from "../ros/graph";
import type { GetReply, Sample, Subscription, Transport, TransportGetOptions } from "../transport/types";
import type { SchemaResolver } from "../schema/types";
import { TopicStreamPool } from "../ros/topicStreamPool";
import { topicHistory } from "../ros/topicHistory";
import { CloudPipeline, type CloudJob } from "./cloudPipeline";
import { Ros3DRuntime, TfSource } from "./runtime";
import { SceneModel } from "./sceneModel";
import { sceneConfig } from "./config";
import { identity } from "./math";
import type { ParsedCloud } from "./pointCloud";
import { RetentionBudget } from "./retentionBudget";

const token = (topic: string, type: string, extra = "") => `@ros2_lv/0/abc/0/${topic.replaceAll("/", "")}/MP/%/%/fixture/${topic.replaceAll("/", "%")}/${type}/hash/::,100:,:,:,,${extra}`;
const graph = buildGraph([token("/tf", "tf2_msgs::msg::dds_::TFMessage_"), token("/tf_static", "tf2_msgs::msg::dds_::TFMessage_"),
  token("/clock", "rosgraph_msgs::msg::dds_::Clock_"), token("/ouster/points", "sensor_msgs::msg::dds_::PointCloud2_", "/backends:cpu:")]);
const topic = (name: string): TopicEntry => graph.topics.find((t) => t.name === name)!;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const encode = (message: unknown) => new TextEncoder().encode(JSON.stringify(message));
const resolver: SchemaResolver = { resolve: async () => ({ decode: (data) => JSON.parse(new TextDecoder().decode(data)) }) };
class TransportFake implements Transport {
  listeners = new Map<string, Set<(s: Sample) => void>>();
  subscribe = vi.fn(async (key: string, cb: (s: Sample) => void): Promise<Subscription> => {
    const listeners = this.listeners.get(key) ?? new Set(); listeners.add(cb); this.listeners.set(key, listeners);
    return { close: async () => { listeners.delete(cb); } };
  });
  tokenClose = vi.fn(async () => undefined);
  declareRosSubscriber = vi.fn(async () => ({ close: this.tokenClose }));
  get = vi.fn(async (_key: string, _opts?: TransportGetOptions): Promise<GetReply[]> => []);
  liveliness = { subscribe: async () => ({ close: async () => undefined }), get: async () => [] };
  close = async () => undefined;
  emit(name: string, message: unknown): void {
    const t = topic(name);
    for (const cb of this.listeners.get(t.dataKeyexpr) ?? []) cb({ keyexpr: t.dataKeyexpr.replace(/\/\*\*$/, ""), payload: encode(message), kind: "put" });
  }
}
class PipelineFake extends CloudPipeline {
  jobs: CloudJob[] = [];
  override submit(job: CloudJob): void { this.jobs.push(job); }
  override cancel = vi.fn();
  override close = vi.fn();
}
const cloud = (seconds: number): ParsedCloud => ({ stamp: BigInt(seconds) * 1_000_000_000n, frame: "sensor", count: 1,
  inputCount: 1, invalidCount: 0, sampledCount: 0, origin: [0, 0, 0], positions: new Float32Array([1, 2, 3]),
  fields: ["x", "y", "z"], scalars: {}, bounds: { min: [1, 2, 3], max: [1, 2, 3] }, bytes: 12 });

describe("ROS raw streams and history", () => {
  it("shares one raw subscription and one CPU endpoint announcement, closing only the last reference", async () => {
    const transport = new TransportFake(); const pool = new TopicStreamPool(transport); const a = vi.fn(); const b = vi.fn();
    const readout = await pool.subscribe(topic("/ouster/points").dataKeyexpr, a);
    const display = await pool.subscribe(topic("/ouster/points").dataKeyexpr, b, topic("/ouster/points"));
    const tab = await pool.subscribe(topic("/ouster/points").dataKeyexpr, vi.fn(), topic("/ouster/points"));
    transport.emit("/ouster/points", { n: 1 }); transport.emit("/ouster/points", { n: 2 });
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(2);
    expect(transport.subscribe).toHaveBeenCalledTimes(1); expect(transport.declareRosSubscriber).toHaveBeenCalledTimes(1);
    expect(transport.declareRosSubscriber).toHaveBeenCalledWith(expect.objectContaining({ bufferAware: true, domainId: 0 }));
    await display.close(); await tab.close(); expect(transport.tokenClose).not.toHaveBeenCalled();
    await readout.close(); await flush(); expect(transport.tokenClose).toHaveBeenCalledTimes(1);
    expect([...transport.listeners.values()][0].size).toBe(0);
  });
  it("closes a subscriber that resolves after teardown and allows a new session", async () => {
    const transport = new TransportFake(); let resolve!: (s: Subscription) => void; const close = vi.fn(async () => undefined);
    transport.subscribe.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pool = new TopicStreamPool(transport); const pending = pool.subscribe("key", vi.fn()); pool.closeAll();
    resolve({ close }); await pending; await flush(); expect(close).toHaveBeenCalledTimes(1);
    await pool.subscribe("key", vi.fn()); expect(transport.subscribe).toHaveBeenCalledTimes(2); pool.closeAll();
  });
  it("queries the advanced cache explicitly, keeps every publisher and filters foreign replies", async () => {
    const transport = new TransportFake(); const t = topic("/tf_static"); const base = t.dataKeyexpr.replace(/\/\*\*$/, "");
    transport.get.mockImplementation(async (key) => key.includes("@adv") ? [
      { keyexpr: base, payload: encode({ publisher: 1 }) }, { keyexpr: base, payload: encode({ publisher: 2 }) },
      { keyexpr: "foreign", payload: encode({}) }] : []);
    expect(await topicHistory(transport, t)).toHaveLength(2);
    expect(transport.get).toHaveBeenCalledWith(`${base}/@adv/**`, expect.objectContaining({ target: "all", consolidation: "none", acceptReplies: "any" }));
  });
  it("merges late static history even after a live transform arrives", async () => {
    const transport = new TransportFake(); let replies!: (r: GetReply[]) => void;
    transport.get.mockImplementation((key) => key.includes("@adv") ? new Promise((r) => { replies = r; }) : Promise.resolve([]));
    const source = new TfSource(transport, resolver, sceneConfig({ tf_topics: [], time_source: "live" }), 0);
    source.sync(graph); await flush();
    const tf = (parent: string, child: string) => ({ header: { frame_id: parent, stamp: { sec: 0, nanosec: 0 } }, child_frame_id: child,
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
    transport.emit("/tf_static", { transforms: [tf("base", "sensor")] });
    replies([{ keyexpr: topic("/tf_static").dataKeyexpr.replace(/\/\*\*$/, ""), payload: encode({ transforms: [tf("map", "base")] }) }]);
    await flush(); expect(source.tf.lookup("map", "sensor", 10n)).toEqual(identity()); source.close();
  });
});

describe("shared cloud and scene lifetimes", () => {
  it("refreshes same-epoch snapshots without resetting connected views, but restores them after explicit reset", async () => {
    const transport = new TransportFake();
    const stateGraph = buildGraph([...graph.topics.flatMap((t) => t.publishers.map((p) => p.keyexpr)), token("/state", "std_msgs::msg::dds_::String_")]);
    const source = new TfSource(transport, resolver, sceneConfig({ time_source: "ros_clock", playback_state_topic: "/state" }), 0);
    source.sync(stateGraph); await flush();
    const stateTopic = stateGraph.topics.find((t) => t.name === "/state")!;
    const send = (epoch: number, second: number) => {
      const value = { version: 1, run: "one", epoch, player: "/player", position: `${second}000000000`, begin: "1000000000", end: "20000000000",
        static: [], dynamic: [{ header: { frame_id: "map", stamp: { sec: second, nanosec: 0 } }, child_frame_id: "sensor",
          transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } }] };
      for (const cb of transport.listeners.get(stateTopic.dataKeyexpr) ?? []) cb({ keyexpr: stateTopic.dataKeyexpr, kind: "put", payload: encode({ data: JSON.stringify(value) }) });
    };
    send(1, 10); const initialEpoch = source.time.epoch;
    expect(source.tf.lookup("map", "sensor", 10_000_000_000n)).toEqual(identity());
    send(1, 11); expect(source.time.epoch).toBe(initialEpoch);
    source.reset("reload", false); send(1, 11);
    expect(source.tf.lookup("map", "sensor", 11_000_000_000n)).toEqual(identity());
    send(2, 5); expect(source.time.stamp).toBe(5_000_000_000n);
    send(1, 11); expect(source.time.stamp).toBe(5_000_000_000n); source.close();
  });
  it("decodes once for two views, rejects obsolete worker results, and releases the last worker", async () => {
    const transport = new TransportFake(); const pipeline = new PipelineFake(); const runtime = new Ros3DRuntime(transport, resolver, pipeline);
    const a = vi.fn(); const b = vi.fn(); const h1 = runtime.cloud(topic("/ouster/points"), 100, false, a);
    const h2 = runtime.cloud(topic("/ouster/points"), 100, true, b); await flush();
    transport.emit("/ouster/points", {}); expect(pipeline.jobs).toHaveLength(1); expect(pipeline.jobs[0].history).toBe(true);
    pipeline.jobs[0].done(cloud(1)); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    transport.emit("/ouster/points", {}); h1.feed.invalidate(); pipeline.jobs[1].done(cloud(2)); expect(a).toHaveBeenCalledTimes(1);
    h1.release(); expect(pipeline.close).not.toHaveBeenCalled(); h2.release(); expect(pipeline.close).toHaveBeenCalledTimes(1); runtime.close();
  });
  it("waits for TF, freezes history with ROS time, and resets both views on external clock jumps", async () => {
    const transport = new TransportFake(); const pipeline = new PipelineFake(); const runtime = new Ros3DRuntime(transport, resolver, pipeline);
    const config = sceneConfig({ fixed_frame: "map", time_source: "ros_clock", displays: [{ ...sceneConfig().displays[0], history_s: 3 }] });
    const a = new SceneModel(runtime, config); const b = new SceneModel(runtime, config); a.configure(config, graph); b.configure(config, graph); await flush();
    expect(a.source).toBe(b.source); transport.emit("/clock", { clock: { sec: 10, nanosec: 0 } });
    transport.emit("/ouster/points", {}); pipeline.jobs[0].done(cloud(10));
    expect(a.layers.get("ouster")!.pending).toHaveLength(1);
    a.source!.tf.insert({ ...identity(), parent: "map", child: "sensor", stamp: 0n }, true);
    a.tick(); b.tick(); expect(a.layers.get("ouster")!.scans).toHaveLength(1);
    a.tick(performance.now() + 60000); expect(a.layers.get("ouster")!.scans).toHaveLength(1);
    transport.emit("/clock", { clock: { sec: 5, nanosec: 0 } }); a.tick(); b.tick();
    expect(a.layers.get("ouster")!.scans).toHaveLength(0); expect(b.layers.get("ouster")!.scans).toHaveLength(0);
    a.close(); b.close(); expect(runtime.retention.used).toBe(0); runtime.close();
  });
  it("never moves an accumulated scan with a later sensor pose, and clears on frame changes", async () => {
    const transport = new TransportFake(); const pipeline = new PipelineFake(); const runtime = new Ros3DRuntime(transport, resolver, pipeline);
    const config = sceneConfig({ fixed_frame: "map", displays: [{ ...sceneConfig().displays[0], history_s: 3 }] });
    const model = new SceneModel(runtime, config); model.configure(config, graph); await flush();
    model.source!.tf.insert({ ...identity(), parent: "map", child: "sensor", stamp: 10_000_000_000n }, false);
    transport.emit("/ouster/points", {}); pipeline.jobs[0].done(cloud(10));
    model.source!.tf.insert({ ...identity(), translation: [10, 0, 0], parent: "map", child: "sensor", stamp: 11_000_000_000n }, false);
    expect(model.layers.get("ouster")!.scans[0].transform.translation).toEqual([0, 0, 0]);
    model.configure({ ...config, fixed_frame: "sensor" }, graph); expect(model.layers.get("ouster")!.scans).toHaveLength(0);
    model.close(); runtime.close();
  });
  it("evicts the oldest app-wide reservation and tolerates repeated release", () => {
    const budget = new RetentionBudget(100); const evict = vi.fn(); const first = budget.reserve(80, evict)!;
    const second = budget.reserve(50, vi.fn())!; expect(evict).toHaveBeenCalledTimes(1); first(); expect(budget.used).toBe(50);
    second(); second(); expect(budget.used).toBe(0); expect(budget.reserve(101, vi.fn())).toBeUndefined();
  });
});
