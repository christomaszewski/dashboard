// The browser side of vehicle state (docs/VEHICLE_STATE.md). Widgets acquire items (a topic + the
// fields they render); the client registers the set of live items as one view and keeps exactly
// one poll in flight for it. Each reply carries only the items that changed, so on a slow link
// replies get rarer and intermediate values are skipped — nothing queues.
import type { TopicSnapshot } from "../ros/topicStore";
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
  type PollReply,
  type RegisterReply,
} from "./protocol";

export interface VehicleSnapshot extends TopicSnapshot {
  /** Present when the vehicle advertises the topic. */
  typeName?: string;
  domainId?: number;
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
}

interface ClientItem {
  sig: string;
  spec: ItemSpec;
  /** The vehicle would reject this spec: never registered, its snapshot carries the reason. */
  invalid: boolean;
  refs: number;
  snapshot: VehicleSnapshot | null;
  linger: ReturnType<typeof setTimeout> | null;
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
  private generation = 0;
  private wakeUp: () => void = () => undefined;
  private woken: Promise<typeof SUPERSEDED> = this.armWake();
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;
  /** Set while the vehicle does not answer: every item shows it, and the next reply is a full one. */
  private outage: string | null = null;

  constructor(opts: VehicleStateClientOptions) {
    this.transport = opts.transport;
    this.keys = stateKeys(opts.base);
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.holdMs = opts.holdMs ?? 2000;
    this.lingerMs = opts.lingerMs ?? 1000;
    this.debounceMs = opts.debounceMs ?? 30;
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
          if (this.view?.sigs !== sigs) {
            const reg = await this.orWake(this.register(sigs));
            if (reg === SUPERSEDED || gen !== this.generation) continue;
            this.view = { id: reg.view, sigs };
            this.epoch = reg.epoch;
            this.since = 0;
          }
          const started = performance.now();
          const reply = await this.orWake(this.poll(this.view.id));
          if (reply === SUPERSEDED || gen !== this.generation) continue;
          if ("error" in reply) {
            this.view = null; // the vehicle restarted or expired the view: register again now
            continue;
          }
          this.apply(reply, sigs);
          backoff = 1000;
          await this.orWake(sleep(Math.max(0, this.minIntervalMs - (performance.now() - started))));
        } catch (e) {
          // Link trouble (refused while reconnecting, a missed deadline) keeps the last values: the
          // connection pill already says so. Only a vehicle that does not answer marks the items.
          const link = e instanceof TransportError;
          if (!link) this.fail(e instanceof Error ? e.message : String(e));
          // A refused call costs nothing on the link: retry quickly so recovery follows reconnect.
          const quick = link && e.code === "disconnected";
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

  private poll(view: string): Promise<PollReply> {
    return this.query<PollReply>(this.keys.poll, { v: VSTATE_VERSION, view, epoch: this.epoch, since: this.since }, this.holdMs + 6000);
  }

  private apply(reply: Exclude<PollReply, { error: string }>, sigs: string[]): void {
    this.epoch = reply.epoch;
    this.since = reply.seq;
    this.outage = null;
    for (const [index, state] of reply.items) {
      const item = this.items.get(sigs[index] ?? "");
      if (!item) continue; // released since this view was registered
      item.snapshot = toSnapshot(item, state);
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
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
