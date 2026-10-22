import { decodeAttachment } from "../services/attachment";
import type { Sample } from "../transport/types";

const WINDOW_MS = 5000;
const BUCKET_MS = 100;
const MAX_PUBLISHERS = 256;

export interface TrafficStats {
  count: number;
  bytes: number;
  hz: number;
  bytesPerSecond: number;
}

export interface PublisherTraffic extends TrafficStats {
  /** Hex source GID, or a named bucket when attribution is unavailable. */
  id: string;
}

export interface TopicTrafficSnapshot extends TrafficStats {
  publishers: PublisherTraffic[];
}

class Counter {
  count = 0;
  bytes = 0;
  // Bounded by time, not message rate. No payloads or per-message history retained.
  private buckets = new Map<number, { count: number; bytes: number }>();

  record(now: number, bytes: number): void {
    this.count++;
    this.bytes += bytes;
    const slot = Math.floor(now / BUCKET_MS);
    this.prune(slot);
    const bucket = this.buckets.get(slot) ?? { count: 0, bytes: 0 };
    bucket.count++;
    bucket.bytes += bytes;
    this.buckets.set(slot, bucket);
  }

  snapshot(now: number, started: number): TrafficStats {
    this.prune(Math.floor(now / BUCKET_MS));
    let count = 0, bytes = 0;
    for (const bucket of this.buckets.values()) { count += bucket.count; bytes += bucket.bytes; }
    const seconds = Math.max(BUCKET_MS, Math.min(WINDOW_MS, now - started)) / 1000;
    return { count: this.count, bytes: this.bytes, hz: count / seconds, bytesPerSecond: bytes / seconds };
  }

  private prune(slot: number): void {
    for (const key of this.buckets.keys()) if (key <= slot - WINDOW_MS / BUCKET_MS) this.buckets.delete(key);
  }
}

/** Receiver-side serialized payload traffic. Cache-query replies do not pass through here. */
export class TopicTraffic {
  private total = new Counter();
  private publishers = new Map<string, Counter>();

  constructor(private started: number) {}

  record(sample: Sample, now: number): void {
    if (sample.kind !== "put") return;
    let id = "unattributed";
    if (sample.attachment) {
      try {
        id = Array.from(decodeAttachment(sample.attachment).gid, (b) => b.toString(16).padStart(2, "0")).join("");
      } catch { /* Missing or unsupported attachments must never be assigned to a guessed node. */ }
    }
    if (!this.publishers.has(id) && this.publishers.size >= MAX_PUBLISHERS) id = "overflow";
    const counter = this.publishers.get(id) ?? new Counter();
    counter.record(now, sample.payload.byteLength);
    this.publishers.set(id, counter);
    this.total.record(now, sample.payload.byteLength);
  }

  snapshot(now: number): TopicTrafficSnapshot {
    return { ...this.total.snapshot(now, this.started), publishers: [...this.publishers].map(([id, counter]) =>
      ({ id, ...counter.snapshot(now, this.started) })) };
  }
}
