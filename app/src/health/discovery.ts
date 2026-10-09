import type { Subscription, Transport } from "../transport/types";
import type { TopicEntry } from "../ros/graph";
import { SeriesBuffer, type SeriesPoint } from "../home/widgets/primitives/series";
import { diagnosticIdentity, diagnosticStatuses } from "./diagnostics";
import { HEALTH_PATTERN, HEALTH_STATE_PATTERN, parseHealthKey, parseHealthSnapshot, metricUnit,
  statusCurrent, type HealthService, type HealthSnapshot, type HealthStatus } from "./types";

export const HEALTH_OFFLINE_GRACE_MS = 15_000; // retained API; offline entries now persist for this session
export const HEALTH_HISTORY_MS = 10 * 60_000;
const NO_POINTS: readonly SeriesPoint[] = [];
const seriesKey = (key: string, name: string, value: string) => `${key}\n${name}\n${value}`;
export interface HealthEvent { atMs: number; key: string; name: string; level: number; message: string; }

/** Shared native/ROS store. Each ROS status is an independent observation, not a full snapshot. */
export class HealthDiscovery {
  private subs: Subscription[] = [];
  private closed = false;
  private services = new Map<string, HealthService>();
  private history = new Map<string, SeriesBuffer>();
  private samples = new Map<string, string>();
  private generations = new Map<string, number>();
  private presence = new Map<string, boolean>();
  private retired = new Map<string, Set<string>>();
  private eventIds = new Set<string>();
  readonly events: HealthEvent[] = [];
  private onChange: (services: HealthService[]) => void = () => undefined;

  constructor(private transport: Transport, _graceMs = HEALTH_OFFLINE_GRACE_MS) { void _graceMs; }
  private emit() { if (!this.closed) this.onChange([...this.services.values()].sort((a, b) => a.key.localeCompare(b.key))); }
  private generation(key: string) { const n = (this.generations.get(key) ?? 0) + 1; this.generations.set(key, n); return n; }
  private async keep(sub: Subscription) { if (this.closed) await sub.close(); else this.subs.push(sub); }

  async start(onChange: (services: HealthService[]) => void): Promise<void> {
    this.onChange = onChange;
    await this.keep(await this.transport.liveliness.subscribe(HEALTH_PATTERN, (e) => {
      if (this.closed || !parseHealthKey(e.keyexpr)) return;
      this.presence.set(e.keyexpr, e.alive);
      const generation = this.generation(e.keyexpr);
      if (!e.alive) {
        const old = this.services.get(e.keyexpr);
        if (old?.source !== "ros2" && old) this.services.set(e.keyexpr, { ...old, alive: false });
        this.emit();
      } else void this.fetch(e.keyexpr, generation);
    }));
    if (this.closed) return;
    await this.keep(await this.transport.subscribe(HEALTH_STATE_PATTERN, (sample) => {
      if (this.closed || sample.kind !== "put") return;
      const key = sample.keyexpr.replace(/\/state$/, "");
      if (this.presence.get(key) === false) return;
      this.generation(key); // an in-flight query must never replace a newer publication
      this.applyNative(key, sample.payload);
    }));
  }

  series(key: string, name: string, metric: string): readonly SeriesPoint[] {
    return this.history.get(seriesKey(key, name, metric))?.points ?? NO_POINTS;
  }

  private accept(key: string, incoming: HealthStatus, previous?: HealthStatus): boolean {
    if (!previous) return true;
    const boot = incoming.values["health.publisher_id"], oldBoot = previous.values["health.publisher_id"];
    const id = `${key}\n${incoming.name}`;
    if (typeof boot !== "string" || typeof oldBoot !== "string") return true;
    if (this.retired.get(id)?.has(boot)) return false;
    if (boot !== oldBoot) {
      const retired = this.retired.get(id) ?? new Set<string>();
      retired.add(oldBoot);
      this.retired.set(id, retired);
      return true;
    }
    const seq = incoming.values["health.sequence"], oldSeq = previous.values["health.sequence"];
    return typeof seq !== "number" || typeof oldSeq !== "number" || seq > oldSeq;
  }

  private applyNative(key: string, bytes: Uint8Array) {
    const identity = parseHealthKey(key), snapshot = parseHealthSnapshot(bytes);
    if (!identity || !snapshot || snapshot.instance !== identity.instance) return;
    const old = this.services.get(key);
    const sourceKey = `native/${key}`;
    const first = snapshot.status[0], oldFirst = old?.source === "native" ? old.snapshot.status[0] : undefined;
    const boot = first?.values["health.publisher_id"], oldBoot = oldFirst?.values["health.publisher_id"];
    if (typeof boot === "string" && this.retired.get(sourceKey)?.has(boot)) return;
    if (first && !this.accept(sourceKey, first, oldFirst)) return;
    if (typeof boot === "string" && typeof oldBoot === "string" && boot !== oldBoot) {
      const retired = this.retired.get(sourceKey) ?? new Set<string>();
      retired.add(oldBoot);
      this.retired.set(sourceKey, retired);
    }
    const now = Date.now();
    snapshot.status = snapshot.status.map((s) => ({ ...s, receivedAtMs: now, receivedMonoMs: performance.now() }));
    this.save({ key, ...identity, snapshot, alive: true, receivedAtMs: now, source: "native", sourceLabel: "Zenoh JSON",
      periodMs: old ? now - old.receivedAtMs : undefined }, old);
    this.emit();
  }

  ingestRos(topic: TopicEntry, message: Record<string, unknown>, ttlMs = 15_000) {
    if (this.closed) return;
    const now = Date.now();
    for (const row of diagnosticStatuses(message)) {
      const { key, service, ...identity } = diagnosticIdentity(topic, row);
      const old = this.services.get(key);
      // Owned services choose one transport. A live native publisher is authoritative.
      if (old?.source === "native" && old.alive && (old.receivedMonoMs === undefined ? now - old.receivedAtMs : performance.now() - old.receivedMonoMs) <= 5_000) continue;
      let previous = old?.source === "ros2" ? old.snapshot.status : [];
      // Fleet metadata identifies one authoritative reporter per instance. A new boot
      // starts a new component inventory; old faults remain in the event journal.
      const sourceKey = `ros2/${key}`;
      const boot = row.values["health.publisher_id"];
      const oldBoot = previous.find((s) => typeof s.values["health.publisher_id"] === "string")?.values["health.publisher_id"];
      if (typeof boot === "string" && this.retired.get(sourceKey)?.has(boot)) continue;
      if (typeof boot === "string" && typeof oldBoot === "string" && boot !== oldBoot) {
        const retired = this.retired.get(sourceKey) ?? new Set<string>();
        retired.add(oldBoot);
        this.retired.set(sourceKey, retired);
        previous = [];
      }
      if (!this.accept(sourceKey, row, previous.find((s) => s.name === row.name))) continue;
      const incoming = { ...row, receivedAtMs: now, receivedMonoMs: performance.now() };
      const status = [...previous.filter((s) => s.name !== row.name), incoming];
      const snapshot: HealthSnapshot = { schema_version: 1, service, instance: identity.instance, stamp_unix_ns: 0, level: 0, status };
      this.save({ key, ...identity, snapshot, alive: true, receivedAtMs: now, source: "ros2", fallbackTtlMs: ttlMs,
        sourceLabel: `ROS 2 · domain ${topic.domainId} · ${topic.name}` }, old, [incoming]);
    }
    this.emit();
  }

  private event(event: HealthEvent, id?: string) {
    if (id && this.eventIds.has(id)) return;
    if (id) {
      this.eventIds.add(id);
      if (this.eventIds.size > 2_000) this.eventIds.delete(this.eventIds.values().next().value!);
    }
    this.events.unshift(event);
    this.events.splice(200);
  }

  private save(service: HealthService, old?: HealthService, incoming = service.snapshot.status) {
    service.receivedMonoMs = performance.now();
    this.services.set(service.key, service);
    for (const status of incoming) {
      const previous = old?.snapshot.status.find((s) => s.name === status.name);
      if ((!previous && status.level !== 0) || (previous && (previous.level !== status.level || previous.values["alert.active"] !== status.values["alert.active"]))) {
        this.event({ atMs: service.receivedAtMs, key: service.key, name: status.name, level: status.level, message: status.message });
      }
      // The sensor's bounded trigger/clear log can include faults that came and went between polls.
      const log = status.values["alerts.log"];
      if (typeof log === "string") {
        try {
          const entries: unknown = JSON.parse(log);
          if (Array.isArray(entries)) for (const entry of entries.slice(-32)) {
            if (!entry || typeof entry.id !== "string" || !Number.isSafeInteger(entry.cursor)) continue;
            this.event({ atMs: service.receivedAtMs, key: service.key, name: `${service.instance}: alert/${entry.id}`,
              level: entry.active === false ? 0 : entry.level === "ERROR" ? 2 : entry.level === "WARNING" ? 1 : 0,
              message: `${entry.active === false ? "cleared" : "triggered"} · ${String(entry.msg ?? entry.id)}` },
              `${service.key}/${String(status.values["alerts.epoch"])}/${entry.cursor}`);
          }
        } catch { /* malformed vendor history cannot invalidate current conditions */ }
      }
      if (!statusCurrent(service, status, service.receivedAtMs) || status.values["health.availability"] === "retrying") continue;
      for (const [metric, value] of Object.entries(status.values)) {
        if (typeof value !== "number" || metricUnit(metric) === null) continue;
        const key = seriesKey(service.key, status.name, metric);
        const sample = status.values["health.sample_id"];
        if (typeof sample === "string" && this.samples.get(key) === sample) continue;
        if (typeof sample === "string") this.samples.set(key, sample);
        let buffer = this.history.get(key);
        if (!buffer) this.history.set(key, buffer = new SeriesBuffer(HEALTH_HISTORY_MS, 1_200));
        buffer.push(service.receivedAtMs, value);
      }
    }
  }

  private async fetch(key: string, generation: number) {
    try {
      const [reply] = await this.transport.get(key);
      if (reply && !this.closed && this.generations.get(key) === generation && this.presence.get(key)) this.applyNative(key, reply.payload);
    } catch { /* next publication recovers a failed query */ }
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.subs.map((s) => s.close()));
    this.subs = [];
  }
}
