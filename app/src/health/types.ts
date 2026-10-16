// Service health — camera-service docs/HEALTH.md is the source of truth:
//
//   fleet/<vehicle_id>/svc/<instance>/health          liveliness token + queryable → the latest snapshot
//   fleet/<vehicle_id>/svc/<instance>/health/state    publisher: every snapshot (the producer's poll interval)
//
// Generic by design, like the lifecycle keys beside it: any service may publish health; <instance>
// is the same segment the lifecycle and media keys use, so a camera's stream, its recorder control
// and its health line up by name. The snapshot is diagnostic_msgs/DiagnosticArray as JSON — levels
// are the DiagnosticStatus byte values, status names are "<instance>: <component>", values are flat
// scalars, and every temperature is `temp.<where>_c` in °C, so this consumer finds them with no
// knowledge of the device.
import type { ValueLevel } from "../home/value";

export const HEALTH_PATTERN = "fleet/*/svc/*/health";
export const HEALTH_STATE_PATTERN = "fleet/*/svc/*/health/state";
/** The schema this consumer reads; the producer increments it on any breaking change. */
export const HEALTH_SCHEMA_VERSION = 1;

/** DiagnosticStatus.level: 0 OK · 1 WARN · 2 ERROR · 3 STALE (no data). */
export type HealthLevel = 0 | 1 | 2 | 3;
export const HEALTH_LEVEL_NAMES = ["OK", "WARN", "ERROR", "STALE"] as const;
const LEVEL_CLASSES: readonly ValueLevel[] = ["ok", "warn", "err", "idle"];

export type HealthValue = number | string | boolean | null;

export interface HealthStatus {
  receivedAtMs?: number;
  receivedMonoMs?: number;
  level: HealthLevel;
  name: string; // "<instance>: <component>"
  message: string;
  hardware_id: string; // "" for host-side components
  values: Record<string, HealthValue>;
}

export interface HealthSnapshot {
  schema_version: number;
  service: string; // e.g. "camera-service"
  instance: string; // MUST equal the key's <instance> segment
  stamp_unix_ns: number; // the PRODUCER's wall clock — display only (see HealthService.receivedAtMs)
  level: HealthLevel; // worst status[].level
  status: HealthStatus[];
}

export interface HealthService {
  receivedMonoMs?: number;
  source?: "native" | "ros2";
  sourceLabel?: string;
  fallbackTtlMs?: number;
  key: string; // fleet/<vehicle>/svc/<instance>/health
  vehicleId: string;
  instance: string;
  snapshot: HealthSnapshot;
  /** false = liveliness token dropped; held for a grace period (crash restarts re-advertise). */
  alive: boolean;
  /** This browser's clock when the snapshot arrived. Staleness is judged against it, never against
   *  `stamp_unix_ns`: a vehicle without NTP and a laptop rarely agree on the time. */
  receivedAtMs: number;
  /** Gap between the last two snapshots — the producer's publish interval as observed here. */
  periodMs?: number;
}

/** `fleet/<vehicle>/svc/<instance>/health` → its segments, or null for anything else. */
export function parseHealthKey(key: string): { vehicleId: string; instance: string } | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "fleet" || parts[2] !== "svc" || parts[4] !== "health") return null;
  if (parts[1] === "" || parts[3] === "") return null;
  return { vehicleId: parts[1], instance: parts[3] };
}

function isLevel(v: unknown): v is HealthLevel {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

export function parseStatus(raw: unknown): HealthStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!isLevel(s.level) || typeof s.name !== "string" || s.name === "") return null;
  const values: Record<string, HealthValue> = {};
  if (typeof s.values === "object" && s.values !== null && !Array.isArray(s.values)) {
    for (const [k, v] of Object.entries(s.values)) {
      // The contract: flat scalars. Anything else is a producer bug — dropped, not rendered.
      if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) values[k] = v;
    }
  }
  return {
    level: s.level,
    name: s.name,
    message: typeof s.message === "string" ? s.message : "",
    hardware_id: typeof s.hardware_id === "string" ? s.hardware_id : "",
    values,
  };
}

/** Parse + validate a snapshot payload (queryable reply or `state` publication). null = malformed
 *  or a schema this consumer does not read. A malformed status entry is dropped on its own — one
 *  bad component must not hide the others. */
export function parseHealthSnapshot(bytes: Uint8Array): HealthSnapshot | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const d = obj as Record<string, unknown>;
    if (d.schema_version !== HEALTH_SCHEMA_VERSION) return null;
    if (typeof d.service !== "string" || typeof d.instance !== "string" || !Array.isArray(d.status)) return null;
    const status = d.status.map(parseStatus).filter((s): s is HealthStatus => s !== null);
    return {
      schema_version: HEALTH_SCHEMA_VERSION,
      service: d.service,
      instance: d.instance,
      stamp_unix_ns: typeof d.stamp_unix_ns === "number" ? d.stamp_unix_ns : 0,
      level: worstLevel(status),
      status,
    };
  } catch {
    return null;
  }
}

/** The worst level of a set of statuses (numeric max, as the producer and ROS aggregate). */
export function worstLevel(statuses: readonly HealthStatus[]): HealthLevel {
  return statuses.reduce<HealthLevel>((worst, s) => (s.level > worst ? s.level : worst), 0);
}

/** A level as the pill / value class the rest of the dashboard uses (STALE = idle: no data). */
export function levelClass(level: HealthLevel): ValueLevel {
  return LEVEL_CLASSES[level];
}

/** "cam_thermal: camera" → "camera". A name without the "<instance>: " prefix is kept whole. */
export function componentOf(status: HealthStatus, instance: string): string {
  const prefix = `${instance}: `;
  return status.name.startsWith(prefix) ? status.name.slice(prefix.length) : status.name;
}

/** The statuses a view shows: all of them, or only the named components (in snapshot order). */
export function selectStatuses(snapshot: HealthSnapshot, components?: readonly string[]): HealthStatus[] {
  if (!components || components.length === 0) return snapshot.status;
  return snapshot.status.filter((s) => components.includes(componentOf(s, snapshot.instance)));
}

const TEMPERATURE_KEY = /^temp\.(.+)_c$/;

/** `temp.<where>_c` → `<where>` ("sensor", "mainboard", "device"); null for any other value name
 *  (`temp.state` included — that one is the device's own verdict, a string). */
export function temperatureWhere(valueKey: string): string | null {
  return TEMPERATURE_KEY.exec(valueKey)?.[1] ?? null;
}

export interface HealthTemperature {
  status: HealthStatus;
  component: string;
  key: string; // the value name, e.g. temp.sensor_c
  where: string;
  celsius: number;
}

/** Every numeric `temp.<where>_c` of the given statuses, in snapshot order. */
export function temperatures(statuses: readonly HealthStatus[], instance: string): HealthTemperature[] {
  const out: HealthTemperature[] = [];
  for (const status of statuses) {
    for (const [key, value] of Object.entries(status.values)) {
      const where = temperatureWhere(key);
      if (where !== null && typeof value === "number") {
        out.push({ status, component: componentOf(status, instance), key, where, celsius: value });
      }
    }
  }
  return out;
}

/** A producer hung while its token stands shows as silence: "older than ~3 publish intervals"
 *  (HEALTH.md). The interval is the one observed; the floor covers the first snapshots, whose gap
 *  (a query reply, then the first publication) says nothing about the period, and keeps a 1 Hz
 *  producer from flickering to "silent" on a wireless link that delivers in bursts. */
export const HEALTH_STALE_FLOOR_MS = 5_000;

export function staleAfterMs(service: HealthService): number {
  const periods = service.snapshot.status.map((s) => s.values["health.publish_interval_s"])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return Math.max(service.fallbackTtlMs ?? HEALTH_STALE_FLOOR_MS, ...periods.map((p) => p * 3000));
}

/** Reporter heartbeat freshness, independent of any component's observation interval. */
export function reporterCurrent(service: HealthService, nowMs: number): boolean {
  const age = service.receivedMonoMs === undefined ? nowMs - service.receivedAtMs : performance.now() - service.receivedMonoMs;
  return service.alive && age <= staleAfterMs(service);
}

export function sampleAgeMs(service: HealthService, status: HealthStatus, nowMs: number): number {
  const age = status.values["health.sample_age_s"];
  const mono = status.receivedMonoMs ?? service.receivedMonoMs;
  return Math.max(0, mono === undefined ? nowMs - (status.receivedAtMs ?? service.receivedAtMs) : performance.now() - mono) +
    (typeof age === "number" && age >= 0 ? age * 1000 : 0);
}

export function statusCurrent(service: HealthService, status: HealthStatus, nowMs: number): boolean {
  const ttl = status.values["health.stale_after_s"];
  const availability = status.values["health.availability"];
  return service.alive && status.level !== 3 && availability !== "stale" && availability !== "paused" &&
    availability !== "unavailable" && availability !== "unsupported" &&
    sampleAgeMs(service, status, nowMs) <= (typeof ttl === "number" && ttl > 0 ? ttl * 1000 : staleAfterMs(service));
}

export function metricUnit(key: string): string | null {
  if (temperatureWhere(key) !== null) return "°C";
  return ({ "supply.voltage_v": "V", "supply.current_a": "A", "supply.power_w": "W" } as Record<string, string>)[key] ?? null;
}

export interface HealthVerdict {
  level: ValueLevel;
  text: string; // OK | WARN | ERROR | STALE | offline | silent 12s
  /** false = the values on screen are not current (token gone, or the producer went quiet). */
  current: boolean;
}

/** What to say about an instance right now: presence first, then silence, then the worst level of
 *  the statuses in view. */
export function healthVerdict(service: HealthService, statuses: readonly HealthStatus[], nowMs: number): HealthVerdict {
  const levels = statuses.map((s) => s.level === 3 ? s.values["health.last_level"] : s.level);
  const severity = levels.includes(2) ? "ERROR" : levels.includes(1) ? "WARN" : null;
  const prefix = severity ? `${severity} · ` : "";
  if (!service.alive) return { level: severity === "ERROR" ? "err" : "warn", text: `${prefix}offline`, current: false };
  const age = service.receivedMonoMs === undefined ? nowMs - service.receivedAtMs : performance.now() - service.receivedMonoMs;
  if (age > staleAfterMs(service)) return { level: severity === "ERROR" ? "err" : "idle", text: `${prefix}silent ${Math.floor(age / 1000)}s`, current: false };
  if (!statuses.length) return { level: "idle", text: "unknown", current: false };
  const stale = statuses.some((s) => !statusCurrent(service, s, nowMs) && !["paused", "unsupported"].includes(String(s.values["health.availability"])));
  if (severity) return { level: severity === "ERROR" ? "err" : "warn", text: severity + (stale ? " · STALE" : ""), current: !stale };
  return { level: stale ? "idle" : "ok", text: stale ? "STALE" : "OK", current: !stale };
}
