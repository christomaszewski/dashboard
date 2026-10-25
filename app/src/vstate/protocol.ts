// Vehicle-state protocol v1 (docs/VEHICLE_STATE.md): the browser registers the items its mounted
// widgets show, then long-polls for changes. Pure and shared — the vehicle service and the browser
// client import the same specs, signatures, projection and JSON codec, so "which value would render"
// has one definition on both sides of the radio.
import { pluckField } from "../home/pluck";
import type { DecodedMessage } from "../schema/types";
import type { HealthWire } from "./healthWire";

export const VSTATE_VERSION = 1;

export const LIMITS = {
  items: 256, // per view
  fields: 16, // per item
  specBytes: 64 * 1024, // registration payload
  stateBytes: 8 * 1024, // one encoded item state
  leaves: 2048, // array/object members converted per field before giving up
  views: 64, // live views on one vehicle
  trail: 5000, // points kept per trail item
  buckets: 600, // history buckets per series item
} as const;

/** One projected field: a dot-path and an optional rounding quantum for numeric leaves. */
export interface FieldSpec {
  p: string;
  q?: number;
}

/** History of a topic item's first numeric field, kept on the vehicle in min/max/last buckets. */
export interface SeriesSpec {
  window_ms: number;
  bucket_ms: number;
}

/**
 * What one widget needs from the vehicle. Exactly one of:
 *   topic   a ROS topic: projected fields (none = rate/presence only, never decoded), optionally a
 *           position trail or a value history kept on the vehicle
 *   node    is this fully-qualified node in the vehicle's ROS graph
 *   health  "*" = the keys of the vehicle's health services; else one service, as its own
 *           discovery assembled it (docs/VEHICLE_STATE.md, "Health")
 */
export interface ItemSpec {
  topic?: string;
  fields?: FieldSpec[];
  hz?: boolean;
  window_ms?: number;
  /** Topic items with latitude, longitude as their first two fields: keep this many points. */
  trail?: number;
  series?: SeriesSpec;
  node?: string;
  health?: string;
}

export interface ViewSpec {
  v: typeof VSTATE_VERSION;
  items: ItemSpec[];
}

export interface RegisterReply {
  v: typeof VSTATE_VERSION;
  view: string;
  epoch: string;
  /** This vehicle honours `poll.fresh`: a caller changing its view may keep its `since`. */
  fresh?: 1;
}

export interface PollRequest {
  v: typeof VSTATE_VERSION;
  view: string;
  epoch: string;
  since: number;
  /** View indices of items new to this caller (added since its last view): answered whole, at once. */
  fresh?: number[];
}

/** Field values after projection: JSON-safe, with tags for bigint and non-finite floats. */
export type PlainValue = null | boolean | number | string | PlainValue[] | { [k: string]: PlainValue };

export interface ItemState {
  /** Type name; absent = the topic is not advertised on the vehicle. */
  t?: string;
  d?: number; // ROS domain
  f?: (PlainValue | null)[]; // one per requested field; null = path absent in the message
  hz?: number;
  e?: string; // error
  w?: string; // decoder warning
  l?: 1; // latched (transient-local) value
  s?: 1; // stale
  // Attached per reply, for what the caller has not seen yet (its `since`):
  /** Trail points from absolute index `i`: a continuation of the caller's trail, or all of it. */
  tr?: { i: number; p: [number, number][] };
  /** History buckets: [absolute index, age in ms of the bucket start, min, max, last]. */
  hs?: [number, number, number, number, number][];
  /** Node items: the node is (1) or is not (0) in the vehicle's graph. */
  a?: 0 | 1;
  /** Health "*": the service keys. */
  hk?: string[];
  /** Health service: as the vehicle's discovery holds it, with ages instead of timestamps. */
  hd?: HealthWire;
}

export type PollReply =
  | { v: typeof VSTATE_VERSION; epoch: string; seq: number; items: [number, ItemState][] }
  | { v: typeof VSTATE_VERSION; error: "unknown-view" };

/** A plain key for one vehicle's state service: fleet/<vehicle>/dash/<name>/state (no wildcards). */
export const STATE_KEY_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** A topic name the vehicle accepts (absolute; no wildcards or whitespace). */
export function isRosTopicName(name: string): boolean {
  return name.length <= 256 && TOPIC_RE.test(name);
}

/** Keys under one vehicle's state service. */
export function stateKeys(base: string): { view: string; poll: string; frame: string } {
  return { view: `${base}/view`, poll: `${base}/poll`, frame: `${base}/frame` };
}

// ---- validation ------------------------------------------------------------------------------

const PATH_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const NODE_RE = /^\/[A-Za-z0-9_/]*$/;
const HEALTH_RE = /^fleet\/[A-Za-z0-9_.-]+\/svc\/[A-Za-z0-9_.-]+\/health$/;
const TOPIC_RE = /^\/[A-Za-z0-9_~{}/]*$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateItem(raw: unknown, i: number): ItemSpec {
  if (!isRecord(raw)) fail(`items[${i}] must be a mapping`);
  const kinds = ["topic", "node", "health"].filter((k) => raw[k] !== undefined);
  if (kinds.length !== 1) fail(`items[${i}] needs exactly one of topic, node, health`);
  if (raw.node !== undefined) {
    if (typeof raw.node !== "string" || raw.node.length > 256 || !NODE_RE.test(raw.node)) fail(`items[${i}].node must be a ROS node name`);
    return { node: raw.node };
  }
  if (raw.health !== undefined) {
    if (typeof raw.health !== "string" || raw.health.length > 256 || (raw.health !== "*" && !HEALTH_RE.test(raw.health))) {
      fail(`items[${i}].health must be "*" or a health key`);
    }
    return { health: raw.health };
  }
  const topic = raw.topic;
  if (typeof topic !== "string" || topic.length > 256 || !TOPIC_RE.test(topic)) fail(`items[${i}].topic must be a ROS topic name`);
  let fields: FieldSpec[] | undefined;
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || raw.fields.length > LIMITS.fields) fail(`items[${i}].fields must be a list of at most ${LIMITS.fields}`);
    fields = raw.fields.map((f, j) => {
      if (!isRecord(f) || typeof f.p !== "string" || f.p.length > 256 || !PATH_RE.test(f.p)) fail(`items[${i}].fields[${j}].p must be a field path`);
      if (f.q !== undefined && !(typeof f.q === "number" && Number.isFinite(f.q) && f.q > 0)) fail(`items[${i}].fields[${j}].q must be a positive number`);
      return f.q === undefined ? { p: f.p } : { p: f.p, q: f.q };
    });
  }
  if (raw.hz !== undefined && typeof raw.hz !== "boolean") fail(`items[${i}].hz must be true or false`);
  const w = raw.window_ms;
  if (w !== undefined && !(typeof w === "number" && Number.isFinite(w) && w >= 500 && w <= 60_000)) fail(`items[${i}].window_ms must be 500–60000`);
  const trail = raw.trail;
  if (trail !== undefined && !(Number.isInteger(trail) && (trail as number) >= 2 && (trail as number) <= LIMITS.trail && (fields?.length ?? 0) >= 2)) {
    fail(`items[${i}].trail must be 2–${LIMITS.trail}, with latitude and longitude as the first two fields`);
  }
  let series: SeriesSpec | undefined;
  if (raw.series !== undefined) {
    const sr = raw.series;
    if (!isRecord(sr) || !Number.isInteger(sr.window_ms) || !Number.isInteger(sr.bucket_ms) || (sr.window_ms as number) < 1000 ||
      (sr.window_ms as number) > 3_600_000 || (sr.bucket_ms as number) < 100 || (sr.window_ms as number) / (sr.bucket_ms as number) > LIMITS.buckets ||
      (fields?.length ?? 0) < 1) {
      fail(`items[${i}].series must be {window_ms: 1000–3600000, bucket_ms ≥ 100, at most ${LIMITS.buckets} buckets} on an item with fields`);
    }
    series = { window_ms: sr.window_ms as number, bucket_ms: sr.bucket_ms as number };
  }
  return canonicalItem({ topic, fields, hz: raw.hz as boolean | undefined, window_ms: w as number | undefined, trail: trail as number | undefined, series });
}

export function validateViewSpec(raw: unknown): ViewSpec {
  if (!isRecord(raw) || raw.v !== VSTATE_VERSION) fail(`view spec must have v: ${VSTATE_VERSION}`);
  if (!Array.isArray(raw.items) || raw.items.length > LIMITS.items) fail(`view spec items must be a list of at most ${LIMITS.items}`);
  return { v: VSTATE_VERSION, items: raw.items.map(validateItem) };
}

export function validatePollRequest(raw: unknown): PollRequest {
  if (!isRecord(raw) || raw.v !== VSTATE_VERSION) fail(`poll must have v: ${VSTATE_VERSION}`);
  if (typeof raw.view !== "string" || !ID_RE.test(raw.view)) fail("poll.view must be a view id");
  if (typeof raw.epoch !== "string" || raw.epoch.length > 64) fail("poll.epoch must be a string");
  if (!Number.isSafeInteger(raw.since) || (raw.since as number) < 0) fail("poll.since must be a non-negative integer");
  const req: PollRequest = { v: VSTATE_VERSION, view: raw.view, epoch: raw.epoch, since: raw.since as number };
  if (raw.fresh !== undefined) {
    const fresh = raw.fresh;
    if (!Array.isArray(fresh) || fresh.length > LIMITS.items || !fresh.every((i) => Number.isSafeInteger(i) && i >= 0)) {
      fail(`poll.fresh must be a list of at most ${LIMITS.items} item indices`);
    }
    req.fresh = fresh as number[];
  }
  return req;
}

// ---- identity --------------------------------------------------------------------------------

/** Fixed key order and no undefined members, so equal specs serialize identically. */
export function canonicalItem(spec: ItemSpec): ItemSpec {
  if (spec.node !== undefined) return { node: spec.node };
  if (spec.health !== undefined) return { health: spec.health };
  const out: ItemSpec = { topic: spec.topic };
  if (spec.fields && spec.fields.length > 0) out.fields = spec.fields.map((f) => (f.q === undefined ? { p: f.p } : { p: f.p, q: f.q }));
  if (spec.hz) out.hz = true;
  if (spec.window_ms !== undefined) out.window_ms = spec.window_ms;
  if (spec.trail !== undefined) out.trail = spec.trail;
  if (spec.series !== undefined) out.series = { window_ms: spec.series.window_ms, bucket_ms: spec.series.bucket_ms };
  return out;
}

export function itemSignature(spec: ItemSpec): string {
  return JSON.stringify(canonicalItem(spec));
}

/** cyrb53: a fast 53-bit string hash. Ids only need to be stable, not secret. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** A view's id: the hash of its canonical item list (order matters — replies index into it). */
export function viewId(items: ItemSpec[]): string {
  return `v${hash53(JSON.stringify(items.map(canonicalItem)))}`;
}

// ---- projection ------------------------------------------------------------------------------

export class ValueTooLarge extends Error {}

/** Round to the quantum, then strip binary noise (3 × 0.1 → 0.3) so equal displays encode equally. */
export function quantize(v: number, q: number): number {
  const r = Number((Math.round(v / q) * q).toPrecision(15));
  return r === 0 ? 0 : r; // -0 → 0
}

function isTypedArray(v: unknown): v is ArrayLike<number | bigint> {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** A decoded value → PlainValue: quantize numbers, tag bigint/non-finite, flatten typed arrays. */
export function toPlain(v: unknown, q?: number, budget = { n: LIMITS.leaves }): PlainValue {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { $num: String(v) };
    return q === undefined ? v : quantize(v, q);
  }
  if (typeof v === "bigint") return { $big: v.toString() };
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) || isTypedArray(v)) {
    const list = v as ArrayLike<unknown>;
    if ((budget.n -= list.length) < 0) throw new ValueTooLarge("field value too large");
    const out: PlainValue[] = new Array(list.length);
    for (let i = 0; i < list.length; i++) out[i] = toPlain(list[i], q, budget);
    return out;
  }
  if (typeof v === "object") {
    const out: { [k: string]: PlainValue } = {};
    const keys = Object.keys(v as object);
    if ((budget.n -= keys.length) < 0) throw new ValueTooLarge("field value too large");
    for (const k of keys) out[k] = toPlain((v as Record<string, unknown>)[k], q, budget);
    return out;
  }
  return null;
}

/** The requested fields of a decoded message; null where a path is absent. */
export function project(message: unknown, fields: readonly FieldSpec[]): (PlainValue | null)[] {
  return fields.map((f) => {
    const v = pluckField(message, f.p);
    return v === undefined ? null : toPlain(v, f.q);
  });
}

/** Revive tagged values: {$big} → bigint, {$num} → NaN/±Infinity. */
export function revive(v: PlainValue): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.$big === "string") return BigInt(v.$big);
    if (keys.length === 1 && typeof v.$num === "string") return Number(v.$num);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = revive(v[k]);
    return out;
  }
  return v;
}

/** Rebuild a message holding only the projected paths, for pluckField/templates on the browser. */
export function sparseMessage(fields: readonly FieldSpec[], values: readonly (PlainValue | null)[]): DecodedMessage {
  const msg: DecodedMessage = {};
  fields.forEach((f, i) => {
    const v = values[i];
    if (v === null || v === undefined) return;
    const segs = f.p.split(".");
    let cur: Record<string, unknown> = msg;
    for (const seg of segs.slice(0, -1)) {
      const next = cur[seg];
      if (next === null || typeof next !== "object") cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    const value = revive(v);
    const existing = cur[leaf];
    // A shorter path already placed an object here (orientation, then orientation.x): merge.
    cur[leaf] = existing !== null && typeof existing === "object" && value !== null && typeof value === "object"
      ? { ...(existing as object), ...(value as object) }
      : value;
  });
  return msg;
}

// ---- wire ------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeMessage(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.length === 0) throw new Error("empty payload");
  return JSON.parse(decoder.decode(bytes));
}
