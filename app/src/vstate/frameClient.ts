// The browser side of vehicle frames (frames.ts): one request in flight per image widget, paced to
// max_hz, and sized to the link — when frames take too long to cross, the next ones are smaller and
// more compressed; when they cross quickly for a while, quality steps back up. The vehicle holds a
// request until it has a frame newer than the one shown, so an idle camera costs a heartbeat.
import { TransportError } from "../transport/reconnecting";
import type { Transport } from "../transport/types";
import { FRAME_LIMITS, decodeFrameReply, type FrameFormat, type FrameHeader } from "./frames";
import { VSTATE_VERSION, stateKeys } from "./protocol";

export interface FrameOptions {
  maxHz: number;
  maxWidth: number;
  quality: number;
  format: FrameFormat;
  normalize: boolean;
  /** Shrink and compress harder on a slow link (default true). */
  adaptive?: boolean;
}

export interface FrameUpdate {
  header?: FrameHeader;
  /** A new encoded frame (with header.mime). Absent = keep showing the last one. */
  image?: Uint8Array;
  /** The vehicle or the request failed; the last frame stays up. */
  error?: string;
  /** The link is down (reconnecting); the last frame stays up, no error. */
  link?: string;
  /** 0 = full size/quality; higher = smaller frames for a slow link. */
  level: number;
  /** ms the last frame took to cross (round trip minus the vehicle's hold). */
  linkMs?: number;
}

/** Size and quality steps for a slow link. */
export const LEVELS = [
  { scale: 1, qualityDrop: 0 },
  { scale: 0.75, qualityDrop: 10 },
  { scale: 0.5, qualityDrop: 20 },
  { scale: 0.35, qualityDrop: 25 },
  { scale: 0.25, qualityDrop: 30 },
] as const;
const HOLD_MS = 2000;
const FAST_FRAMES_TO_STEP_UP = 5;
const OUTAGE_GRACE_MS = 3000; // as the state client: brief gaps keep the last frame up, quietly

export class FrameFetcher {
  private stopped = false;
  private since = 0;
  private epoch = "";
  private level = 0;
  private fast = 0;
  private wake: (() => void) | null = null;
  /** When the current run of unanswered requests began: errors show only after OUTAGE_GRACE_MS. */
  private unansweredSince: number | null = null;
  private readonly key: string;
  private readonly now: () => number;

  constructor(private readonly opts: {
    transport: Transport;
    base: string;
    topic: string;
    options: FrameOptions;
    onUpdate: (u: FrameUpdate) => void;
    now?: () => number;
  }) {
    this.key = stateKeys(opts.base).frame;
    this.now = opts.now ?? (() => performance.now());
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** The request for the current level (exported for tests and the widget's detail line). */
  request(): { v: 1; topic: string; since: number; epoch: string; max_width: number; quality: number; format: FrameFormat; normalize: boolean } {
    const o = this.opts.options;
    const step = LEVELS[this.level];
    return {
      v: VSTATE_VERSION,
      topic: this.opts.topic,
      since: this.since,
      epoch: this.epoch,
      max_width: Math.max(FRAME_LIMITS.minWidth, Math.round(o.maxWidth * step.scale)),
      quality: Math.max(Math.min(o.quality, 25), o.quality - step.qualityDrop),
      format: o.format,
      normalize: o.normalize,
    };
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      const interval = 1000 / Math.max(0.1, this.opts.options.maxHz);
      const started = this.now();
      try {
        let replyError = "";
        const replies = await this.opts.transport.get(this.key, {
          payload: new TextEncoder().encode(JSON.stringify(this.request())),
          timeoutMs: HOLD_MS + 6000,
          maxReplyBytes: FRAME_LIMITS.replyBytes + 64 * 1024,
          onReplyError: (m) => (replyError = m),
        });
        if (this.stopped) return;
        if (replies.length > 1) throw new Error(`more than one vehicle answers ${this.key} — give each vehicle a distinct vehicle_id`);
        if (replies.length === 0) throw new Error(replyError ? `vehicle frames: ${replyError}` : `vehicle state service not reachable (${this.key})`);
        const { header, image } = decodeFrameReply(replies[0].payload);
        this.unansweredSince = null;
        const elapsed = this.now() - started;
        const linkMs = Math.max(0, elapsed - (header.held ?? 0));
        this.epoch = header.epoch;
        if (image) {
          this.since = header.seq;
          this.adapt(linkMs, interval);
        }
        this.opts.onUpdate({ header, image, error: header.e, level: this.level, linkMs: image ? linkMs : undefined });
        backoff = 1000;
        await this.sleep(Math.max(0, interval - elapsed));
      } catch (e) {
        if (this.stopped) return;
        const link = e instanceof TransportError;
        const message = e instanceof Error ? e.message : String(e);
        let grace = false;
        if (!link) {
          const now = Date.now();
          this.unansweredSince ??= now;
          grace = now - this.unansweredSince < OUTAGE_GRACE_MS;
        }
        if (link) this.opts.onUpdate({ link: message, level: this.level });
        else if (!grace) this.opts.onUpdate({ error: message, level: this.level });
        const quick = (link && e.code === "disconnected") || grace;
        await this.sleep(quick ? 500 : backoff);
        if (!quick) backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  /** A frame should cross within one interval (at least 0.4 s): slower = smaller, steadily faster = bigger. */
  private adapt(linkMs: number, interval: number): void {
    if (this.opts.options.adaptive === false) return;
    const budget = Math.max(interval, 400);
    if (linkMs > 1.5 * budget) {
      this.fast = 0;
      if (this.level < LEVELS.length - 1) this.level += 1;
    } else if (linkMs < 0.5 * budget) {
      this.fast += 1;
      if (this.fast >= FAST_FRAMES_TO_STEP_UP && this.level > 0) {
        this.level -= 1;
        this.fast = 0;
      }
    } else this.fast = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
