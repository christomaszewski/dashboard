// A health service on the wire (vehicle state "health" items). The vehicle's own HealthDiscovery
// assembles services; timestamps mean nothing on another machine, so the wire carries ages instead:
// how long ago, at reply time, the vehicle received the service and each status. The browser turns
// them back into its own clock, and every staleness rule keeps working unchanged.
import type { HealthLevel, HealthService, HealthSnapshot, HealthStatus, HealthValue } from "../health/types";

type WireStatus = Omit<HealthStatus, "receivedAtMs" | "receivedMonoMs">;
type WireService = Omit<HealthService, "receivedAtMs" | "receivedMonoMs" | "snapshot"> & {
  snapshot: Omit<HealthSnapshot, "status"> & { status: WireStatus[] };
};

export interface HealthWire {
  /** Bumped by the vehicle each time it re-assembles the service (a new sample, a liveness change). */
  c: number;
  s: WireService;
  /** At reply time: ms since the vehicle received the service, and each status (null = unknown). */
  age?: number;
  sa?: (number | null)[];
  /** Structural baseline for negotiated sparse updates; absent on legacy servers. */
  b?: number;
}

export interface HealthStatusPatch {
  level?: HealthLevel;
  message?: string;
  values?: Record<string, HealthValue>;
}

/** Complete observation metadata plus fields changed since the caller's cursor. */
export interface HealthUpdate {
  b: number;
  c: number;
  age?: number;
  sa?: (number | null)[];
  stamp: number;
  level: HealthLevel;
  /** Complete metadata: omission removes an earlier observed period. */
  periodMs?: number;
  status?: [index: number, patch: HealthStatusPatch][];
}

/** The part that changes only with the service itself — what decides whether to send it again. */
export function healthToWire(service: HealthService, counter: number, baseline?: number): HealthWire {
  const { receivedAtMs: _a, receivedMonoMs: _m, snapshot, ...rest } = service;
  void _a; void _m;
  const status = snapshot.status.map(({ receivedAtMs: _sa, receivedMonoMs: _sm, ...s }) => { void _sa; void _sm; return s; });
  return { c: counter, s: { ...rest, snapshot: { ...snapshot, status } }, ...(baseline === undefined ? {} : { b: baseline }) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Fields outside the sparse-update vocabulary require a new full baseline. Value-key changes
 *  also do: this makes deletion unambiguous and keeps null a real diagnostic value. */
export function healthStructureSignature(service: HealthService): string {
  const { periodMs: _p, snapshot, ...rest } = healthToWire(service, 0).s;
  const { stamp_unix_ns: _t, level: _l, status, ...snapshotRest } = snapshot;
  void _p; void _t; void _l;
  const structure = status.map(({ level: _sl, message: _m, values, ...s }) => {
    void _sl; void _m;
    return { ...s, values: Object.keys(values).sort() };
  });
  return JSON.stringify(canonical({ ...rest, snapshot: { ...snapshotRest, status: structure } }));
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const level = (value: unknown): value is HealthLevel => value === 0 || value === 1 || value === 2 || value === 3;
const age = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const scalar = (value: unknown): value is HealthValue =>
  value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

/** Merge without changing the cached baseline or any previous UI snapshot. A bad or missing
 *  baseline needs a fresh full item; guessing would turn missed updates into plausible health. */
export function applyHealthUpdate(base: HealthWire, update: HealthUpdate): HealthWire | null {
  if (!record(update) || !counter(update.b) || update.b < 1 || update.b !== base.b ||
      !counter(update.c) || update.c < base.c || typeof update.stamp !== "number" || !Number.isFinite(update.stamp) ||
      !level(update.level) || (update.age !== undefined && !age(update.age)) ||
      (update.periodMs !== undefined && !age(update.periodMs))) return null;
  const original = base.s.snapshot.status;
  if (update.sa !== undefined && (!Array.isArray(update.sa) || update.sa.length !== original.length ||
      !update.sa.every((a) => a === null || age(a)))) return null;
  if (update.status !== undefined && !Array.isArray(update.status)) return null;
  const status = [...original];
  const seen = new Set<number>();
  for (const entry of update.status ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [i, patch] = entry;
    if (!counter(i) || i >= status.length || seen.has(i) || !record(patch)) return null;
    seen.add(i);
    if (Object.keys(patch).some((key) => key !== "level" && key !== "message" && key !== "values") ||
        (Object.hasOwn(patch, "level") && !level(patch.level)) ||
        (Object.hasOwn(patch, "message") && typeof patch.message !== "string")) return null;
    if (Object.hasOwn(patch, "values") && (!record(patch.values) ||
        Object.entries(patch.values).some(([key, value]) => !Object.hasOwn(original[i].values, key) || !scalar(value)))) return null;
    const fields = patch as HealthStatusPatch;
    status[i] = { ...original[i], ...fields, values: { ...original[i].values, ...fields.values } };
  }
  const { periodMs: _p, ...service } = base.s;
  void _p;
  return {
    b: update.b, c: update.c,
    ...(update.age === undefined ? {} : { age: update.age }),
    ...(update.sa === undefined ? {} : { sa: [...update.sa] }),
    s: { ...service, ...(update.periodMs === undefined ? {} : { periodMs: update.periodMs }),
      snapshot: { ...service.snapshot, stamp_unix_ns: update.stamp, level: update.level, status } },
  };
}

/** Ages at reply time, from the vehicle's clocks. */
export function healthAges(service: HealthService, nowMs: number, nowMono: number): Pick<HealthWire, "age" | "sa"> {
  const ageOf = (mono?: number, at?: number) =>
    mono !== undefined ? Math.max(0, Math.round(nowMono - mono)) : at !== undefined ? Math.max(0, Math.round(nowMs - at)) : null;
  return {
    age: ageOf(service.receivedMonoMs, service.receivedAtMs) ?? 0,
    sa: service.snapshot.status.map((s) => ageOf(s.receivedMonoMs, s.receivedAtMs)),
  };
}

/** Back to a HealthService on this machine's clocks. */
export function healthFromWire(wire: HealthWire, nowMs = Date.now(), nowMono = performance.now()): HealthService {
  const age = wire.age ?? 0;
  const status: HealthStatus[] = wire.s.snapshot.status.map((s, i) => {
    const a = wire.sa?.[i];
    return a === null || a === undefined ? { ...s } : { ...s, receivedAtMs: nowMs - a, receivedMonoMs: nowMono - a };
  });
  return { ...wire.s, snapshot: { ...wire.s.snapshot, status }, receivedAtMs: nowMs - age, receivedMonoMs: nowMono - age };
}
