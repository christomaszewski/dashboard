import type { RosGraph } from "../ros/graph";
import { sceneConfig, type CloudDisplay, type Ros3DSceneConfig } from "./config";
import type { ParsedCloud } from "./pointCloud";
import type { RigidTransform } from "./math";
import { Ros3DRuntime, selectTopic, type CloudFeed, type TfSource } from "./runtime";
import { TfError } from "./tf";

export interface SceneScan { id: number; cloud: ParsedCloud; transform: RigidTransform; release: () => void; arrival: number }
export interface LayerState {
  display: CloudDisplay; scans: SceneScan[]; pending: { cloud: ParsedCloud; arrival: number; epoch: number; release: () => void }[];
  feed?: CloudFeed; release?: () => void; signature?: string; status: string; dropped: number; bytes: number;
}

/** Per-view scene history. This owns retention/TF waits; the renderer only mirrors accepted scans. */
export class SceneModel {
  readonly layers = new Map<string, LayerState>();
  source?: TfSource;
  config: Ros3DSceneConfig;
  error = "";
  version = 0;
  private releaseSource?: () => void;
  private sourceKey = "";
  private epoch = 0;
  private serial = 0;
  private lastClock: bigint | undefined;
  private lastClockArrival = 0;
  private closed = false;
  constructor(readonly runtime: Ros3DRuntime, config: Ros3DSceneConfig) { this.config = config; }

  configure(config: Ros3DSceneConfig, graph: RosGraph): void {
    if (this.closed) return;
    if (config.fixed_frame !== this.config.fixed_frame) this.clear();
    this.config = sceneConfig(config);
    const domain = config.domain_id ?? (graph.domains.length === 1 ? graph.domains[0] : undefined);
    const key = JSON.stringify([domain, config.tf_topics, config.tf_static_topics, config.time_source, config.clock_topic, config.tf_history_s, config.playback_state_topic, config.playback_service]);
    if (this.sourceKey !== key) {
      this.clear(); this.releaseSource?.(); this.source = undefined; this.sourceKey = key;
      for (const layer of this.layers.values()) { layer.release?.(); layer.release = undefined; layer.signature = undefined; }
      if (domain !== undefined) {
        const handle = this.runtime.source(config, domain); this.source = handle.source; this.epoch = this.source.time.epoch;
        this.releaseSource = handle.release;
      }
    }
    this.error = domain === undefined ? (graph.domains.length > 1 ? "Select a ROS domain" : "Waiting for the ROS graph") : "";
    this.source?.sync(graph);
    const ids = new Set(config.displays.map((d) => d.id));
    for (const [id, layer] of this.layers) if (!ids.has(id)) { this.clearLayer(layer); layer.release?.(); this.layers.delete(id); }
    for (const display of config.displays) {
      let layer = this.layers.get(display.id);
      if (!layer) { layer = { display, scans: [], pending: [], status: "waiting for topic", dropped: 0, bytes: 0 }; this.layers.set(display.id, layer); }
      layer.display = display;
      if (domain === undefined) continue;
      try {
        const topic = display.enabled ? selectTopic(graph, display.topic, domain, "sensor_msgs/msg/PointCloud2") : undefined;
        const signature = `${topic?.dataKeyexpr}|${config.max_cloud_points}|${display.history_s > 0}`;
        if (signature !== layer.signature) {
          layer.release?.(); layer.release = undefined; layer.feed = undefined; this.clearLayer(layer); layer.signature = signature;
          layer.status = display.enabled ? `waiting for ${display.topic}` : "disabled";
          if (topic) {
            const current = layer;
            const handle = this.runtime.cloud(topic, config.max_cloud_points, display.history_s > 0, (cloud) => {
              this.checkEpoch();
              if (this.closed) return;
              const now = performance.now();
              // A parsed cloud can be shared but is admitted to each scene at its own epoch.
              if (current.pending.some((p) => p.cloud === cloud) || current.scans.some((s) => s.cloud === cloud)) return;
              while (current.pending.length >= 8 || current.pending.reduce((n, p) => n + p.cloud.bytes, cloud.bytes) > 32 * 1024 * 1024) {
                if (!current.pending.length) { current.dropped++; current.status = "cloud exceeds pending memory budget"; return; }
                current.pending.shift()!.release(); current.dropped++;
              }
              if (!current.display.history_s && current.pending.length) {
                current.dropped += current.pending.length; for (const p of current.pending) p.release(); current.pending = [];
              }
              const pending = { cloud, arrival: now, epoch: this.epoch, release: () => undefined as void };
              const release = this.runtime.retention.reserve(cloud.bytes, () => {
                const index = current.pending.indexOf(pending); if (index >= 0) current.pending.splice(index, 1);
                current.dropped++; current.status = "application pending memory limit reached";
              });
              if (!release) { current.dropped++; current.status = "cloud exceeds application memory limit"; return; }
              pending.release = release;
              current.pending.push(pending); this.tick(now);
            });
            layer.feed = handle.feed; layer.release = handle.release;
          }
        }
      } catch (e) { layer.release?.(); layer.release = undefined; layer.feed = undefined; layer.signature = undefined; this.clearLayer(layer); layer.status = String(e); }
    }
    this.tick();
  }

  private checkEpoch(): void {
    if (this.source && this.epoch !== this.source.time.epoch) {
      this.epoch = this.source.time.epoch; this.clear(); this.lastClock = undefined;
    }
  }
  tick(now = performance.now()): void {
    this.checkEpoch();
    const source = this.source; if (!source) return;
    const clock = source.time.stamp;
    if (clock !== this.lastClock) { this.lastClock = clock; this.lastClockArrival = now; }
    const timeAdvancing = this.config.time_source === "live" || (clock !== undefined && now - this.lastClockArrival < 500);
    for (const layer of this.layers.values()) {
      const keep: LayerState["pending"] = [];
      const processing = [...layer.pending];
      for (const pending of processing) {
        if (!layer.pending.includes(pending)) continue;
        if (pending.epoch !== this.epoch) { pending.release(); continue; }
        if (!this.config.fixed_frame) { layer.status = "Select a fixed frame"; keep.push(pending); continue; }
        if (this.config.time_source === "ros_clock" && clock === undefined) { layer.status = "waiting for playback clock"; keep.push(pending); continue; }
        // Old in-flight samples after a seek cannot attach to the new timeline.
        if (clock !== undefined && this.config.time_source === "ros_clock" &&
            (pending.cloud.stamp > clock + 2_000_000_000n || pending.cloud.stamp < clock - BigInt(this.config.tf_history_s) * 1_000_000_000n)) {
          pending.release(); layer.dropped++; layer.status = "cloud outside current playback interval"; continue;
        }
        try {
          const transform = source.tf.lookup(this.config.fixed_frame, pending.cloud.frame, pending.cloud.stamp);
          pending.release();
          if (!layer.display.history_s && layer.scans.some((s) => s.cloud.stamp > pending.cloud.stamp)) { layer.dropped++; continue; }
          if (layer.scans.some((s) => s.cloud.stamp === pending.cloud.stamp && s.cloud.frame === pending.cloud.frame)) continue;
          if (!layer.display.history_s) this.clearScans(layer);
          const scan: SceneScan = { id: ++this.serial, cloud: pending.cloud, transform, arrival: now, release: () => undefined };
          // Conservative CPU + GPU estimate; shared CPU arrays may be counted more than once.
          const cost = pending.cloud.bytes * 2 + pending.cloud.count * 16;
          const release = this.runtime.retention.reserve(cost, () => { this.remove(layer, scan); layer.dropped++; layer.status = "application memory limit reached"; });
          if (!release) { layer.dropped++; layer.status = "cloud exceeds application memory limit"; continue; }
          scan.release = release; layer.scans.push(scan); layer.bytes += cost;
          layer.scans.sort((a, b) => a.cloud.stamp < b.cloud.stamp ? -1 : a.cloud.stamp > b.cloud.stamp ? 1 : 0);
          source.time.observeCloud(pending.cloud.stamp);
          layer.status = pending.cloud.count ? "ok" : "empty cloud"; this.version++;
        } catch (e) {
          const waitable = !(e instanceof TfError) || ["unknown-frame", "disconnected", "future", "past"].includes(e.code);
          layer.status = e instanceof Error ? e.message : String(e);
          // Paused playback can acquire its TF snapshot asynchronously; queues remain byte/count bounded.
          if (waitable && (!timeAdvancing || now - pending.arrival <= this.config.tf_wait_ms)) keep.push(pending);
          else { pending.release(); layer.dropped++; }
        }
      }
      layer.pending = keep.filter((p) => layer.pending.includes(p));
      if (layer.display.history_s) {
        for (const scan of [...layer.scans]) {
          const expired = this.config.time_source === "ros_clock"
            ? source.time.stamp !== undefined && scan.cloud.stamp < source.time.stamp - BigInt(Math.round(layer.display.history_s * 1e9))
            : now - scan.arrival > layer.display.history_s * 1000;
          if (expired) this.remove(layer, scan);
        }
      } else while (layer.scans.length > 1) this.remove(layer, layer.scans[0]);
    }
    const count = () => [...this.layers.values()].reduce((n, l) => n + l.scans.reduce((sum, s) => sum + s.cloud.count, 0), 0);
    const bytes = () => [...this.layers.values()].reduce((n, l) => n + l.bytes, 0);
    while (count() > this.config.max_points || bytes() > this.config.max_memory_mb * 1024 * 1024) {
      const oldest = [...this.layers.values()].filter((l) => l.scans.length).sort((a, b) => a.scans[0].arrival - b.scans[0].arrival)[0];
      if (!oldest) break; this.remove(oldest, oldest.scans[0]); oldest.dropped++; oldest.status = "scene point/memory limit reached";
    }
  }
  private remove(layer: LayerState, scan: SceneScan): void {
    const index = layer.scans.indexOf(scan); if (index < 0) return;
    layer.scans.splice(index, 1); layer.bytes -= scan.cloud.bytes * 2 + scan.cloud.count * 16; scan.release(); this.version++;
  }
  private clearScans(layer: LayerState): void { for (const scan of [...layer.scans]) this.remove(layer, scan); }
  private clearLayer(layer: LayerState): void { this.clearScans(layer); for (const pending of layer.pending) pending.release(); layer.pending = []; }
  clear(): void { for (const layer of this.layers.values()) this.clearLayer(layer); this.version++; }
  reset(reason = "view reset"): void { this.source?.reset(reason); this.checkEpoch(); }
  close(): void {
    this.closed = true; this.clear(); for (const layer of this.layers.values()) layer.release?.();
    this.releaseSource?.(); this.layers.clear();
  }
}
