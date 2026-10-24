// Vehicle-state protocol v1 (docs/VEHICLE_STATE.md): the browser registers the items its mounted
// widgets show, then long-polls for changes. Pure and shared — the vehicle service and the browser
// client import the same specs, signatures, projection and JSON codec, so "which value would render"
// has one definition on both sides of the radio.
import { pluckField } from "../home/pluck";
import type { DecodedMessage } from "../schema/types";

export const VSTATE_VERSION = 1;

export const LIMITS = {
  items: 256, // per view
  fields: 16, // per item
  specBytes: 64 * 1024, // registration payload
  stateBytes: 8 * 1024, // one encoded item state
  leaves: 2048, // array/object members converted per field before giving up
  views: 64, // live views on one vehicle
} as const;

/** One projected field: a dot-path and an optional rounding quantum for numeric leaves. */
export interface FieldSpec {
  p: string;
  q?: number;
}

/** What one widget needs from one topic. No fields = rate/presence only (never decoded). */
export interface ItemSpec {
  topic: string;
  fields?: FieldSpec[];
  hz?: boolean;
  window_ms?: number;
}

export interface ViewSpec {
  v: typeof VSTATE_VERSION;
  items: ItemSpec[];
}

export interface RegisterReply {
  v: typeof VSTATE_VERSION;
  view: string;
  epoch: string;
}

export interface PollRequest {
  v: typeof VSTATE_VERSION;
  view: string;
  epoch: string;
  since: number;
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
export function stateKeys(base: string): { view: string; poll: string } {
  return { view: `${base}/view`, poll: `${base}/poll` };
}

// ---- validation ------------------------------------------------------------------------------

const PATH_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
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
  return canonicalItem({ topic, fields, hz: raw.hz as boolean | undefined, window_ms: w as number | undefined });
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
  return { v: VSTATE_VERSION, view: raw.view, epoch: raw.epoch, since: raw.since as number };
}

// ---- identity --------------------------------------------------------------------------------

/** Fixed key order and no undefined members, so equal specs serialize identically. */
export function canonicalItem(spec: ItemSpec): ItemSpec {
  const out: ItemSpec = { topic: spec.topic };
  if (spec.fields && spec.fields.length > 0) out.fields = spec.fields.map((f) => (f.q === undefined ? { p: f.p } : { p: f.p, q: f.q }));
  if (spec.hz) out.hz = true;
  if (spec.window_ms !== undefined) out.window_ms = spec.window_ms;
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
