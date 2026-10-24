// The vehicle side of vehicle state (docs/VEHICLE_STATE.md). Runs next to the ROS graph, where
// full-rate topics are cheap: subscribes through the same TopicStore the browser uses (one
// subscription and one 5 Hz decode per topic, rate monitoring, transient-local seeding), projects
// and quantizes the fields each registered item asks for, and numbers every change. Polls return
// the items that changed after the caller's `since`, or wait for one (bounded by holdMs).
//
// No per-client state: an item remembers the update number of its last change; a view is just a
// list of items. Views nobody polls expire; items and raw subscriptions go with their last view.
import { EMPTY_GRAPH, ROS2_LIVELINESS_GLOB, buildGraph, type RosGraph, type TopicEntry } from "../ros/graph";
import type { TopicAcquireOptions, TopicHandle, TopicSnapshot } from "../ros/topicStore";
import type { IncomingQuery, Subscription, Transport } from "../transport/types";
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
  type PollReply,
  type RegisterReply,
} from "./protocol";

/** The slice of TopicStore the server needs (a fake in tests). */
export interface TopicSource {
  acquire(info: TopicEntry, opts?: TopicAcquireOptions): TopicHandle;
  subscribe(key: string, cb: () => void): () => void;
  getSnapshot(key: string): TopicSnapshot | null;
}

export interface StateServerOptions {
  store: TopicSource;
  /** Monotonic ms — the same clock the store stamps `lastAt` with. */
  now?: () => number;
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

interface ItemRecord {
  sig: string;
  spec: ItemSpec;
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

export class VehicleStateServer {
  readonly epoch: string;
  private readonly store: TopicSource;
  private readonly now: () => number;
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

  constructor(opts: StateServerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => performance.now());
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

  /** Re-bind every item to the topic now advertised under its name. */
  setGraph(graph: RosGraph): void {
    this.graph = graph;
    for (const rec of this.items.values()) {
      this.bind(rec);
      this.recompute(rec);
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
      rec = { sig, spec, fields: spec.fields ?? [], refs: 0, state: {}, json: "", changedSeq: 0 };
      this.items.set(sig, rec);
      this.bind(rec);
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
    if (json.length > LIMITS.stateBytes) {
      state = { t: state.t, d: state.d, e: `vehicle state: value too large (${json.length} B > ${LIMITS.stateBytes} B) — choose a smaller field` };
      json = JSON.stringify(state);
    }
    if (json === rec.json) return;
    rec.json = json;
    rec.state = state;
    rec.changedSeq = ++this.seq;
    this.scheduleWake();
  }

  private computeState(rec: ItemRecord): ItemState {
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
      if (rec.changedSeq > since) out.push([i, rec.state]);
    });
    return out;
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
    await query.replyErr(e instanceof Error ? e.message : String(e));
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
