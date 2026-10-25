// The vehicle side of vehicle state (docs/VEHICLE_STATE.md). Runs next to the ROS graph, where
// full-rate topics are cheap: subscribes through the same TopicStore the browser uses (one
// subscription and one 5 Hz decode per topic, rate monitoring, transient-local seeding), projects
// and quantizes the fields each registered item asks for, and numbers every change. Polls return
// the items that changed after the caller's `since`, or wait for one (bounded by holdMs).
//
// No per-client state: an item remembers the update number of its last change; a view is just a
// list of items. Views nobody polls expire; items and raw subscriptions go with their last view.
// What only grows — a position trail, a value history — is numbered point by point, so a reply
// carries exactly the points the caller has not seen (all of them after a reconnect or reload).
import { EMPTY_GRAPH, ROS2_LIVELINESS_GLOB, buildGraph, type RosGraph, type TopicEntry } from "../ros/graph";
import type { TopicAcquireOptions, TopicHandle, TopicSnapshot } from "../ros/topicStore";
import type { IncomingQuery, Subscription, Transport } from "../transport/types";
import type { HealthService } from "../health/types";
import { healthAges, healthToWire } from "./healthWire";
import {
  LIMITS,
  VSTATE_VERSION,
  ValueTooLarge,
  decodeMessage,
  encodeMessage,
  itemSignature,
  project,
  validatePollRequest,
  validateViewSpec,
  viewId,
  type FieldSpec,
  type ItemSpec,
  type ItemState,
  type PlainValue,
  type PollReply,
  type RegisterReply,
} from "./protocol";

/** The slice of TopicStore the server needs (a fake in tests). */
export interface TopicSource {
  acquire(info: TopicEntry, opts?: TopicAcquireOptions): TopicHandle;
  subscribe(key: string, cb: () => void): () => void;
  getSnapshot(key: string): TopicSnapshot | null;
}

/** The vehicle's health services (healthHub.ts): started while some item watches them. */
export interface HealthSource {
  retain(): void;
  release(): void;
  list(): readonly HealthService[];
  subscribe(cb: () => void): () => void;
}

export interface StateServerOptions {
  store: TopicSource;
  health?: HealthSource;
  /** Monotonic ms — the same clock the store stamps `lastAt` with. */
  now?: () => number;
  /** Wall-clock ms, for health ages (the discovery stamps services with both). */
  wallNow?: () => number;
  epoch?: string;
  /** How long a poll with nothing new waits before an empty heartbeat reply. */
  holdMs?: number;
  /** Drop a view nobody has polled for this long. */
  viewTtlMs?: number;
  /** A topic is stale after this long without a sample (or 3 × its last interval if longer). */
  staleMs?: number;
  /** Batch changes from topics flushing at slightly different times into one reply. */
  coalesceMs?: number;
}

interface TrailPoint { seq: number; lat: number; lon: number }
interface Bucket { seq: number; t0: number; min: number; max: number; last: number }

interface ItemRecord {
  sig: string;
  spec: ItemSpec;
  kind: "topic" | "node" | "health";
  fields: FieldSpec[];
  refs: number;
  entry?: TopicEntry;
  handle?: TopicHandle;
  unlisten?: () => void;
  state: ItemState;
  json: string;
  changedSeq: number;
  lastAt?: number;
  interval?: number;
  /** Trail items: points, the absolute index of the first one kept. */
  trail?: { first: number; pts: TrailPoint[] };
  /** Series items: buckets, the absolute index of the first one kept. */
  series?: { first: number; buckets: Bucket[] };
  /** Health items: the service object last seen, and its counter. */
  health?: { obj?: HealthService; counter: number };
}

interface View {
  id: string;
  items: ItemRecord[];
  lastPolled: number;
}

interface Waiter {
  view: View;
  since: number;
  resolve: (reply: PollReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StateServerStats {
  views: number;
  items: number;
  topics: number;
  registers: number;
  polls: number;
  seq: number;
}

const randomEpoch = () => Math.floor(Math.random() * 2 ** 48).toString(36);
const num = (v: PlainValue | null | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class VehicleStateServer {
  readonly epoch: string;
  private readonly store: TopicSource;
  private readonly health?: HealthSource;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly holdMs: number;
  private readonly viewTtlMs: number;
  private readonly staleMs: number;
  private readonly coalesceMs: number;
  private graph: RosGraph = EMPTY_GRAPH;
  private seq = 0;
  private readonly items = new Map<string, ItemRecord>();
  private readonly views = new Map<string, View>();
  private readonly waiters = new Set<Waiter>();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private counts = { registers: 0, polls: 0 };
  private healthItems = 0;
  private unlistenHealth: (() => void) | null = null;

  constructor(opts: StateServerOptions) {
    this.store = opts.store;
    this.health = opts.health;
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.epoch = opts.epoch ?? randomEpoch();
    this.holdMs = opts.holdMs ?? 2000;
    this.viewTtlMs = opts.viewTtlMs ?? 60_000;
    this.staleMs = opts.staleMs ?? 5000;
    this.coalesceMs = opts.coalesceMs ?? 10;
  }

  register(raw: unknown): RegisterReply {
    const spec = validateViewSpec(raw);
    const id = viewId(spec.items);
    this.counts.registers += 1;
    let view = this.views.get(id);
    if (!view) {
      if (this.views.size >= LIMITS.views) {
        // A new operator beats the longest-idle view; that one re-registers if it comes back.
        const oldest = [...this.views.values()].sort((a, b) => a.lastPolled - b.lastPolled)[0];
        this.dropView(oldest);
      }
      view = { id, items: spec.items.map((s) => this.retain(s)), lastPolled: this.now() };
      this.views.set(id, view);
    } else view.lastPolled = this.now();
    return { v: VSTATE_VERSION, view: id, epoch: this.epoch };
  }

  poll(raw: unknown): Promise<PollReply> {
    const req = validatePollRequest(raw);
    this.counts.polls += 1;
    const view = this.views.get(req.view);
    if (!view) return Promise.resolve({ v: VSTATE_VERSION, error: "unknown-view" });
    view.lastPolled = this.now();
    const since = req.epoch === this.epoch && req.since <= this.seq ? req.since : 0;
    const items = this.delta(view, since);
    if (items.length > 0 || since === 0) return Promise.resolve(this.reply(items));
    return new Promise((resolve) => {
      const waiter: Waiter = { view, since, resolve, timer: setTimeout(() => this.finish(waiter, []), this.holdMs) };
      this.waiters.add(waiter);
    });
  }

  /** Re-bind every item to the topic now advertised under its name; nodes come and go with it. */
  setGraph(graph: RosGraph): void {
    this.graph = graph;
    for (const rec of this.items.values()) {
      if (rec.kind === "topic") this.bind(rec);
      if (rec.kind !== "health") this.recompute(rec);
    }
  }

  /** Periodic housekeeping: staleness transitions (time passes without samples) and view expiry. */
  tick(): void {
    for (const rec of this.items.values()) {
      if (rec.entry && rec.lastAt !== undefined && this.isStale(rec, rec.entry) !== (rec.state.s === 1)) this.recompute(rec);
    }
    const now = this.now();
    for (const view of [...this.views.values()]) if (now - view.lastPolled > this.viewTtlMs) this.dropView(view);
  }

  stats(): StateServerStats {
    const topics = new Set([...this.items.values()].flatMap((r) => (r.entry ? [r.entry.dataKeyexpr] : [])));
    return { views: this.views.size, items: this.items.size, topics: topics.size, ...this.counts, seq: this.seq };
  }

  close(): void {
    for (const w of [...this.waiters]) this.finish(w, []);
    for (const view of [...this.views.values()]) this.dropView(view);
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  // ---- items ---------------------------------------------------------------------------------

  private retain(spec: ItemSpec): ItemRecord {
    const sig = itemSignature(spec);
    let rec = this.items.get(sig);
    if (!rec) {
      const kind = spec.node !== undefined ? "node" : spec.health !== undefined ? "health" : "topic";
      rec = { sig, spec, kind, fields: spec.fields ?? [], refs: 0, state: {}, json: "", changedSeq: 0 };
      if (spec.trail !== undefined) rec.trail = { first: 0, pts: [] };
      if (spec.series !== undefined) rec.series = { first: 0, buckets: [] };
      if (kind === "health") {
        rec.health = { counter: 0 };
        this.retainHealth();
      }
      this.items.set(sig, rec);
      if (kind === "topic") this.bind(rec);
      this.recompute(rec);
    }
    rec.refs += 1;
    return rec;
  }

  private release(rec: ItemRecord): void {
    rec.refs -= 1;
    if (rec.refs > 0) return;
    this.unbind(rec);
    this.items.delete(rec.sig);
    if (rec.kind === "health") this.releaseHealth();
  }

  private retainHealth(): void {
    if (!this.health || this.healthItems++ > 0) return;
    this.health.retain();
    this.unlistenHealth = this.health.subscribe(() => {
      for (const rec of this.items.values()) if (rec.kind === "health") this.recompute(rec);
    });
  }

  private releaseHealth(): void {
    if (!this.health || --this.healthItems > 0) return;
    this.unlistenHealth?.();
    this.unlistenHealth = null;
    this.health.release();
  }

  private bind(rec: ItemRecord): void {
    // Same lookup the browser's useTopic does: the first topic advertised under that name.
    const entry = this.graph.topics.find((t) => t.name === rec.spec.topic);
    if (entry?.dataKeyexpr === rec.entry?.dataKeyexpr) {
      if (entry) rec.entry = entry;
      return;
    }
    this.unbind(rec);
    if (!entry) return;
    rec.entry = entry;
    rec.handle = this.store.acquire(entry, { windowMs: rec.spec.window_ms, decode: rec.fields.length > 0 });
    rec.unlisten = this.store.subscribe(entry.dataKeyexpr, () => this.recompute(rec));
  }

  private unbind(rec: ItemRecord): void {
    rec.unlisten?.();
    rec.handle?.release();
    rec.entry = rec.handle = rec.unlisten = undefined;
    rec.lastAt = rec.interval = undefined;
  }

  private recompute(rec: ItemRecord): void {
    let state = this.computeState(rec);
    let json = JSON.stringify(state);
    if (json.length > LIMITS.stateBytes && rec.kind !== "health") {
      state = { t: state.t, d: state.d, e: `vehicle state: value too large (${json.length} B > ${LIMITS.stateBytes} B) — choose a smaller field` };
      json = JSON.stringify(state);
    }
    if (json === rec.json) return;
    const previous = rec.state;
    rec.json = json;
    rec.state = state;
    rec.changedSeq = ++this.seq;
    if (rec.trail || rec.series) this.record(rec, previous, state);
    this.scheduleWake();
  }

  /** A changed value extends the item's trail and history, numbered with the change. */
  private record(rec: ItemRecord, previous: ItemState, state: ItemState): void {
    if (!state.f) return;
    const now = this.now();
    if (rec.trail) {
      const lat = num(state.f[0]), lon = num(state.f[1]);
      const last = rec.trail.pts[rec.trail.pts.length - 1];
      if (lat !== undefined && lon !== undefined && (!last || last.lat !== lat || last.lon !== lon)) {
        rec.trail.pts.push({ seq: rec.changedSeq, lat, lon });
        const over = rec.trail.pts.length - (rec.spec.trail ?? 0);
        if (over > 0) {
          rec.trail.pts.splice(0, over);
          rec.trail.first += over;
        }
      }
    }
    if (rec.series && rec.spec.series) {
      const v = num(state.f[0]);
      if (v === undefined || (previous.f && num(previous.f[0]) === v && state.s === previous.s)) return;
      const { window_ms, bucket_ms } = rec.spec.series;
      const buckets = rec.series.buckets;
      const cur = buckets[buckets.length - 1];
      if (cur && now - cur.t0 < bucket_ms) {
        cur.min = Math.min(cur.min, v);
        cur.max = Math.max(cur.max, v);
        cur.last = v;
        cur.seq = rec.changedSeq;
      } else buckets.push({ seq: rec.changedSeq, t0: now, min: v, max: v, last: v });
      // Keep the window, and always the newest bucket: a value that has not changed in a while
      // is still the value (the browser draws it on to now).
      let drop = 0;
      while (drop < buckets.length - 1 && now - buckets[drop].t0 > window_ms) drop += 1;
      if (drop > 0) {
        buckets.splice(0, drop);
        rec.series.first += drop;
      }
    }
  }

  private computeState(rec: ItemRecord): ItemState {
    if (rec.kind === "node") return { a: this.graph.nodes.some((n) => n.nodeFq === rec.spec.node) ? 1 : 0 };
    if (rec.kind === "health") return this.healthState(rec);
    const entry = rec.entry;
    if (!entry) return {};
    const state: ItemState = { t: entry.typeName, d: entry.domainId };
    const snap = this.store.getSnapshot(entry.dataKeyexpr);
    if (!snap) return state;
    if (rec.fields.length > 0 && snap.message !== undefined) {
      try {
        state.f = project(snap.message, rec.fields);
      } catch (e) {
        if (!(e instanceof ValueTooLarge)) throw e;
        state.e = `vehicle state: field value too large (over ${LIMITS.leaves} elements) — choose a smaller field`;
      }
    }
    if (rec.spec.hz && snap.hz !== undefined) state.hz = snap.hz;
    if (snap.error) state.e = snap.error;
    if (snap.warning) state.w = snap.warning;
    if (snap.latched) state.l = 1;
    if (snap.lastAt !== undefined && snap.lastAt !== rec.lastAt) {
      if (rec.lastAt !== undefined) rec.interval = snap.lastAt - rec.lastAt;
      rec.lastAt = snap.lastAt;
    }
    if (this.isStale(rec, entry)) state.s = 1;
    return state;
  }

  private healthState(rec: ItemRecord): ItemState {
    const services = this.health?.list() ?? [];
    if (rec.spec.health === "*") return { hk: services.map((s) => s.key).sort() };
    const service = services.find((s) => s.key === rec.spec.health);
    const h = rec.health!;
    if (!service) {
      h.obj = undefined;
      return {};
    }
    if (service !== h.obj) {
      h.obj = service;
      h.counter += 1;
    }
    return { hd: healthToWire(service, h.counter) };
  }

  /** Latched topics publish once by design; everything else is stale after an unusual silence. */
  private isStale(rec: ItemRecord, entry: TopicEntry): boolean {
    if (rec.lastAt === undefined || entry.transientLocal) return false;
    return this.now() - rec.lastAt > Math.max(this.staleMs, 3 * (rec.interval ?? 0));
  }

  // ---- views and polls -----------------------------------------------------------------------

  private dropView(view: View): void {
    this.views.delete(view.id);
    for (const w of [...this.waiters]) {
      if (w.view !== view) continue;
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve({ v: VSTATE_VERSION, error: "unknown-view" });
    }
    for (const rec of view.items) this.release(rec);
  }

  private delta(view: View, since: number): [number, ItemState][] {
    const out: [number, ItemState][] = [];
    view.items.forEach((rec, i) => {
      if (rec.changedSeq > since) out.push([i, this.withExtras(rec, since)]);
    });
    return out;
  }

  /** The item's state plus what only this caller lacks: new trail points, changed buckets, ages. */
  private withExtras(rec: ItemRecord, since: number): ItemState {
    if (!rec.trail && !rec.series && !rec.state.hd) return rec.state;
    const state: ItemState = { ...rec.state };
    if (rec.trail && rec.trail.pts.length > 0) {
      let k = 0;
      if (since > 0) while (k < rec.trail.pts.length && rec.trail.pts[k].seq <= since) k += 1;
      if (k < rec.trail.pts.length) state.tr = { i: rec.trail.first + k, p: rec.trail.pts.slice(k).map((p) => [p.lat, p.lon]) };
    }
    if (rec.series && rec.series.buckets.length > 0) {
      const now = this.now();
      const hs: [number, number, number, number, number][] = [];
      rec.series.buckets.forEach((b, j) => {
        if (since === 0 || b.seq > since) hs.push([rec.series!.first + j, Math.round(now - b.t0), b.min, b.max, b.last]);
      });
      if (hs.length > 0) state.hs = hs;
    }
    if (state.hd && rec.health?.obj) state.hd = { ...state.hd, ...healthAges(rec.health.obj, this.wallNow(), this.now()) };
    return state;
  }

  private reply(items: [number, ItemState][]): PollReply {
    return { v: VSTATE_VERSION, epoch: this.epoch, seq: this.seq, items };
  }

  private finish(waiter: Waiter, items: [number, ItemState][]): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.resolve(this.reply(items));
  }

  private scheduleWake(): void {
    if (this.wakeTimer !== null || this.waiters.size === 0) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      for (const w of [...this.waiters]) {
        const items = this.delta(w.view, w.since);
        if (items.length > 0) this.finish(w, items);
      }
    }, this.coalesceMs);
  }
}

// ---- wiring: Zenoh queries and the live graph ------------------------------------------------

/** Answer one query: `view` registers, `poll` waits for changes. Bad requests get a reply error. */
export async function serveQuery(server: VehicleStateServer, op: "view" | "poll", query: IncomingQuery): Promise<number> {
  try {
    if (query.payload && query.payload.length > LIMITS.specBytes) throw new Error(`request larger than ${LIMITS.specBytes} bytes`);
    const request = decodeMessage(query.payload);
    const result = op === "view" ? server.register(request) : await server.poll(request);
    const bytes = encodeMessage(result);
    await query.reply(bytes);
    return bytes.length;
  } catch (e) {
    // The reply itself can fail (the socket to the bridge is closing): never an unhandled rejection.
    await query.replyErr(e instanceof Error ? e.message : String(e)).catch(() => undefined);
    return 0;
  }
}

/** The vehicle's ROS graph from rmw_zenoh liveliness, rebuilt at most every `debounceMs`. */
export class LiveGraph {
  private readonly tokens = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sub: Subscription | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly onGraph: (graph: RosGraph) => void,
    private readonly debounceMs = 100,
  ) {}

  async start(): Promise<void> {
    this.sub = await this.transport.liveliness.subscribe(ROS2_LIVELINESS_GLOB, (e) => {
      if (e.alive) this.tokens.add(e.keyexpr);
      else this.tokens.delete(e.keyexpr);
      // A cold start delivers every token at once; rebuild once per burst, not per token.
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.onGraph(buildGraph(this.tokens));
      }, this.debounceMs);
    });
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    await this.sub?.close();
  }
}
