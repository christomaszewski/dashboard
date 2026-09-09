import type { RosGraph, TopicEntry } from "../ros/graph";
import type { Decoder, SchemaResolver } from "../schema/types";
import type { Sample, Subscription, Transport } from "../transport/types";
import { topicStreams } from "../ros/topicStreamPool";
import { topicHistory } from "../ros/topicHistory";
import { decodeAttachment } from "../services/attachment";
import { CloudPipeline } from "./cloudPipeline";
import type { ParsedCloud } from "./pointCloud";
import type { Ros3DSceneConfig } from "./config";
import { TfBuffer, readTransform } from "./tf";
import { stampNs } from "./math";
import { SceneTime } from "./time";
import { RetentionBudget } from "./retentionBudget";
import { readReplayState, type ReplayState } from "./replayState";

export function selectTopic(graph: RosGraph, name: string, domain: number, type: string): TopicEntry | undefined {
  const entries = graph.topics.filter((t) => t.name === name && t.domainId === domain);
  if (entries.length > 1) throw new Error(`ambiguous topic ${name} in domain ${domain} (multiple type/hash identities)`);
  if (entries[0] && entries[0].typeName !== type) throw new Error(`${name} is ${entries[0].typeName}; expected ${type}`);
  return entries[0];
}
function publisherMeta(sample: Pick<Sample, "attachment">): { authority?: string; sequence?: bigint } {
  if (!sample.attachment) return {};
  try {
    const meta = decodeAttachment(sample.attachment);
    return { authority: Array.from(meta.gid, (b) => b.toString(16).padStart(2, "0")).join(""), sequence: meta.sequenceNumber };
  } catch { return {}; }
}
interface DecodedStream { close(): void; seed(): void }

/** All-sample decoding with a bounded startup queue, used only for small TF/clock messages. */
export function decodedStream(transport: Transport, resolver: SchemaResolver, topic: TopicEntry,
  receive: (message: Record<string, unknown>, sample: Sample) => void, error: (message: string) => void, staticHistory: boolean): DecodedStream {
  let closed = false; let sub: Subscription | undefined; let decoder: Decoder | undefined;
  let queue: Sample[] = []; let bytes = 0; let query = 0;
  const process = (sample: Sample) => {
    if (closed || sample.kind !== "put") return;
    if (sample.payload.byteLength > 4 * 1024 * 1024) { error(`${topic.name}: TF/clock message exceeds 4 MiB`); return; }
    if (!decoder) {
      if (queue.length >= 4096 || bytes + sample.payload.byteLength > 8 * 1024 * 1024) { error(`${topic.name}: decoder startup queue overflow`); return; }
      queue.push(sample); bytes += sample.payload.byteLength; return;
    }
    try { receive(decoder.decode(sample.payload), sample); }
    catch (e) { error(`${topic.name}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const seed = () => {
    if (!staticHistory || closed || !sub) return;
    const generation = ++query;
    void topicHistory(transport, topic).then((replies) => {
      if (closed || generation !== query) return;
      for (const reply of replies) process({ ...reply, kind: "put" });
    }).catch((e) => { if (!closed) error(`${topic.name}: static history query failed: ${String(e)}`); });
  };
  void topicStreams(transport).subscribe(topic.dataKeyexpr, process, topic).then((s) => {
    if (closed) void s.close(); else { sub = s; seed(); }
  }).catch((e) => { if (!closed) error(`${topic.name}: subscription failed: ${String(e)}`); });
  void resolver.resolve({ flavor: "ros2", typeName: topic.typeName, rihsHash: topic.typeHash }).then((d) => {
    if (closed) return;
    decoder = d; const pending = queue; queue = []; bytes = 0;
    for (const sample of pending) process(sample);
  }).catch((e) => { if (!closed) { queue = []; bytes = 0; error(`${topic.name}: decoder failed: ${String(e)}`); } });
  return { close: () => { closed = true; query++; queue = []; void sub?.close(); }, seed };
}

export class TfSource {
  replay?: ReplayState;
  private needsSnapshot = true;
  readonly tf: TfBuffer;
  readonly time: SceneTime;
  readonly listeners = new Set<() => void>();
  readonly errors = new Map<string, string>();
  private streams: DecodedStream[] = [];
  private signature = "";
  private sequence = new Map<string, bigint>();
  private closed = false;
  refs = 0;
  constructor(private transport: Transport, private resolver: SchemaResolver, readonly config: Ros3DSceneConfig, readonly domain: number,
    private onReset: () => void = () => undefined) {
    this.tf = new TfBuffer(BigInt(config.tf_history_s) * 1_000_000_000n);
    this.time = new SceneTime(config.time_source);
  }
  private notify(): void { for (const cb of [...this.listeners]) cb(); }
  reset(reason: string, keepStatic = true): void {
    this.needsSnapshot = true;
    this.tf.clear(keepStatic); this.time.reset(reason);
    if (!keepStatic) for (const key of this.sequence.keys()) if (!key.endsWith("/clock")) this.sequence.delete(key);
    this.onReset();
    for (const stream of this.streams) stream.seed();
    this.notify();
  }
  sync(graph: RosGraph): void {
    const specs = [...this.config.tf_topics.map((name) => ({ name, static: false, clock: false, state: false })),
      ...this.config.tf_static_topics.map((name) => ({ name, static: true, clock: false, state: false })),
      ...(this.config.time_source === "ros_clock" ? [{ name: this.config.clock_topic, static: false, clock: true, state: false },
        ...(this.config.playback_state_topic ? [{ name: this.config.playback_state_topic, static: false, clock: false, state: true }] : [])] : [])];
    let resolved: { spec: typeof specs[number]; topic: TopicEntry | undefined }[];
    try {
      resolved = specs.map((spec) => ({ spec, topic: selectTopic(graph, spec.name, this.domain, spec.state ? "std_msgs/msg/String" : spec.clock ? "rosgraph_msgs/msg/Clock" : "tf2_msgs/msg/TFMessage") }));
      for (const { spec, topic } of resolved) if ((spec.clock || spec.state) && (topic?.publishers.length ?? 0) > 1)
        throw new Error(`${spec.name}: multiple time/replay publishers; choose one authoritative source`);
    } catch (e) {
      this.errors.set("discovery", String(e));
      if (this.signature) {
        for (const stream of this.streams) stream.close(); this.streams = []; this.signature = "";
        this.replay = undefined; this.reset("ambiguous TF/time discovery", false);
      }
      return;
    }
    this.errors.delete("discovery");
    const signature = resolved.map(({ topic, spec }) => `${spec.name}:${topic?.dataKeyexpr}:${topic?.publishers.map((p) => p.keyexpr).sort().join(",")}`).join("|");
    if (this.signature === signature) return;
    const previous = this.signature; this.signature = signature;
    for (const stream of this.streams) stream.close(); this.streams = [];
    this.errors.clear();
    if (previous) { this.replay = undefined; this.sequence.clear(); this.reset("TF/clock publishers changed", false); }
    for (const { spec, topic } of resolved) {
      if (!topic) { if (!spec.state) this.errors.set(spec.name, `waiting for ${spec.name}`); continue; }
      this.streams.push(decodedStream(this.transport, this.resolver, topic, (message, sample) => {
        if (this.closed) return;
        this.errors.delete(spec.name);
        if (spec.state) {
          const state = readReplayState(message.data);
          if (this.config.playback_service && state.player !== this.config.playback_service) return;
          if (this.replay?.run === state.run && (this.replay.epoch > state.epoch || this.replay.epoch === state.epoch && !this.needsSnapshot)) return;
          this.reset("playback snapshot", false); this.replay = state; this.needsSnapshot = false;
          for (const tf of state.static) this.tf.insert(tf, true);
          for (const tf of state.dynamic) this.tf.insert(tf, false);
          this.time.update(state.position);
        } else if (spec.clock) {
          const meta = publisherMeta(sample);
          const key = `${meta.authority ?? "unknown"}/clock`;
          if (meta.sequence !== undefined) {
            if ((this.sequence.get(key) ?? -1n) >= meta.sequence) return;
            this.sequence.set(key, meta.sequence);
          }
          const stamp = stampNs(message.clock);
          if (this.replay && stamp < this.replay.position) return;
          if (this.time.update(stamp)) {
            this.tf.clear(true);
            this.onReset();
            for (const stream of this.streams) stream.seed();
          }
        } else {
          if (!Array.isArray(message.transforms) || message.transforms.length > 4096) throw new Error("invalid TFMessage transforms");
          const meta = publisherMeta(sample);
          for (const raw of message.transforms) {
            try {
              const transform = readTransform(raw, this.replay ? `replay/${this.replay.run}` : meta.authority);
              const key = `${meta.authority ?? "unknown"}/${transform.child}`;
              // Static replay must not overwrite newer live values from the same publisher.
              if (spec.static && meta.sequence !== undefined) {
                const old = this.sequence.get(key);
                if (old !== undefined && old >= meta.sequence) continue;
                this.sequence.set(key, meta.sequence);
              }
              this.tf.insert(transform, spec.static);
            } catch (e) { this.errors.set(spec.name, String(e)); }
          }
        }
        this.notify();
      }, (error) => { this.errors.set(spec.name, error); this.notify(); }, spec.static || spec.state || spec.clock && topic.transientLocal));
    }
  }
  close(): void { this.closed = true; for (const stream of this.streams) stream.close(); this.streams = []; this.listeners.clear(); }
}

export interface CloudFeed {
  key: string; domain: number; latest?: ParsedCloud; error?: string; warning?: string;
  received: number; dropped: number; lastArrival?: number; hz: number; history: Map<(cloud: ParsedCloud) => void, boolean>;
  listeners: Set<(cloud: ParsedCloud) => void>;
  close(): void;
  invalidate(): void;
}

/** Per-transport sharing: TF sources and cloud parsing are reused by widget/tab canvases. */
export class Ros3DRuntime {
  private sources = new Map<string, TfSource>();
  private feeds = new Map<string, CloudFeed>();
  readonly pipeline: CloudPipeline;
  readonly retention = new RetentionBudget();
  playbackChange(domain: number, change: { reset?: boolean; rate?: number }): void {
    for (const source of this.sources.values()) if (source.domain === domain && source.config.time_source === "ros_clock") {
      if (change.reset) source.reset("playback seek");
      if (change.rate !== undefined) source.time.setRate(change.rate);
    }
  }
  constructor(readonly transport: Transport, private resolver: SchemaResolver, pipeline?: CloudPipeline) {
    this.pipeline = pipeline ?? new CloudPipeline();
  }
  source(config: Ros3DSceneConfig, domain: number): { source: TfSource; release(): void } {
    const key = JSON.stringify([domain, config.tf_topics, config.tf_static_topics, config.time_source, config.clock_topic, config.tf_history_s, config.playback_state_topic, config.playback_service]);
    let source = this.sources.get(key);
    if (!source) { source = new TfSource(this.transport, this.resolver, config, domain, () => {
      for (const feed of this.feeds.values()) if (feed.domain === domain) feed.invalidate();
    }); this.sources.set(key, source); }
    source.refs++; let released = false;
    return { source, release: () => {
      if (released) return; released = true;
      if (--source.refs === 0) { source.close(); this.sources.delete(key); }
    } };
  }
  cloud(topic: TopicEntry, maxPoints: number, history: boolean, listener: (cloud: ParsedCloud) => void): { feed: CloudFeed; release(): void } {
    const key = `${topic.dataKeyexpr}|${maxPoints}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      let closed = false; let subscription: Subscription | undefined; let generation = 0;
      const times: number[] = [];
      const current: CloudFeed = { key, domain: topic.domainId, received: 0, dropped: 0, hz: 0, listeners: new Set(), history: new Map(),
        invalidate: () => { generation++; this.pipeline.cancel(key); current.latest = undefined; seed(); }, close: () => {
        closed = true; this.pipeline.cancel(key); void subscription?.close(); current.latest = undefined;
      } };
      feed = current; this.feeds.set(key, current);
      const receive = (sample: Sample, historical = false) => {
        if (closed || sample.kind !== "put" || sample.keyexpr.includes("/_buf/")) return;
        const now = performance.now();
        if (!historical) {
          current.received++; current.lastArrival = now;
          times.push(now); while (times.length > 100 || (times.length > 1 && times[0] < now - 5000)) times.shift();
          current.hz = times.length > 1 ? (times.length - 1) * 1000 / (now - times[0] || 1) : 0;
        }
        const epoch = generation;
        this.pipeline.submit({ key, payload: sample.payload, maxPoints, history: [...current.history.values()].some(Boolean),
          done: (cloud, warning) => {
            if (closed || epoch !== generation) return;
            current.latest = cloud; current.error = undefined; current.warning = warning ?? cloud.warning;
            // Cached latest clouds have a separate app-wide budget; retained scene scans are managed by their owners.
            let bytes = [...this.feeds.values()].reduce((n, f) => n + (f.latest?.bytes ?? 0), 0);
            for (const f of this.feeds.values()) if (bytes > 64 * 1024 * 1024 && f !== current) { bytes -= f.latest?.bytes ?? 0; f.latest = undefined; }
            for (const cb of [...current.listeners]) cb(cloud);
          }, error: (error) => { if (!closed && epoch === generation) current.error = error; }, dropped: () => { if (!closed) current.dropped++; } });
      };
      const seed = () => {
        if (closed || !subscription || !topic.transientLocal) return;
        const epoch = generation;
        void topicHistory(this.transport, topic, 64 * 1024 * 1024).then((replies) => {
          if (!closed && epoch === generation && !current.latest) for (const reply of replies) receive({ ...reply, kind: "put" }, true);
        }).catch((error) => { if (!closed) current.error = String(error); });
      };
      void topicStreams(this.transport).subscribe(topic.dataKeyexpr, receive, topic).then((sub) => {
        if (closed) void sub.close(); else {
          subscription = sub; seed();
        }
      })
        .catch((e) => { if (!closed) current.error = String(e); });
    }
    const current = feed; current.listeners.add(listener); current.history.set(listener, history);
    if (current.latest) listener(current.latest);
    let released = false;
    return { feed: current, release: () => {
      if (released) return; released = true; current.listeners.delete(listener); current.history.delete(listener);
      if (!current.listeners.size) { current.close(); this.feeds.delete(key); if (!this.feeds.size) this.pipeline.close(); }
    } };
  }
  close(): void { for (const s of this.sources.values()) s.close(); for (const f of this.feeds.values()) f.close(); this.sources.clear(); this.feeds.clear(); this.pipeline.close(); }
}

const runtimes = new WeakMap<Transport, Ros3DRuntime>();
export function playbackChange(transport: Transport, domain: number, change: { reset?: boolean; rate?: number }): void {
  runtimes.get(transport)?.playbackChange(domain, change);
}
export function ros3dRuntime(transport: Transport, resolver: SchemaResolver): Ros3DRuntime {
  let runtime = runtimes.get(transport);
  if (!runtime) { runtime = new Ros3DRuntime(transport, resolver); runtimes.set(transport, runtime); }
  return runtime;
}
