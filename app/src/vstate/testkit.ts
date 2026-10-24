// Shared fakes for the vehicle-state tests (not shipped: nothing in the app imports this).
import type { TopicEntry } from "../ros/graph";
import type { TopicAcquireOptions, TopicSnapshot } from "../ros/topicStore";
import { TransportError } from "../transport/reconnecting";
import type { GetReply, Subscription, Transport, TransportGetOptions } from "../transport/types";
import { serveQuery, type TopicSource, type VehicleStateServer } from "./server";

/** A TopicStore stand-in: tests set snapshots and fire the store's change notifications. */
export class FakeStore implements TopicSource {
  acquired: { key: string; opts?: TopicAcquireOptions; released: boolean }[] = [];
  snaps = new Map<string, TopicSnapshot>();
  listeners = new Map<string, Set<() => void>>();

  acquire(info: TopicEntry, opts?: TopicAcquireOptions) {
    const rec = { key: info.dataKeyexpr, opts, released: false };
    this.acquired.push(rec);
    return { key: rec.key, release: () => void (rec.released = true) };
  }
  subscribe(key: string, cb: () => void) {
    const set = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, set);
    set.add(cb);
    return () => void set.delete(cb);
  }
  getSnapshot(key: string) {
    return this.snaps.get(key) ?? null;
  }
  emit(key: string, snap: Partial<TopicSnapshot>) {
    this.snaps.set(key, { key, ...snap });
    for (const cb of this.listeners.get(key) ?? []) cb();
  }
  live(key: string) {
    return this.acquired.filter((a) => a.key === key && !a.released).length;
  }
}

/** A Transport whose queries are answered in-process by a VehicleStateServer. */
export class LoopbackTransport implements Transport {
  server: VehicleStateServer | null;
  /** Refuse every call like a reconnecting transport mid-outage. */
  down = false;
  calls: { op: "view" | "poll"; body: unknown }[] = [];
  bytes = 0;

  constructor(server: VehicleStateServer) {
    this.server = server;
  }

  async get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    if (this.down) throw new TransportError("disconnected", "link lost: test");
    const op = keyexpr.endsWith("/view") ? "view" : "poll";
    this.calls.push({ op, body: JSON.parse(new TextDecoder().decode(opts?.payload)) });
    if (!this.server) return []; // nothing answers on that key
    const replies: GetReply[] = [];
    await serveQuery(this.server, op, {
      keyexpr,
      payload: opts?.payload,
      reply: async (payload) => void replies.push({ keyexpr, payload }),
      replyErr: async (message) => opts?.onReplyError?.(message),
    });
    for (const r of replies) this.bytes += r.payload.length;
    return replies;
  }

  subscribe(): Promise<Subscription> {
    throw new Error("vehicle-state clients never subscribe");
  }
  readonly liveliness = {
    subscribe: (): Promise<Subscription> => Promise.resolve({ close: () => Promise.resolve() }),
    get: () => Promise.resolve([] as string[]),
  };
  close(): Promise<void> {
    return Promise.resolve();
  }
}
