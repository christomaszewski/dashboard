// Shared, refcounted topic subscriptions: however many widgets watch a topic (a panel of six
// readouts, an hz status, the inspector), it costs ONE zenoh subscription and ONE decode per flush.
// Modeled on streams/pool/sessionPool.ts: refcounted entries, cached snapshots for
// useSyncExternalStore, per-key listener sets, a linger grace, injectable timing.
//
// Ordering doctrine: SUBSCRIBE FIRST, resolve the decoder in parallel — rate watching must work for
// types with no decoder at all, and `decode: false` consumers never trigger resolution (rate-
// watching a pointcloud must not decode it 5×/s).
import type { Subscription, Transport } from "../transport/types";
import type { DecodedMessage, Decoder, SchemaResolver } from "../schema/types";
import { RateMonitor } from "../home/rate";

export interface TopicKeyInfo {
  /** The store key — the rmw_zenoh data keyexpr (embeds domain/name/type/hash). */
  dataKeyexpr: string;
  typeName: string;
  typeHash: string;
  transientLocal: boolean;
}

export interface TopicSnapshot {
  key: string;
  /** Decoded at most once per flush, SHARED by all consumers — pluck fields at render. */
  message?: DecodedMessage;
  error?: string; // "no decoder: …" | "decode failed: …" | "subscribe failed: …"
  warning?: string; // decoder.lastWarning() after the most recent decode
  /** Rounded to 0.1 (the change-notification quantum); decays to undefined when publishing stops. */
  hz?: number;
  lastBytes?: number;
  latched?: boolean; // message came from the transient-local get, not a live sample
}

export interface TopicAcquireOptions {
  windowMs?: number;
  /** false = rate-only: no resolver.resolve, no decoding. Default true. */
  decode?: boolean;
}

export interface TopicHandle {
  readonly key: string;
  release(): void; // at most once
}

export interface TopicStoreOptions {
  transport: Transport;
  resolver: SchemaResolver;
  flushMs?: number;
  defaultWindowMs?: number;
  lingerMs?: number;
  /** Injectable clock (ms, monotonic) — vitest fake timers don't fake performance.now. */
  now?: () => number;
}

const FLUSH_MS = 200; // decode + notify at 5 Hz, however fast the topic publishes
const DEFAULT_WINDOW_MS = 5000;
// Grace after refs hit 0: StrictMode double-mounts effects in dev, and inspector topic-flips
// re-acquire immediately. Cheaper than the session pool's 3 s — a zenoh re-sub is not a WebRTC
// renegotiation.
const LINGER_MS = 1000;

interface HandleRecord {
  windowMs: number;
  decode: boolean;
}

interface Entry {
  key: string;
  info: TopicKeyInfo;
  handles: Set<HandleRecord>;
  closed: boolean; // stale-async guard (late Subscription/get/decoder resolutions)
  sub: Subscription | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  decoder: Decoder | null;
  decoderPromise: Promise<Decoder> | null;
  latest: { payload: Uint8Array; latched: boolean } | null;
  monitor: RateMonitor;
  sampleCount: number;
  seeded: boolean; // transient-local get fired (once per entry lifetime)
  // observable state (mirrored into the cached snapshot)
  message?: DecodedMessage;
  error?: string;
  warning?: string;
  hz?: number;
  lastBytes?: number;
  latched?: boolean;
  snapshot: TopicSnapshot | null;
}

const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

export class TopicStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly transport: Transport;
  private readonly resolver: SchemaResolver;
  private readonly flushMs: number;
  private readonly defaultWindowMs: number;
  private readonly lingerMs: number;
  private readonly now: () => number;

  constructor(opts: TopicStoreOptions) {
    this.transport = opts.transport;
    this.resolver = opts.resolver;
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    this.defaultWindowMs = opts.defaultWindowMs ?? DEFAULT_WINDOW_MS;
    this.lingerMs = opts.lingerMs ?? LINGER_MS;
    this.now = opts.now ?? (() => performance.now());
  }

  acquire(info: TopicKeyInfo, opts: TopicAcquireOptions = {}): TopicHandle {
    const key = info.dataKeyexpr;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        info,
        handles: new Set(),
        closed: false,
        sub: null,
        flushTimer: null,
        lingerTimer: null,
        decoder: null,
        decoderPromise: null,
        latest: null,
        monitor: new RateMonitor(this.defaultWindowMs),
        sampleCount: 0,
        seeded: false,
        snapshot: null,
      };
      this.entries.set(key, entry);
      this.open(entry);
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    const record: HandleRecord = {
      windowMs: opts.windowMs ?? this.defaultWindowMs,
      decode: opts.decode ?? true,
    };
    entry.handles.add(record);
    this.refreshWindow(entry);
    if (record.decode) this.ensureDecoder(entry);
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, record);
      },
    };
  }

  getSnapshot(key: string): TopicSnapshot | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!entry.snapshot) {
      entry.snapshot = {
        key: entry.key,
        message: entry.message,
        error: entry.error,
        warning: entry.warning,
        hz: entry.hz,
        lastBytes: entry.lastBytes,
        latched: entry.latched,
      };
    }
    return entry.snapshot;
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.teardown(entry);
    this.entries.clear();
  }

  // ---- internals -----------------------------------------------------------------------------

  private open(entry: Entry): void {
    entry.flushTimer = setInterval(() => this.flush(entry), this.flushMs);
    this.transport
      .subscribe(entry.key, (s) => {
        if (s.kind !== "put") return;
        entry.latest = { payload: s.payload, latched: false };
        entry.monitor.record(this.now());
        entry.sampleCount += 1;
        // No React work here — samples can arrive at hundreds of Hz; flush() notifies at 5 Hz.
      })
      .then((sub) => {
        if (entry.closed) return void sub.close();
        entry.sub = sub;
        this.seedTransientLocal(entry);
      })
      .catch((e) => {
        if (entry.closed) return;
        entry.error = `subscribe failed: ${e instanceof Error ? e.message : String(e)}`;
        this.emit(entry);
      });
  }

  /** rmw_zenoh backs latched publishers with a queryable — fetch the last value once. */
  private seedTransientLocal(entry: Entry): void {
    if (!entry.info.transientLocal || entry.seeded) return;
    entry.seeded = true;
    this.transport
      .get(entry.key)
      .then((replies) => {
        // Only seed if no live sample beat the reply here.
        if (entry.closed || replies.length === 0 || entry.latest !== null || entry.sampleCount > 0) return;
        entry.latest = { payload: replies[0].payload, latched: true };
      })
      .catch(() => {
        /* best-effort seed */
      });
  }

  private ensureDecoder(entry: Entry): void {
    if (entry.decoder || entry.decoderPromise) return;
    const identity = { flavor: "ros2" as const, typeName: entry.info.typeName, rihsHash: entry.info.typeHash };
    const pending = this.resolver.resolve(identity);
    entry.decoderPromise = pending;
    pending
      .then((decoder) => {
        if (entry.closed || entry.decoderPromise !== pending) return;
        entry.decoder = decoder;
        if (entry.error?.startsWith("no decoder")) entry.error = undefined;
      })
      .catch((e) => {
        if (entry.closed || entry.decoderPromise !== pending) return;
        entry.decoderPromise = null; // a later decoding acquire retries (resolver evicts failures)
        entry.error = `no decoder: ${e instanceof Error ? e.message : String(e)}`;
        this.emit(entry);
      });
  }

  private flush(entry: Entry): void {
    let changed = false;
    const hz = round1(entry.monitor.hz(this.now()));
    if (hz !== entry.hz) {
      entry.hz = hz;
      changed = true;
    }
    const pending = entry.latest;
    if (pending) {
      const wantsDecode = [...entry.handles].some((h) => h.decode);
      if (wantsDecode && entry.decoder) {
        try {
          entry.message = entry.decoder.decode(pending.payload);
          entry.warning = entry.decoder.lastWarning?.();
          if (entry.error?.startsWith("decode failed")) entry.error = undefined;
        } catch (e) {
          entry.error = `decode failed: ${e instanceof Error ? e.message : String(e)}`;
        }
        this.consume(entry, pending);
        changed = true;
      } else if (wantsDecode && entry.decoderPromise) {
        // Decoder still resolving — keep the sample for a later flush.
      } else {
        // Rate-only consumers, or resolution failed: bytes/latched still update.
        this.consume(entry, pending);
        changed = true;
      }
    }
    if (changed) this.emit(entry);
  }

  private consume(entry: Entry, pending: { payload: Uint8Array; latched: boolean }): void {
    entry.lastBytes = pending.payload.length;
    entry.latched = pending.latched;
    entry.latest = null;
  }

  private refreshWindow(entry: Entry): void {
    let max = 0;
    for (const h of entry.handles) max = Math.max(max, h.windowMs);
    entry.monitor.setWindow(max > 0 ? max : this.defaultWindowMs);
  }

  private release(key: string, record: HandleRecord): void {
    const entry = this.entries.get(key);
    if (!entry || !entry.handles.has(record)) return;
    entry.handles.delete(record);
    this.refreshWindow(entry);
    if (entry.handles.size > 0) return;
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      if (entry.handles.size === 0) {
        this.teardown(entry);
        this.entries.delete(key);
        this.notify(key);
      }
    }, this.lingerMs);
  }

  private teardown(entry: Entry): void {
    entry.closed = true;
    if (entry.flushTimer !== null) {
      clearInterval(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    void entry.sub?.close();
    entry.sub = null;
  }

  private emit(entry: Entry): void {
    entry.snapshot = null; // invalidate the cached snapshot
    this.notify(entry.key);
  }

  private notify(key: string): void {
    const set = this.listeners.get(key);
    if (set) for (const cb of [...set]) cb();
  }
}
