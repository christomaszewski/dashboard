import type { Sample, Subscription, Transport } from "../transport/types";
import type { TopicEntry } from "./graph";

interface Entry {
  listeners: Set<(sample: Sample) => void>;
  ready: Promise<Subscription>;
  closed: boolean;
  sub?: Subscription;
  announcement?: Promise<Subscription>;
}

/** Raw fan-out. Consumers choose their own decode/retention policy; no samples coalesce here. */
export class TopicStreamPool {
  private entries = new Map<string, Entry>();
  constructor(private transport: Transport) {}

  async subscribe(key: string, listener: (sample: Sample) => void, topic?: TopicEntry): Promise<Subscription> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { listeners: new Set([listener]), ready: null!, closed: false };
      this.entries.set(key, entry);
      const current = entry;
      current.ready = this.transport.subscribe(key, (sample) => {
        if (current.closed) return;
        for (const cb of [...current.listeners]) {
          try { cb(sample); } catch (error) { console.error("ROS topic consumer failed", error); }
        }
      });
    } else entry.listeners.add(listener);
    const current = entry;
    try {
      current.sub = await current.ready;
      if (!current.closed && topic && this.transport.declareRosSubscriber && !current.announcement) {
        current.announcement = this.transport.declareRosSubscriber({ ...topic,
          bufferAware: topic.publishers.some((p) => p.keyexpr.includes("/backends:")) });
      }
      await current.announcement;
    } catch (error) {
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.closed = true;
        void current.sub?.close();
        if (this.entries.get(key) === current) this.entries.delete(key);
      }
      throw error;
    }
    let released = false;
    return {
      close: async () => {
        if (released) return;
        released = true;
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && !current.closed) {
          current.closed = true;
          if (this.entries.get(key) === current) this.entries.delete(key);
          void current.announcement?.then((token) => token.close()).catch(() => undefined);
          if (current.sub) await current.sub.close();
          else await (await current.ready).close();
        }
      },
    };
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.closed = true;
      entry.listeners.clear();
      void entry.ready.then((sub) => sub.close()).catch(() => undefined);
      void entry.announcement?.then((token) => token.close()).catch(() => undefined);
    }
    this.entries.clear();
  }
}

const pools = new WeakMap<Transport, TopicStreamPool>();
export function topicStreams(transport: Transport): TopicStreamPool {
  let pool = pools.get(transport);
  if (!pool) { pool = new TopicStreamPool(transport); pools.set(transport, pool); }
  return pool;
}
