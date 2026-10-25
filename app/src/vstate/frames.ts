// Vehicle-side image frames (docs/VEHICLE_STATE.md, "Images"). An image widget asks the vehicle for
// the latest frame of a topic, downscaled and compressed for the link; the vehicle keeps only the
// newest sample per topic, decodes it only when someone asks, and encodes each frame once per
// size/quality however many operators watch. Pull, one request in flight per widget: on a slow link
// frames get rarer, never queued. Frames ride their own key, so a large reply never delays the
// small state polls on the vehicle side.
//
// Wire: `get B/frame` with a JSON request; the reply is binary — u32 LE header length, the JSON
// header, then the encoded image (absent when nothing newer than `since` arrived within the hold).
import type { RosGraph, TopicEntry } from "../ros/graph";
import type { TopicAcquireOptions, TopicHandle, TopicSnapshot } from "../ros/topicStore";
import type { Decoder, SchemaResolver } from "../schema/types";
import type { IncomingQuery } from "../transport/types";
import { imagePixels } from "../rosimage/pixels";
import { isRosTopicName, VSTATE_VERSION } from "./protocol";

export const IMAGE_TYPES = ["sensor_msgs/msg/Image", "sensor_msgs/msg/CompressedImage"] as const;

export const FRAME_LIMITS = {
  minWidth: 32,
  maxWidth: 1920,
  replyBytes: 2 * 1024 * 1024,
  topics: 16, // topics with live frame subscriptions on one vehicle
  maxPixels: 8 * 1024 * 1024, // source images converted on the vehicle
  maxBytes: 64 * 1024 * 1024,
} as const;

export type FrameFormat = "jpeg" | "webp";

export interface FrameRequest {
  v: typeof VSTATE_VERSION;
  topic: string;
  /** The frame number the caller already shows (with `epoch`): reply only with a newer one. */
  since?: number;
  epoch?: string;
  max_width?: number;
  quality?: number;
  format?: FrameFormat;
  /** Stretch single-channel images to their own min..max (depth, range, intensity). */
  normalize?: boolean;
}

export interface FrameHeader {
  v: typeof VSTATE_VERSION;
  epoch: string;
  /** Frame number on this vehicle (0 = none yet). Equal to the request's `since` = nothing newer. */
  seq: number;
  /** Type name; absent = the topic is not advertised as an image on the vehicle. */
  t?: string;
  d?: number;
  /** The encoded frame: size, media type. */
  w?: number;
  h?: number;
  mime?: string;
  /** The source image: size and encoding (or compressed format). */
  sw?: number;
  sh?: number;
  enc?: string;
  /** ms between the frame's arrival on the vehicle and this reply. */
  age?: number;
  /** ms the vehicle held the request waiting for a newer frame (not link time). */
  held?: number;
  /** header.stamp of the frame, ms since the epoch. */
  stamp?: number;
  /** Frames per second arriving on the vehicle (after its ingest cap). */
  hz?: number;
  s?: 1; // stale: no new frame for longer than usual
  e?: string; // error
}

/** What the encoder gets: raw pixels it can take as they are, or a compressed image to re-encode. */
export type FrameSource =
  | { kind: "raw"; width: number; height: number; channels: 1 | 3 | 4; bgr: boolean; data: Uint8Array; encoding: string }
  | { kind: "compressed"; format: string; data: Uint8Array };

export interface EncodedFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: string;
  /** Source size, when only the encoder learns it (compressed sources). */
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface FrameEncoder {
  encode(source: FrameSource, opts: { maxWidth: number; quality: number; format: FrameFormat }): Promise<EncodedFrame>;
}

// ---- requests and replies ------------------------------------------------------------------------

const int = (v: unknown, lo: number, hi: number, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`frame.${name} must be an integer in ${lo}..${hi}`);
  return v;
};

export function validateFrameRequest(raw: unknown): Required<Pick<FrameRequest, "topic" | "max_width" | "quality" | "format" | "normalize">> & Pick<FrameRequest, "since" | "epoch"> {
  if (typeof raw !== "object" || raw === null) throw new Error("frame request must be an object");
  const r = raw as Record<string, unknown>;
  if (r.v !== VSTATE_VERSION) throw new Error(`frame request version must be ${VSTATE_VERSION}`);
  if (typeof r.topic !== "string" || !isRosTopicName(r.topic)) throw new Error("frame.topic must be an absolute ROS topic name");
  const since = int(r.since, 0, Number.MAX_SAFE_INTEGER, "since");
  if (r.epoch !== undefined && (typeof r.epoch !== "string" || r.epoch.length > 32)) throw new Error("frame.epoch must be a short string");
  if (r.format !== undefined && r.format !== "jpeg" && r.format !== "webp") throw new Error("frame.format must be jpeg or webp");
  if (r.normalize !== undefined && typeof r.normalize !== "boolean") throw new Error("frame.normalize must be a boolean");
  return {
    topic: r.topic,
    since,
    epoch: r.epoch as string | undefined,
    max_width: int(r.max_width, FRAME_LIMITS.minWidth, FRAME_LIMITS.maxWidth, "max_width") ?? 640,
    quality: int(r.quality, 10, 95, "quality") ?? 60,
    format: (r.format as FrameFormat | undefined) ?? "jpeg",
    normalize: (r.normalize as boolean | undefined) ?? true,
  };
}

export function encodeFrameReply(header: FrameHeader, image?: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + (image?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  if (image) out.set(image, 4 + json.length);
  return out;
}

export function decodeFrameReply(buf: Uint8Array): { header: FrameHeader; image?: Uint8Array } {
  if (buf.length < 4) throw new Error("frame reply too short");
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
  if (4 + n > buf.length) throw new Error("frame reply header truncated");
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n))) as FrameHeader;
  const image = buf.length > 4 + n ? buf.subarray(4 + n) : undefined;
  return { header, image };
}

/** A decoded sensor_msgs Image / CompressedImage → what the encoder takes. */
export function frameSource(message: Record<string, unknown>, normalize: boolean): FrameSource {
  if (typeof message.format === "string" && message.data instanceof Uint8Array) {
    if (/compressedDepth/i.test(message.format)) throw new Error(`unsupported compressed format: ${message.format}`);
    return { kind: "compressed", format: message.format, data: message.data };
  }
  const { width, height, step, encoding, data } = message;
  // Fast path: 8-bit layouts the encoder takes as they are (bgr swapped by the encoder).
  const fast: Record<string, 1 | 3> = { mono8: 1, "8UC1": 1, rgb8: 3, bgr8: 3 };
  const channels = typeof encoding === "string" ? fast[encoding] : undefined;
  if (channels && typeof width === "number" && typeof height === "number" && width > 0 && height > 0 &&
    width * height <= FRAME_LIMITS.maxPixels && typeof step === "number" && data instanceof Uint8Array &&
    step >= width * channels && data.byteLength >= step * height) {
    const row = width * channels;
    let pixels = data.subarray(0, row * height);
    if (step !== row) { // drop row padding
      pixels = new Uint8Array(row * height);
      for (let y = 0; y < height; y++) pixels.set(data.subarray(y * step, y * step + row), y * row);
    }
    return { kind: "raw", width, height, channels, bgr: encoding === "bgr8", data: pixels, encoding: encoding as string };
  }
  // Everything else the browser view supports (16-bit, 4-channel) through the shared converter.
  const px = imagePixels(message, normalize, { maxPixels: FRAME_LIMITS.maxPixels, maxBytes: FRAME_LIMITS.maxBytes });
  return { kind: "raw", width: px.width, height: px.height, channels: 4, bgr: false, data: new Uint8Array(px.rgba.buffer, px.rgba.byteOffset, px.rgba.byteLength), encoding: px.encoding };
}

// ---- the server ----------------------------------------------------------------------------------

/** The slice of TopicStore frames need (a fake in tests). */
export interface FrameStore {
  acquire(info: TopicEntry, opts?: TopicAcquireOptions): TopicHandle;
  subscribe(key: string, cb: () => void): () => void;
  getSnapshot(key: string): TopicSnapshot | null;
}

export interface FrameServerOptions {
  store: FrameStore;
  resolver: SchemaResolver;
  encoder: FrameEncoder;
  epoch: string;
  now?: () => number;
  holdMs?: number;
  /** Drop a topic's subscription nobody has asked for in this long. */
  ttlMs?: number;
  staleMs?: number;
}

interface FrameTopic {
  topic: string;
  entry?: TopicEntry;
  handle?: TopicHandle;
  unlisten?: () => void;
  decoder?: Promise<Decoder>;
  seq: number;
  raw?: Uint8Array;
  arrivedAt?: number;
  interval?: number;
  lastRequested: number;
  /** Encodings of the current frame, by size/quality/format/normalize. */
  encoded: Map<string, Promise<EncodedFrame & { stamp?: number; sw?: number; sh?: number; enc?: string }>>;
  waiters: Set<() => void>;
}

export class FrameServer {
  private readonly store: FrameStore;
  private readonly resolver: SchemaResolver;
  private readonly encoder: FrameEncoder;
  readonly epoch: string;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private graph: RosGraph | null = null;
  private readonly topics = new Map<string, FrameTopic>();
  private counts = { requests: 0, frames: 0, encodes: 0, bytes: 0 };

  constructor(opts: FrameServerOptions) {
    this.store = opts.store;
    this.resolver = opts.resolver;
    this.encoder = opts.encoder;
    this.epoch = opts.epoch;
    this.now = opts.now ?? (() => performance.now());
    this.holdMs = opts.holdMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.staleMs = opts.staleMs ?? 5000;
  }

  setGraph(graph: RosGraph): void {
    this.graph = graph;
    for (const rec of this.topics.values()) this.bind(rec);
  }

  stats() {
    return { topics: this.topics.size, ...this.counts };
  }

  async request(raw: unknown): Promise<{ header: FrameHeader; image?: Uint8Array }> {
    const req = validateFrameRequest(raw);
    this.counts.requests += 1;
    const rec = this.retain(req.topic);
    rec.lastRequested = this.now();
    const base = (): FrameHeader => ({
      v: VSTATE_VERSION, epoch: this.epoch, seq: rec.seq,
      ...(rec.entry ? { t: rec.entry.typeName, d: rec.entry.domainId } : {}),
      ...(this.isStale(rec) ? { s: 1 as const } : {}),
      ...(rec.entry ? { hz: this.store.getSnapshot(rec.entry.dataKeyexpr)?.hz } : {}),
    });
    if (!rec.entry) return { header: base() };
    const known = req.epoch === this.epoch ? req.since ?? 0 : 0;
    let held = 0;
    if (rec.seq === 0 || rec.seq === known) {
      const t0 = this.now();
      await this.waitForFrame(rec, known);
      held = Math.round(this.now() - t0);
      rec.lastRequested = this.now();
      if (rec.seq === 0 || rec.seq === known) return { header: { ...base(), held } };
    }
    const seq = rec.seq;
    const key = `${req.max_width}|${req.quality}|${req.format}|${req.normalize}`;
    let pending = rec.encoded.get(key);
    if (!pending) {
      pending = this.encode(rec, req);
      pending.catch(() => undefined);
      rec.encoded.set(key, pending);
    }
    try {
      const frame = await pending;
      if (frame.bytes.length > FRAME_LIMITS.replyBytes) {
        return { header: { ...base(), seq, held, e: `frame too large (${frame.bytes.length} B > ${FRAME_LIMITS.replyBytes} B) — lower max_width or quality` } };
      }
      this.counts.frames += 1;
      this.counts.bytes += frame.bytes.length;
      return {
        header: {
          ...base(), seq, held, w: frame.width, h: frame.height, mime: frame.mime,
          sw: frame.sw, sh: frame.sh, enc: frame.enc, stamp: frame.stamp,
          age: rec.arrivedAt === undefined ? undefined : Math.max(0, Math.round(this.now() - rec.arrivedAt)),
        },
        image: frame.bytes,
      };
    } catch (e) {
      return { header: { ...base(), seq, held, e: `frame: ${e instanceof Error ? e.message : String(e)}` } };
    }
  }

  /** Expire topics nobody watches; wake nobody (holds time out on their own). */
  tick(): void {
    const now = this.now();
    for (const rec of [...this.topics.values()]) {
      if (rec.waiters.size === 0 && now - rec.lastRequested > this.ttlMs) this.drop(rec);
    }
  }

  close(): void {
    for (const rec of [...this.topics.values()]) this.drop(rec);
  }

  // ---- topics --------------------------------------------------------------------------------

  private retain(topic: string): FrameTopic {
    let rec = this.topics.get(topic);
    if (rec) return rec;
    if (this.topics.size >= FRAME_LIMITS.topics) {
      const oldest = [...this.topics.values()].sort((a, b) => a.lastRequested - b.lastRequested)[0];
      this.drop(oldest);
    }
    rec = { topic, seq: 0, lastRequested: this.now(), encoded: new Map(), waiters: new Set() };
    this.topics.set(topic, rec);
    this.bind(rec);
    return rec;
  }

  private bind(rec: FrameTopic): void {
    const entry = this.graph?.topics.find((t) => t.name === rec.topic && (IMAGE_TYPES as readonly string[]).includes(t.typeName));
    if (entry?.dataKeyexpr === rec.entry?.dataKeyexpr) {
      if (entry) rec.entry = entry;
      return;
    }
    this.unbind(rec);
    if (!entry) return;
    rec.entry = entry;
    // Raw bytes only: decoding waits for a request, so an unwatched 1080p stream costs no decode.
    rec.handle = this.store.acquire(entry, { decode: false, raw: true });
    rec.decoder = undefined;
    rec.unlisten = this.store.subscribe(entry.dataKeyexpr, () => this.onSample(rec));
    this.onSample(rec); // a sample the store already holds (another consumer of the topic)
  }

  private unbind(rec: FrameTopic): void {
    rec.unlisten?.();
    rec.handle?.release();
    rec.entry = rec.handle = rec.unlisten = rec.decoder = undefined;
    rec.raw = rec.arrivedAt = rec.interval = undefined;
    rec.encoded.clear();
  }

  private drop(rec: FrameTopic): void {
    this.unbind(rec);
    this.topics.delete(rec.topic);
    for (const wake of [...rec.waiters]) wake();
  }

  private onSample(rec: FrameTopic): void {
    if (!rec.entry) return;
    const snap = this.store.getSnapshot(rec.entry.dataKeyexpr);
    if (!snap?.raw || snap.raw === rec.raw) return;
    const now = this.now();
    if (rec.arrivedAt !== undefined) rec.interval = now - rec.arrivedAt;
    rec.raw = snap.raw;
    rec.arrivedAt = now;
    rec.seq = Math.max(rec.seq + 1, 1);
    rec.encoded.clear();
    for (const wake of [...rec.waiters]) wake();
  }

  private isStale(rec: FrameTopic): boolean {
    if (rec.arrivedAt === undefined || rec.entry?.transientLocal) return false;
    return this.now() - rec.arrivedAt > Math.max(this.staleMs, 3 * (rec.interval ?? 0));
  }

  private waitForFrame(rec: FrameTopic, known: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        if (rec.seq !== known && rec.seq !== 0 || !this.topics.has(rec.topic)) finish();
      };
      const finish = () => {
        clearTimeout(timer);
        rec.waiters.delete(wake);
        resolve();
      };
      timer = setTimeout(finish, this.holdMs);
      rec.waiters.add(wake);
    });
  }

  private async encode(rec: FrameTopic, req: ReturnType<typeof validateFrameRequest>) {
    const entry = rec.entry!;
    const raw = rec.raw!;
    rec.decoder ??= this.resolver.resolve({ flavor: "ros2", typeName: entry.typeName, rihsHash: entry.typeHash });
    const message = (await rec.decoder).decode(raw);
    const source = frameSource(message, req.normalize);
    this.counts.encodes += 1;
    const frame = await this.encoder.encode(source, { maxWidth: req.max_width, quality: req.quality, format: req.format });
    const st = (message.header as { stamp?: { sec?: number; nanosec?: number } } | undefined)?.stamp;
    const stamp = st && typeof st.sec === "number" ? st.sec * 1000 + Math.round((st.nanosec ?? 0) / 1e6) : undefined;
    return {
      ...frame, stamp,
      sw: source.kind === "raw" ? source.width : frame.sourceWidth,
      sh: source.kind === "raw" ? source.height : frame.sourceHeight,
      enc: source.kind === "raw" ? source.encoding : source.format,
    };
  }
}

/** Answer one frame query. Bad requests get a reply error; the reply is binary (header + image). */
export async function serveFrameQuery(server: FrameServer, query: IncomingQuery): Promise<number> {
  try {
    if (query.payload && query.payload.length > 4096) throw new Error("frame request larger than 4096 bytes");
    const request = JSON.parse(new TextDecoder().decode(query.payload ?? new Uint8Array()));
    const { header, image } = await server.request(request);
    const bytes = encodeFrameReply(header, image);
    await query.reply(bytes);
    return bytes.length;
  } catch (e) {
    await query.replyErr(e instanceof Error ? e.message : String(e)).catch(() => undefined);
    return 0;
  }
}
