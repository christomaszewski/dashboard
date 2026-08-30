// Shared, refcounted WebRTC session pool. One session per stream key regardless of how many places
// render it (Home video widget + Cameras tab, grid + thumb) — one encode on the vehicle, and tab
// switches / re-parenting never renegotiate. Framework-free with injectable source factory + timing
// so the whole state machine runs under vitest's node environment with fake timers.
//
// The self-healing behavior is a 1:1 port of the on-vehicle-verified StreamView logic:
//   - exponential retry backoff (1 s → 10 s), single pending retry, offline short-circuit
//   - backoff reset + state=playing on an attached element's `playing` event (frames rendering is
//     the health signal, not session open); fallback when nothing is attached: first track unmute
//   - stall watchdog: currentTime frozen for STALL_MS (above the ZR30's ~6 s ride-through output
//     gaps) → retry; sampled from the first non-paused attached element
//   - liveliness flap via updateStreams: alive→true resumes immediately (fresh descriptor — ports/
//     geometry may have changed across a producer restart); true→false drops the session, offline
import type { DiscoveredStream, StreamDescriptor } from "../types";
import type { StreamSource } from "../source/types";

export type SessionState = "opening" | "playing" | "reconnecting" | "offline";

export interface SessionSnapshot {
  key: string;
  state: SessionState;
  /** Last retry reason ("" when healthy). */
  error: string;
  mediaStream: MediaStream | null;
  attachCount: number;
}

/** Minimal element surface — tests pass plain fake objects, production passes HTMLVideoElement. */
export type VideoLike = {
  srcObject: MediaProvider | null;
  currentTime: number;
  paused: boolean;
  play(): Promise<void>;
  addEventListener(type: "playing", cb: () => void): void;
  removeEventListener(type: "playing", cb: () => void): void;
};

export interface StreamHandle {
  readonly key: string;
  /** Wire this element to the session's MediaStream (+ health listeners). Idempotent. */
  attach(video: VideoLike): void;
  detach(video: VideoLike): void;
  /** Refcount--; the session closes LINGER_MS after reaching 0 (re-acquire cancels it). */
  release(): void;
}

export interface PoolOptions {
  /** Injected (not imported) so this module stays free of browser-only deps for node-env tests. */
  createSource: (d: StreamDescriptor) => StreamSource;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stallMs?: number;
  stallPollMs?: number;
  lingerMs?: number;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;
const STALL_MS = 12_000;
const STALL_POLL_MS = 3_000;
// Grace after refcount hits 0 before the session actually closes: StrictMode double-mounts effects
// in dev (mount→unmount→mount would otherwise renegotiate every session), and re-parenting a tile
// briefly drops to 0 refs. Re-acquire inside the linger cancels the close — no renegotiation.
const LINGER_MS = 3_000;

interface Entry {
  key: string;
  stream: DiscoveredStream | null; // last known discovery info (null = not discovered yet)
  refs: number;
  state: SessionState;
  error: string;
  source: StreamSource | null;
  mediaStream: MediaStream | null;
  backoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setInterval> | null;
  stallLastTime: number;
  stallLastAdvance: number;
  attachments: Set<VideoLike>;
  playingListeners: Map<VideoLike, () => void>;
  snapshot: SessionSnapshot | null; // cached (stable reference for useSyncExternalStore)
}

export class StreamSessionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly known = new Map<string, DiscoveredStream>(); // latest discovery, incl. unacquired keys
  private readonly createSource: (d: StreamDescriptor) => StreamSource;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly stallMs: number;
  private readonly stallPollMs: number;
  private readonly lingerMs: number;

  constructor(opts: PoolOptions) {
    this.createSource = opts.createSource;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.stallPollMs = opts.stallPollMs ?? STALL_POLL_MS;
    this.lingerMs = opts.lingerMs ?? LINGER_MS;
  }

  /** Discovery feed: refreshes descriptors and drives the liveliness flap per entry. */
  updateStreams(streams: DiscoveredStream[]): void {
    this.known.clear();
    for (const s of streams) this.known.set(s.key, s);
    for (const entry of this.entries.values()) {
      const next = this.known.get(entry.key) ?? null;
      const wasAlive = entry.stream?.alive ?? false;
      const isAlive = next?.alive ?? false;
      if (next) entry.stream = next; // fresh descriptor even while offline (post-restart ports)
      else if (entry.stream) entry.stream = { ...entry.stream, alive: false }; // removed post-grace
      if (isAlive && !wasAlive) {
        // Producer (re)appeared: resume immediately with fresh backoff.
        entry.backoffMs = this.retryBaseMs;
        this.clearRetry(entry);
        if (entry.refs > 0) this.attempt(entry);
        else this.emit(entry);
      } else if (!isAlive && wasAlive) {
        // Producer withdrew: the session is dead (signalling likely went with it) — don't churn.
        this.clearRetry(entry);
        this.closeSource(entry);
        this.setState(entry, "offline");
      } else {
        this.emit(entry); // descriptor refresh only
      }
    }
  }

  acquire(key: string): StreamHandle {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        stream: this.known.get(key) ?? null,
        refs: 0,
        state: "offline",
        error: "",
        source: null,
        mediaStream: null,
        backoffMs: this.retryBaseMs,
        retryTimer: null,
        lingerTimer: null,
        stallTimer: null,
        stallLastTime: -1,
        stallLastAdvance: 0,
        attachments: new Set(),
        playingListeners: new Map(),
        snapshot: null,
      };
      this.entries.set(key, entry);
    }
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    entry.refs += 1;
    if (entry.refs === 1 && entry.source === null && entry.retryTimer === null) this.attempt(entry);
    let released = false;
    const pool = this; // eslint-disable-line @typescript-eslint/no-this-alias
    return {
      key,
      attach: (video) => pool.attach(key, video),
      detach: (video) => pool.detach(key, video),
      release: () => {
        if (released) return; // a handle releases at most once
        released = true;
        pool.release(key);
      },
    };
  }

  getSnapshot(key: string): SessionSnapshot | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!entry.snapshot) {
      entry.snapshot = {
        key: entry.key,
        state: entry.state,
        error: entry.error,
        mediaStream: entry.mediaStream,
        attachCount: entry.attachments.size,
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

  // ---- internals -------------------------------------------------------------------------------

  private attach(key: string, video: VideoLike): void {
    const entry = this.entries.get(key);
    if (!entry || entry.attachments.has(video)) return;
    entry.attachments.add(video);
    const onPlaying = () => {
      // Frames are actually rendering — the "healthy" signal (backoff resets so future retries
      // start fast again). Any one attachment suffices: they all share the MediaStream.
      entry.backoffMs = this.retryBaseMs;
      if (entry.state !== "offline") this.setState(entry, "playing");
    };
    entry.playingListeners.set(video, onPlaying);
    video.addEventListener("playing", onPlaying);
    if (entry.mediaStream) {
      video.srcObject = entry.mediaStream;
      void video.play().catch(() => undefined);
    }
    this.emit(entry);
  }

  private detach(key: string, video: VideoLike): void {
    const entry = this.entries.get(key);
    if (!entry || !entry.attachments.has(video)) return;
    entry.attachments.delete(video);
    const listener = entry.playingListeners.get(video);
    if (listener) {
      video.removeEventListener("playing", listener);
      entry.playingListeners.delete(video);
    }
    video.srcObject = null; // release track references
    this.emit(entry);
  }

  private release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.lingerTimer = setTimeout(() => {
      entry.lingerTimer = null;
      if (entry.refs === 0) {
        this.teardown(entry);
        this.entries.delete(entry.key);
        this.notify(entry.key);
      }
    }, this.lingerMs);
  }

  private attempt(entry: Entry): void {
    if (entry.refs === 0) return;
    if (!entry.stream?.alive) {
      this.setState(entry, "offline"); // no point dialing a withdrawn producer; alive→true resumes
      return;
    }
    this.closeSource(entry);
    entry.error = "";
    if (entry.state !== "reconnecting") this.setState(entry, "opening");
    else this.emit(entry);
    const src = this.createSource(entry.stream.descriptor);
    entry.source = src;
    const current = () => entry.source === src; // stale-callback guard (close/retry races)
    src
      .open({
        onStream: (stream) => {
          if (!current()) return;
          entry.mediaStream = stream;
          for (const video of entry.attachments) {
            video.srcObject = stream;
            void video.play().catch(() => undefined);
          }
          if (entry.attachments.size === 0) this.watchUnmute(entry, stream, current);
          this.emit(entry);
        },
        onError: (m) => {
          if (current()) this.scheduleRetry(entry, m);
        },
        onClosed: () => {
          if (current()) this.scheduleRetry(entry, "session closed");
        },
      })
      .catch((e) => {
        if (current()) this.scheduleRetry(entry, String(e));
      });
  }

  /** Zero-attachment fallback health signal: first track unmute ≈ media flowing. */
  private watchUnmute(entry: Entry, stream: MediaStream, current: () => boolean): void {
    const tracks: MediaStreamTrack[] = stream.getTracks?.() ?? [];
    const healthy = () => {
      if (!current() || entry.mediaStream !== stream) return;
      entry.backoffMs = this.retryBaseMs;
      if (entry.state !== "offline") this.setState(entry, "playing");
    };
    for (const track of tracks) {
      if (!track.muted) return healthy();
      track.addEventListener("unmute", healthy, { once: true });
    }
  }

  private scheduleRetry(entry: Entry, reason: string): void {
    this.closeSource(entry);
    if (entry.refs === 0) return;
    if (entry.retryTimer !== null) return; // one pending retry at a time (error+closed both fire)
    if (!entry.stream?.alive) {
      this.setState(entry, "offline");
      return;
    }
    entry.error = reason;
    this.setState(entry, "reconnecting");
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.attempt(entry);
    }, entry.backoffMs);
    entry.backoffMs = Math.min(entry.backoffMs * 2, this.retryMaxMs);
  }

  // Stall watchdog (see STALL_MS): catches the session-death modes that emit no event at all — the
  // video just freezes at "playing".
  private startWatchdog(entry: Entry): void {
    if (entry.stallTimer !== null) return;
    entry.stallLastTime = -1;
    entry.stallLastAdvance = Date.now();
    entry.stallTimer = setInterval(() => {
      const video = [...entry.attachments].find((v) => !v.paused);
      if (!video) {
        // Nothing to sample (hidden/paused everywhere) — idle rather than false-positive.
        entry.stallLastAdvance = Date.now();
        return;
      }
      if (video.currentTime !== entry.stallLastTime) {
        entry.stallLastTime = video.currentTime;
        entry.stallLastAdvance = Date.now();
      } else if (Date.now() - entry.stallLastAdvance > this.stallMs) {
        console.warn("[stream-pool] video stalled — reconnecting", entry.key);
        this.scheduleRetry(entry, "video stalled");
      }
    }, this.stallPollMs);
  }

  private stopWatchdog(entry: Entry): void {
    if (entry.stallTimer !== null) {
      clearInterval(entry.stallTimer);
      entry.stallTimer = null;
    }
  }

  private setState(entry: Entry, state: SessionState): void {
    entry.state = state;
    if (state === "playing") this.startWatchdog(entry);
    else this.stopWatchdog(entry);
    this.emit(entry);
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
  }

  private closeSource(entry: Entry): void {
    entry.source?.close();
    entry.source = null;
    entry.mediaStream = null;
  }

  private teardown(entry: Entry): void {
    this.clearRetry(entry);
    this.stopWatchdog(entry);
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    for (const [video, listener] of entry.playingListeners) {
      video.removeEventListener("playing", listener);
      video.srcObject = null;
    }
    entry.playingListeners.clear();
    entry.attachments.clear();
    this.closeSource(entry);
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
