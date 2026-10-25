// The browser side of vehicle state (docs/VEHICLE_STATE.md). Widgets acquire items (a topic + the
// fields they render); the client registers the set of live items as one view and keeps exactly
// one poll in flight for it. Each reply carries only the items that changed, so on a slow link
// replies get rarer and intermediate values are skipped — nothing queues.
import type { HistoryPoint, TopicSnapshot } from "../ros/topicStore";
import type { HealthService } from "../health/types";
import { healthFromWire } from "./healthWire";
import { TransportError } from "../transport/reconnecting";
import type { Transport } from "../transport/types";
import {
  VSTATE_VERSION,
  canonicalItem,
  decodeMessage,
  encodeMessage,
  itemSignature,
  sparseMessage,
  stateKeys,
  validateViewSpec,
  type ItemSpec,
  type ItemState,
  type PollRequest,
  type PollReply,
  type RegisterReply,
} from "./protocol";

export interface VehicleSnapshot extends TopicSnapshot {
  /** Present when the vehicle advertises the topic. */
  typeName?: string;
  domainId?: number;
  /** Node items: the node is in the vehicle's graph. */
  alive?: boolean;
  /** Health "*": the vehicle's health service keys. */
  healthKeys?: readonly string[];
  /** Health service items: the service on this browser's clocks. */
  health?: HealthService;
}

export interface VehicleStateClientOptions {
  transport: Transport;
  /** fleet/<vehicle>/dash/<name>/state */
  base: string;
  /** Floor between poll starts: replies never arrive faster than this. */
  minIntervalMs?: number;
  /** The vehicle's poll hold; the poll deadline adds round-trip slack to it. */
  holdMs?: number;
  /** Keep a released item briefly (StrictMode remounts, quick tab flips). */
  lingerMs?: number;
  /** Batch widget mounts into one view change. */
  debounceMs?: number;
  /** How long the vehicle may go unanswered before items show it (a re-joining bridge, a service
   *  restart: values stay up through brief gaps instead of flashing an error). */
  outageGraceMs?: number;
}

interface ClientItem {
  sig: string;
  spec: ItemSpec;
  /** The vehicle would reject this spec: never registered, its snapshot carries the reason. */
  invalid: boolean;
  refs: number;
  snapshot: VehicleSnapshot | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** Trail items: the points so far and the absolute index of the next one. */
  trail?: { next: number; pts: [number, number][] };
  /** Series items: buckets by absolute index, on this browser's monotonic clock. */
  series?: Map<number, HistoryPoint>;
}

const SUPERSEDED = Symbol("superseded");

export class VehicleStateClient {
  private readonly transport: Transport;
  private readonly keys: { view: string; poll: string };
  private readonly minIntervalMs: number;
  private readonly holdMs: number;
  private readonly lingerMs: number;
  private readonly debounceMs: number;
  private readonly items = new Map<string, ClientItem>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private wanted: string[] = [];
  private view: { id: string; sigs: string[] } | null = null;
  private epoch = "";
  private since = 0;
  /** Items whose whole state this client holds (as of `since`). By object: a re-created item is new. */
  private readonly complete = new WeakSet<ClientItem>();
  /** Of the current view, the items to ask for whole on the next poll. */
  private fresh = new Set<string>();
  private generation = 0;
  private wakeUp: () => void = () => undefined;
  private woken: Promise<typeof SUPERSEDED> = this.armWake();
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;
  /** Set while the vehicle does not answer: every item shows it, and the next reply is a full one. */
  private outage: string | null = null;
  /** When the current run of unanswered requests began (null = the last one was answered). */
  private unansweredSince: number | null = null;
  private readonly outageGraceMs: number;

  constructor(opts: VehicleStateClientOptions) {
    this.transport = opts.transport;
    this.keys = stateKeys(opts.base);
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.holdMs = opts.holdMs ?? 2000;
    this.lingerMs = opts.lingerMs ?? 1000;
    this.debounceMs = opts.debounceMs ?? 30;
    this.outageGraceMs = opts.outageGraceMs ?? 3000;
  }

  acquire(spec: ItemSpec): { key: string; release(): void } {
    const canonical = canonicalItem(spec);
    const sig = itemSignature(canonical);
    let item = this.items.get(sig);
    if (!item) {
      // Validate alone: one widget's bad field path must not get every other item's view refused.
      let invalid: string | null = null;
      try {
        validateViewSpec({ v: VSTATE_VERSION, items: [canonical] });
      } catch (e) {
        invalid = `vehicle state: ${e instanceof Error ? e.message.replace(/^items\[0\]\./, "") : String(e)}`;
      }
      const snapshot = invalid ? { key: sig, error: invalid } : this.outage ? { key: sig, error: this.outage } : null;
      item = { sig, spec: canonical, invalid: invalid !== null, refs: 0, snapshot, linger: null };
      this.items.set(sig, item);
      if (!invalid) this.scheduleViewChange();
    }
    if (item.linger !== null) {
      clearTimeout(item.linger);
      item.linger = null;
    }
    item.refs += 1;
    let released = false;
    return {
      key: sig,
      release: () => {
        if (released) return;
        released = true;
        this.release(sig);
      },
    };
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  getSnapshot(key: string): VehicleSnapshot | null {
    return this.items.get(key)?.snapshot ?? null;
  }

  close(): void {
    this.closed = true;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    for (const item of this.items.values()) if (item.linger !== null) clearTimeout(item.linger);
    this.items.clear();
    this.wakeUp();
  }

  // ---- view membership -----------------------------------------------------------------------

  private release(sig: string): void {
    const item = this.items.get(sig);
    if (!item || --item.refs > 0) return;
    item.linger = setTimeout(() => {
      if (item.refs > 0) return;
      this.items.delete(sig);
      if (!item.invalid) this.scheduleViewChange();
    }, this.lingerMs);
  }

  private scheduleViewChange(): void {
    if (this.closed || this.viewTimer !== null) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      // Sorted, so operators showing the same widgets share one view on the vehicle.
      this.wanted = [...this.items.values()].filter((i) => !i.invalid).map((i) => i.sig).sort();
      this.generation += 1;
      this.wakeUp();
      if (!this.running && this.items.size > 0) void this.run();
    }, this.debounceMs);
  }

  private armWake(): Promise<typeof SUPERSEDED> {
    return new Promise((resolve) => {
      this.wakeUp = () => {
        this.woken = this.armWake();
        resolve(SUPERSEDED);
      };
    });
  }

  /** Resolve with the operation, or SUPERSEDED as soon as the view changes (the late result is dropped). */
  private orWake<T>(op: Promise<T>): Promise<T | typeof SUPERSEDED> {
    op.catch(() => undefined);
    return Promise.race([op, this.woken]);
  }

  // ---- the poll loop -------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.running = true;
    let backoff = 1000;
    try {
      while (!this.closed && this.wanted.length > 0) {
        const gen = this.generation;
        const sigs = this.wanted;
        try {
          const fresh = this.view?.sigs !== sigs;
          if (fresh) {
            const reg = await this.orWake(this.register(sigs));
            if (reg === SUPERSEDED || gen !== this.generation) continue;
            // Our own view change: keep what we have and ask only for the new items whole. The
            // previous view still holds the shared items on the vehicle, so their trails and
            // histories continue. Otherwise (first view, new epoch, an older vehicle) start over.
            const keep = reg.fresh === 1 && reg.epoch === this.epoch && this.since > 0;
            this.view = { id: reg.view, sigs };
            this.epoch = reg.epoch;
            if (keep) this.fresh = new Set(sigs.filter((sig) => { const item = this.items.get(sig); return !item || !this.complete.has(item); }));
            else this.since = 0;
          }
          const started = performance.now();
          const askedSince = this.since;
          const askedEpoch = this.epoch;
          const askedFresh = askedSince > 0 ? this.fresh : new Set<string>();
          const askedItems = sigs.map((sig) => this.items.get(sig));
          const reply = await this.orWake(this.poll(this.view!, askedFresh));
          if (reply === SUPERSEDED || gen !== this.generation) continue;
          if ("error" in reply) {
            // The vehicle restarted or expired the view: register again now — but if it forgets a
            // view it just accepted (evicted at its view limit), back off instead of spinning.
            // Its items may have been dropped and begun anew there: ask for everything.
            this.view = null;
            this.since = 0;
            if (fresh) await this.orWake(sleep(backoff));
            continue;
          }
          // A reply to since 0, or from a different epoch, is complete: trails and histories restart.
          this.apply(reply, sigs, askedSince === 0 || reply.epoch !== askedEpoch, askedFresh);
          // Every item asked about is now whole here: changed ones arrived, the rest already were.
          for (const item of askedItems) if (item) this.complete.add(item);
          backoff = 1000;
          await this.orWake(sleep(Math.max(0, this.minIntervalMs - (performance.now() - started))));
        } catch (e) {
          // Link trouble (refused while reconnecting, a missed deadline) keeps the last values: the
          // connection pill already says so. Only a vehicle that does not answer marks the items.
          const link = e instanceof TransportError;
          // Nobody answered: mark the items once that has lasted the grace period; until then keep
          // the values and retry quickly (a bridge re-joining the router, a restarting service).
          let grace = false;
          if (!link) {
            const now = Date.now();
            this.unansweredSince ??= now;
            grace = now - this.unansweredSince < this.outageGraceMs;
            if (!grace) this.fail(e instanceof Error ? e.message : String(e));
          }
          // A refused call costs nothing on the link: retry quickly so recovery follows reconnect.
          const quick = (link && e.code === "disconnected") || grace;
          await this.orWake(sleep(quick ? 500 : backoff));
          if (!quick) backoff = Math.min(backoff * 2, 5000);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async query<T>(key: string, body: unknown, timeoutMs: number): Promise<T> {
    let replyError = "";
    const replies = await this.transport.get(key, {
      payload: encodeMessage(body),
      timeoutMs,
      maxReplyBytes: 4 * 1024 * 1024,
      onReplyError: (message) => (replyError = message),
    });
    if (replies.length > 1) throw new Error(`more than one vehicle answers ${key} — give each vehicle a distinct vehicle_id`);
    if (replies.length === 0) {
      if (replyError) throw new Error(`vehicle state: ${replyError}`);
      throw new Error(`vehicle state service not reachable (${key})`);
    }
    return decodeMessage(replies[0].payload) as T;
  }

  private register(sigs: string[]): Promise<RegisterReply> {
    const items = sigs.map((s) => this.items.get(s)?.spec ?? (JSON.parse(s) as ItemSpec));
    return this.query<RegisterReply>(this.keys.view, { v: VSTATE_VERSION, items }, 5000);
  }

  private poll(view: { id: string; sigs: string[] }, fresh: ReadonlySet<string>): Promise<PollReply> {
    const body: PollRequest = { v: VSTATE_VERSION, view: view.id, epoch: this.epoch, since: this.since };
    if (fresh.size > 0) body.fresh = view.sigs.flatMap((sig, i) => (fresh.has(sig) ? [i] : []));
    return this.query<PollReply>(this.keys.poll, body, this.holdMs + 6000);
  }

  private apply(reply: Exclude<PollReply, { error: string }>, sigs: string[], full: boolean, fresh: ReadonlySet<string>): void {
    this.epoch = reply.epoch;
    this.since = reply.seq;
    this.fresh = new Set();
    this.outage = null;
    this.unansweredSince = null;
    for (const [index, state] of reply.items) {
      const item = this.items.get(sigs[index] ?? "");
      if (!item) continue; // released since this view was registered
      const next = toSnapshot(item, state);
      // Advertised but no sample since the vehicle (re)subscribed — a restarted service, a
      // re-advertised topic: keep showing the last value, marked stale, instead of blanking it.
      if (next.message === undefined && state.t !== undefined && !state.e && item.snapshot?.message !== undefined && (item.spec.fields?.length ?? 0) > 0) {
        next.message = item.snapshot.message;
        next.stale = true;
      }
      const whole = full || fresh.has(item.sig);
      if (item.spec.trail !== undefined) next.trail = mergeTrail(item, state, whole);
      else if (item.trail) delete item.trail;
      if (item.spec.series !== undefined) next.history = mergeSeries(item, state, whole);
      item.snapshot = next;
      this.notify(item.sig);
    }
  }

  private fail(message: string): void {
    this.outage = message;
    this.since = 0; // the next answer must restore every item, not just changes
    for (const item of this.items.values()) {
      if (item.invalid) continue;
      item.snapshot = { ...(item.snapshot ?? { key: item.sig }), error: message };
      this.notify(item.sig);
    }
  }

  private notify(key: string): void {
    const set = this.listeners.get(key);
    if (set) for (const cb of [...set]) cb();
  }
}

/** New trail points continue the trail when they start where it ends; anything else replaces it. */
function mergeTrail(item: ClientItem, state: ItemState, full: boolean): readonly [number, number][] | undefined {
  const t = (item.trail ??= { next: 0, pts: [] });
  if (state.tr) {
    const { i, p } = state.tr;
    if (!full && i === t.next) t.pts.push(...p);
    else if (!full && i < t.next && i + p.length > t.next) t.pts.push(...p.slice(t.next - i));
    else if (full || i !== t.next) t.pts = [...p];
    t.next = i + p.length;
    const over = t.pts.length - (item.spec.trail ?? t.pts.length);
    if (over > 0) t.pts.splice(0, over);
  } else if (full) {
    t.pts = [];
    t.next = 0;
  }
  return t.pts.slice();
}

/** Changed buckets replace theirs by index; ages become this browser's clock; the window is kept. */
function mergeSeries(item: ClientItem, state: ItemState, full: boolean): readonly HistoryPoint[] | undefined {
  const series = (item.series ??= new Map());
  if (full) series.clear();
  const now = performance.now();
  for (const [index, age, min, max, last] of state.hs ?? []) series.set(index, { t: now - age, min, max, last });
  const windowMs = item.spec.series?.window_ms ?? Infinity;
  const ordered = [...series.entries()].sort((a, b) => a[0] - b[0]);
  // Keep the window, and always the newest bucket (an unchanged value is still the value).
  for (const [index, point] of ordered.slice(0, -1)) if (now - point.t > windowMs) series.delete(index);
  return [...series.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
}

function toSnapshot(item: ClientItem, state: ItemState): VehicleSnapshot {
  const fields = item.spec.fields ?? [];
  return {
    key: item.sig,
    typeName: state.t,
    domainId: state.d,
    message: fields.length > 0 && state.f ? sparseMessage(fields, state.f) : undefined,
    hz: state.hz,
    error: state.e,
    warning: state.w,
    latched: state.l === 1 || undefined,
    stale: state.s === 1 || undefined,
    alive: state.a === undefined ? undefined : state.a === 1,
    healthKeys: state.hk,
    health: state.hd ? healthFromWire(state.hd) : undefined,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
