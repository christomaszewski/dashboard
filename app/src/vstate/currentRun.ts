import type { RigCurrentRun } from "../rig/types";
import type { IncomingQuery, Subscription } from "../transport/types";
import { encodeMessage } from "./protocol";

export type CurrentRunFields = Pick<RigCurrentRun, "ok" | "run_id" | "run_dir" | "label" | "started" | "error">;
export interface CurrentRunSource {
  current(): RigCurrentRun;
  /** Meaningful changes only: ordinary observation timestamps and feed heartbeats do not notify. */
  subscribe(cb: () => void): () => void;
}

export const NO_CURRENT_RUN: CurrentRunFields = { ok: true, run_id: null, run_dir: null, label: null, started: null, error: null };
export const currentRunError = (error: string): CurrentRunFields => ({ ...NO_CURRENT_RUN, ok: false, error });
export function currentRunKey(vehicleId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(vehicleId)) throw new Error("VEHICLE_ID must be one plain Zenoh key segment");
  return `fleet/${vehicleId}/rig/current_run`;
}

/** Current-run identity and state, excluding the last-observed timestamp. */
export function currentRunSignature(run: RigCurrentRun): string {
  const { at_unix_s: _at, ...state } = run;
  void _at;
  return JSON.stringify(state);
}

/** One independent registry observer for dashboard-state; it never imports or executes Rig. */
export class CurrentRunWatcher implements CurrentRunSource {
  private doc: RigCurrentRun;
  private readonly callbacks = new Set<() => void>();
  private readonly wallNow: () => number;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private observedAt: number;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: {
    vehicleId: string;
    read: () => Promise<CurrentRunFields>;
    epoch?: string;
    now?: () => number;
    wallNow?: () => number;
    pollMs?: number;
    staleMs?: number;
  }) {
    currentRunKey(options.vehicleId);
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.pollMs = options.pollMs ?? 2000;
    this.staleMs = options.staleMs ?? 10_000;
    this.observedAt = this.now();
    this.doc = { schema_version: 1, vehicle_id: options.vehicleId, epoch: options.epoch ?? crypto.randomUUID(),
      revision: 1, at_unix_s: this.wallNow() / 1000, ...currentRunError("no registry observation yet") };
  }

  current(): RigCurrentRun { return this.doc; }
  subscribe(cb: () => void): () => void { this.callbacks.add(cb); return () => void this.callbacks.delete(cb); }

  start(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  /** A stuck filesystem read cannot masquerade as a current run merely because polls still work. */
  tick(): void {
    if (this.closed) return;
    if (this.now() - this.observedAt > this.staleMs)
      this.update(currentRunError("run registry observation is stale"), false);
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let fields: CurrentRunFields;
      try { fields = await this.options.read(); }
      catch (error) { fields = currentRunError(`run registry: ${error instanceof Error ? error.message : String(error)}`); }
      if (!this.closed) this.update(fields, true);
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  private update(fields: CurrentRunFields, observed: boolean): void {
    const changed = (Object.keys(fields) as (keyof CurrentRunFields)[]).some(k => this.doc[k] !== fields[k]);
    // The initial unknown document can already have been queried while the first filesystem read
    // is pending. Its replacement must advance the revision too, so consumers never dedup it away.
    const revision = this.doc.revision + Number(changed);
    if (observed) this.observedAt = this.now();
    this.doc = { ...this.doc, ...fields, revision, at_unix_s: observed ? this.wallNow() / 1000 : this.doc.at_unix_s };
    if (changed) for (const cb of [...this.callbacks]) cb();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.callbacks.clear();
  }
}

interface CurrentRunTransport {
  declarePublisher(key: string, opts?: { encoding?: "application/json" }): Promise<Subscription & { put(payload: Uint8Array): Promise<void> }>;
  declareQueryable(key: string, cb: (query: IncomingQuery) => void, opts?: { replyKey?: string; encoding?: "application/json" }): Promise<Subscription>;
}

/** Reusable native feed for other services. Browser headers use the optimized view/poll item. */
export async function serveCurrentRun(source: CurrentRunSource, transport: CurrentRunTransport,
  opts: { now?: () => number; heartbeatMs?: number; log?: (message: string) => void } = {}): Promise<Subscription> {
  const key = currentRunKey(source.current().vehicle_id);
  const now = opts.now ?? (() => performance.now());
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const log = opts.log ?? (() => undefined);
  const publisher = await transport.declarePublisher(key, { encoding: "application/json" });
  let queryable: Subscription;
  try {
    queryable = await transport.declareQueryable(key, (q) => {
      void q.reply(encodeMessage(source.current())).catch((e) => log(`current run reply failed: ${String(e)}`));
    }, { replyKey: key, encoding: "application/json" });
  } catch (error) {
    await publisher.close().catch(() => undefined);
    throw error;
  }
  let closed = false;
  let sent: string | undefined;
  let lastSent = -Infinity;
  let pending: Promise<void> | null = null;
  const publish = (): void => {
    if (closed || pending) return;
    pending = (async () => {
      // A change during an in-flight publication follows it, in order, without overlapping puts.
      while (!closed) {
        const doc = source.current();
        const signature = currentRunSignature(doc);
        if (signature === sent && now() - lastSent < heartbeatMs) return;
        try { await publisher.put(encodeMessage(doc)); }
        catch (error) { log(`current run publish failed: ${String(error)}`); return; }
        sent = signature;
        lastSent = now();
      }
    })().finally(() => { pending = null; });
  };
  const unsubscribe = source.subscribe(publish);
  const timer = setInterval(publish, 2000); // failed puts retry; unchanged data gets one 30 s heartbeat
  publish();
  return { close: async () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
    await Promise.allSettled([queryable.close(), publisher.close()]);
  } };
}
