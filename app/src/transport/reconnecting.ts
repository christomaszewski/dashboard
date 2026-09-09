// A Transport that survives the link: dials an inner transport, watches it with a heartbeat, and
// on a drop reconnects with backoff and re-declares every subscription -- behind ONE object whose
// identity never changes, so contexts, stores and widgets keep their state across an outage.
//
// Why it exists: zenoh-ts dials the remote-api WebSocket once and never again, and a browser
// `send()` on a closed socket is silently discarded (no throw, no reply, ever). Over a spotty
// wireless link that meant a dead page until reload, and service calls that hung forever. Here
// every query carries a CLIENT-side deadline, a query in flight when the link goes is rejected at
// once, and while disconnected a query is refused immediately instead of queued into the void.
//
// Liveliness on reconnect: the remote session is gone with the socket, so tokens that vanished
// during the outage will never be DELETEd to us. Before re-declaring a liveliness subscription
// every key it saw alive is reported gone; the re-declaration's history then re-PUTs what is still
// there. Consumers already ride out a DELETE+PUT within their grace windows (streams, lifecycle,
// playback, rig) or rebuild from the token set (the graph), so the burst is harmless.
//
// The history replay alone is not enough, observed on the bench: a browser re-dials the sidecar
// the moment its process is back, before its own session has rejoined the router, and the replay
// finds nothing -- the page sat "connected" with every tile offline. So a reconnect also RESYNCS:
// over the first seconds it queries the current tokens for each liveliness subscription and
// synthesizes the PUTs the replay missed (a token seen twice is filtered, so nothing double-fires).
import type { GetReply, LivelinessEvent, Sample, Subscription, Transport, TransportGetOptions } from "./types";

export type LinkStatus = "connecting" | "connected" | "reconnecting" | "error";

export type TransportErrorCode = "disconnected" | "deadline" | "closed";

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ReconnectingOptions {
  /** Dial the inner transport (a fresh one per attempt). */
  open: () => Promise<Transport>;
  /** Heartbeat cadence while connected (a liveliness query on a key nothing declares). */
  probeMs?: number;
  /** A probe unanswered this long = the link is gone. */
  probeTimeoutMs?: number;
  /** Client-side deadline on a query = its zenoh timeout + this margin. */
  deadlineMarginMs?: number;
  /** The zenoh timeout assumed when a query names none (zenoh-ts's default). */
  defaultTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Where the status goes (the provider); also readable via status(). */
  onStatus?: (status: LinkStatus, error: string) => void;
}

const PROBE_KEY = "@dashboard/link-probe";
const PROBE_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;
const DEADLINE_MARGIN_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;
/** After a reconnect, when to re-query the live tokens (ms after the re-declaration). */
const RESYNC_AT_MS = [1_000, 5_000, 15_000];

type RosSubscriberTopic = Parameters<NonNullable<Transport["declareRosSubscriber"]>>[0];

type Record_ =
  | { kind: "sample"; keyexpr: string; handler: (s: Sample) => void; inner: Subscription | null }
  | { kind: "liveliness"; keyexpr: string; handler: (e: LivelinessEvent) => void; inner: Subscription | null; alive: Set<string> }
  | { kind: "ros"; topic: RosSubscriberTopic; inner: Subscription | null };

export class ReconnectingTransport implements Transport {
  private inner: Transport | null = null;
  private status_: LinkStatus = "connecting";
  private error_ = "";
  private closed = false;
  private generation = 0; // bumps on every drop: callbacks from an old inner are ignored
  private readonly records = new Map<number, Record_>();
  private nextId = 1;
  private readonly dropWaiters = new Set<(e: TransportError) => void>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resyncTimers = new Set<ReturnType<typeof setTimeout>>();
  private backoffMs: number;
  private readonly opts: Required<Omit<ReconnectingOptions, "onStatus">> & Pick<ReconnectingOptions, "onStatus">;

  constructor(opts: ReconnectingOptions) {
    this.opts = {
      probeMs: PROBE_MS,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      deadlineMarginMs: DEADLINE_MARGIN_MS,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      retryBaseMs: RETRY_BASE_MS,
      retryMaxMs: RETRY_MAX_MS,
      ...opts,
    };
    this.backoffMs = this.opts.retryBaseMs;
  }

  status(): LinkStatus {
    return this.status_;
  }

  lastError(): string {
    return this.error_;
  }

  /** Dial. Resolves on the first successful connect; a failed first dial reports `error` and keeps
   *  retrying in the background (the sidecar may simply not be up yet), resolving when it lands. */
  async start(): Promise<void> {
    this.setStatus("connecting", "");
    await this.attempt(true);
  }

  private setStatus(status: LinkStatus, error: string): void {
    this.status_ = status;
    this.error_ = error;
    this.opts.onStatus?.(status, error);
  }

  private get connected(): boolean {
    return this.inner !== null && this.status_ === "connected" && !this.closed;
  }

  // ---- the link -------------------------------------------------------------------------------

  private async attempt(first: boolean): Promise<void> {
    if (this.closed) return;
    let t: Transport;
    try {
      t = await this.opts.open();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // first dial: surface the error (the page shows it) but keep trying; later: stay "reconnecting"
      this.setStatus(first ? "error" : "reconnecting", msg);
      this.scheduleRetry();
      return;
    }
    if (this.closed) {
      void t.close().catch(() => undefined);
      return;
    }
    this.inner = t;
    this.generation += 1;
    this.backoffMs = this.opts.retryBaseMs;
    // "connected" BEFORE the re-declaration, not after: the history replay delivers PUTs while it
    // runs, and every consumer answers a PUT by fetching its descriptor through get() -- which is
    // refused while the link is not connected. Seen on the bench: tokens replayed, descriptors
    // refused, the page "connected" with every tile offline and the resync filtering the keys as
    // already alive.
    this.setStatus("connected", "");
    await this.redeclareAll(t, this.generation);
    if (this.inner !== t) return; // dropped during the re-declare
    this.startProbe();
    if (!first) this.scheduleResync(t, this.generation);
  }

  private scheduleResync(t: Transport, gen: number): void {
    for (const at of RESYNC_AT_MS) {
      const timer = setTimeout(() => {
        this.resyncTimers.delete(timer);
        void this.resync(t, gen);
      }, at);
      this.resyncTimers.add(timer);
    }
  }

  private clearResyncs(): void {
    for (const timer of this.resyncTimers) clearTimeout(timer);
    this.resyncTimers.clear();
  }

  /** Query the tokens currently live for every liveliness subscription; PUT the ones the
   *  re-declaration's history never delivered. Failures are the probe's business. */
  private async resync(t: Transport, gen: number): Promise<void> {
    if (gen !== this.generation || this.inner !== t || !this.connected) return;
    for (const [id, r] of [...this.records]) {
      if (r.kind !== "liveliness") continue;
      let keys: string[];
      try {
        keys = await this.withDeadline(t.liveliness.get(r.keyexpr), this.opts.probeTimeoutMs, `resync ${r.keyexpr}`);
      } catch {
        return;
      }
      if (gen !== this.generation || !this.records.has(id)) return;
      for (const key of keys) {
        if (r.alive.has(key)) continue;
        r.alive.add(key);
        r.handler({ keyexpr: key, alive: true });
      }
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== null) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.retryMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt(false);
    }, wait);
  }

  /** The link is gone (a failed probe, a query past its deadline with a failed probe, an inner op
   *  that threw): close the inner, fail what is in flight, and start reconnecting. */
  private drop(reason: string): void {
    if (this.closed || this.inner === null) return;
    const dead = this.inner;
    this.inner = null;
    this.generation += 1;
    this.stopProbe();
    this.clearResyncs();
    for (const r of this.records.values()) r.inner = null; // the remote session took them with it
    const err = new TransportError("disconnected", `link lost: ${reason}`);
    for (const reject of [...this.dropWaiters]) reject(err);
    this.dropWaiters.clear();
    this.setStatus("reconnecting", reason);
    void dead.close().catch(() => undefined);
    this.scheduleRetry();
  }

  private startProbe(): void {
    this.stopProbe();
    this.probeTimer = setInterval(() => void this.probe(), this.opts.probeMs);
  }

  private stopProbe(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /** One round trip that needs no data: a liveliness query on a key nothing declares. */
  private async probe(): Promise<void> {
    const t = this.inner;
    if (t === null || !this.connected) return;
    const gen = this.generation;
    try {
      await this.withDeadline(t.liveliness.get(PROBE_KEY), this.opts.probeTimeoutMs, "link probe");
    } catch (e) {
      if (gen === this.generation && this.inner === t) this.drop(e instanceof Error ? e.message : String(e));
    }
  }

  private withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropWaiters.delete(onDrop);
        reject(new TransportError("deadline", `${what}: no answer within ${ms} ms`));
      }, ms);
      const onDrop = (e: TransportError) => {
        clearTimeout(timer);
        reject(e);
      };
      this.dropWaiters.add(onDrop);
      p.then(
        (v) => {
          clearTimeout(timer);
          this.dropWaiters.delete(onDrop);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          this.dropWaiters.delete(onDrop);
          reject(e);
        },
      );
    });
  }

  // ---- re-declaration -------------------------------------------------------------------------

  private async redeclareAll(t: Transport, gen: number): Promise<void> {
    for (const [id, r] of [...this.records]) {
      if (gen !== this.generation || this.inner !== t) return;
      try {
        if (r.kind === "liveliness") {
          // everything seen alive is reported gone; the history re-PUTs what still is
          for (const key of [...r.alive]) r.handler({ keyexpr: key, alive: false });
          r.alive.clear();
        }
        await this.declare(t, gen, id, r);
      } catch (e) {
        // a failed re-declare means the new link is already bad: let the probe take it from here
        console.warn("[transport] re-declare failed", r.kind, e);
      }
    }
  }

  private async declare(t: Transport, gen: number, id: number, r: Record_): Promise<void> {
    let sub: Subscription;
    if (r.kind === "sample") {
      sub = await t.subscribe(r.keyexpr, (s) => {
        if (gen === this.generation && this.records.has(id)) r.handler(s);
      });
    } else if (r.kind === "liveliness") {
      sub = await t.liveliness.subscribe(r.keyexpr, (e) => {
        if (gen !== this.generation || !this.records.has(id)) return;
        if (e.alive) r.alive.add(e.keyexpr);
        else r.alive.delete(e.keyexpr);
        r.handler(e);
      });
    } else {
      if (!t.declareRosSubscriber) return;
      sub = await t.declareRosSubscriber(r.topic);
    }
    if (gen !== this.generation || !this.records.has(id)) {
      void sub.close().catch(() => undefined); // dropped or released meanwhile
      return;
    }
    r.inner = sub;
  }

  private track(r: Record_): Subscription {
    const id = this.nextId++;
    this.records.set(id, r);
    const t = this.inner;
    if (t !== null && this.connected) void this.declare(t, this.generation, id, r).catch((e) => console.warn("[transport] declare failed", e));
    return {
      close: async () => {
        this.records.delete(id);
        const s = r.inner;
        r.inner = null;
        if (s) await s.close().catch(() => undefined);
      },
    };
  }

  // ---- Transport ------------------------------------------------------------------------------

  async subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription> {
    return this.track({ kind: "sample", keyexpr, handler: onSample, inner: null });
  }

  async declareRosSubscriber(topic: RosSubscriberTopic): Promise<Subscription> {
    return this.track({ kind: "ros", topic, inner: null });
  }

  readonly liveliness = {
    subscribe: async (keyexpr: string, onEvent: (e: LivelinessEvent) => void): Promise<Subscription> =>
      this.track({ kind: "liveliness", keyexpr, handler: onEvent, inner: null, alive: new Set() }),
    get: async (keyexpr: string): Promise<string[]> => {
      const t = this.requireLink();
      return this.guarded(t.liveliness.get(keyexpr), this.opts.defaultTimeoutMs, `liveliness ${keyexpr}`);
    },
  };

  async get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    const t = this.requireLink();
    return this.guarded(t.get(keyexpr, opts), opts?.timeoutMs ?? this.opts.defaultTimeoutMs, `query ${keyexpr}`);
  }

  private requireLink(): Transport {
    if (this.closed) throw new TransportError("closed", "transport closed");
    if (this.inner === null || !this.connected) throw new TransportError("disconnected", `link ${this.status_}: ${this.error_ || "not connected"}`);
    return this.inner;
  }

  /** A query with the client-side deadline (zenoh timeout + margin): past it, the socket is the
   *  suspect, so a probe runs at once and decides. */
  private async guarded<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    try {
      return await this.withDeadline(p, timeoutMs + this.opts.deadlineMarginMs, what);
    } catch (e) {
      if (e instanceof TransportError && e.code === "deadline") void this.probe();
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopProbe();
    this.clearResyncs();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const err = new TransportError("closed", "transport closed");
    for (const reject of [...this.dropWaiters]) reject(err);
    this.dropWaiters.clear();
    const t = this.inner;
    this.inner = null;
    this.records.clear();
    if (t) await t.close().catch(() => undefined);
  }
}
