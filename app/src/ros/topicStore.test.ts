import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicStore, type TopicKeyInfo } from "./topicStore";
import type { GetReply, Sample, Subscription, Transport } from "../transport/types";
import type { Decoder, SchemaResolver, TypeIdentity } from "../schema/types";

// ---- fakes ------------------------------------------------------------------------------------

class FakeTransport implements Transport {
  subs: { keyexpr: string; onSample: (s: Sample) => void; closed: boolean }[] = [];
  getCalls: string[] = [];
  getReplies: GetReply[] = [];
  deferSubscribe = false;
  failSubscribe = false;
  private pendingSubs: (() => void)[] = [];

  subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription> {
    if (this.failSubscribe) return Promise.reject(new Error("bridge down"));
    const rec = { keyexpr, onSample, closed: false };
    this.subs.push(rec);
    const sub: Subscription = { close: () => ((rec.closed = true), Promise.resolve()) };
    if (!this.deferSubscribe) return Promise.resolve(sub);
    return new Promise((resolve) => this.pendingSubs.push(() => resolve(sub)));
  }

  resolvePendingSubs(): void {
    for (const r of this.pendingSubs.splice(0)) r();
  }

  get(keyexpr: string): Promise<GetReply[]> {
    this.getCalls.push(keyexpr);
    return Promise.resolve(this.getReplies);
  }

  readonly liveliness = {
    subscribe: () => Promise.resolve({ close: () => Promise.resolve() }),
    get: () => Promise.resolve([] as string[]),
  };

  close(): Promise<void> {
    return Promise.resolve();
  }

  push(payload: Uint8Array): void {
    for (const s of this.subs) if (!s.closed) s.onSample({ keyexpr: s.keyexpr, payload, kind: "put" });
  }
}

class FakeResolver implements SchemaResolver {
  resolveCalls: TypeIdentity[] = [];
  decodeCalls = 0;
  failWith: string | null = null;
  warning: string | undefined;
  private readonly decoder: Decoder = {
    decode: (bytes) => {
      this.decodeCalls += 1;
      return { n: bytes[0] };
    },
    lastWarning: () => this.warning,
  };

  resolve(id: TypeIdentity): Promise<Decoder> {
    this.resolveCalls.push(id);
    if (this.failWith !== null) return Promise.reject(new Error(this.failWith));
    return Promise.resolve(this.decoder);
  }
}

const INFO: TopicKeyInfo = {
  dataKeyexpr: "0/battery_state/sensor_msgs::msg::dds_::BatteryState_/RIHS01_aa",
  typeName: "sensor_msgs/msg/BatteryState",
  typeHash: "RIHS01_aa",
  transientLocal: false,
};
const KEY = INFO.dataKeyexpr;

// ---- spec -------------------------------------------------------------------------------------

describe("TopicStore", () => {
  let transport: FakeTransport;
  let resolver: FakeResolver;
  let store: TopicStore;
  let t: number;
  const tick = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    transport = new FakeTransport();
    resolver = new FakeResolver();
    store = new TopicStore({ transport, resolver, now: () => t });
  });

  afterEach(() => {
    store.closeAll();
    vi.useRealTimers();
  });

  it("dedups: two acquires → one subscribe, one resolve", async () => {
    store.acquire(INFO);
    store.acquire(INFO);
    await tick(0);
    expect(transport.subs).toHaveLength(1);
    expect(resolver.resolveCalls).toHaveLength(1);
  });

  it("decodes at most once per flush and shares the message", async () => {
    const events: number[] = [];
    store.subscribe(KEY, () => events.push(1));
    store.acquire(INFO);
    await tick(0);
    transport.push(new Uint8Array([1]));
    transport.push(new Uint8Array([2]));
    transport.push(new Uint8Array([3]));
    expect(resolver.decodeCalls).toBe(0); // nothing until the flush
    await tick(200);
    expect(resolver.decodeCalls).toBe(1);
    expect(store.getSnapshot(KEY)?.message).toEqual({ n: 3 }); // latest payload wins
    expect(store.getSnapshot(KEY)?.lastBytes).toBe(1);
    expect(events.length).toBe(1); // one notification for the whole burst
  });

  it("subscribes FIRST — decoder resolution failure never blocks rate", async () => {
    resolver.failWith = "not in the bundled message definitions";
    store.acquire(INFO);
    await tick(0);
    expect(transport.subs).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      transport.push(new Uint8Array([i]));
      await tick(200);
    }
    const snap = store.getSnapshot(KEY);
    expect(snap?.error).toMatch(/no decoder:/);
    expect(snap?.hz).toBeGreaterThan(3); // ~5 Hz measured over the elapsed span
    expect(snap?.lastBytes).toBe(1); // bytes still tracked without a decoder
  });

  it("decode: false consumers never trigger resolution; a decoding joiner does", async () => {
    store.acquire(INFO, { decode: false });
    await tick(0);
    transport.push(new Uint8Array([7]));
    await tick(200);
    expect(resolver.resolveCalls).toHaveLength(0);
    expect(store.getSnapshot(KEY)?.lastBytes).toBe(1);
    expect(store.getSnapshot(KEY)?.message).toBeUndefined();
    store.acquire(INFO); // decoding consumer joins late
    await tick(0);
    expect(resolver.resolveCalls).toHaveLength(1);
    transport.push(new Uint8Array([8]));
    await tick(200);
    expect(store.getSnapshot(KEY)?.message).toEqual({ n: 8 });
  });

  it("hz decays to undefined when publishing stops", async () => {
    store.acquire(INFO);
    await tick(0);
    for (let i = 0; i < 10; i++) {
      transport.push(new Uint8Array([1]));
      await tick(100);
    }
    expect(store.getSnapshot(KEY)?.hz).toBeGreaterThan(8); // ~10 Hz over the elapsed span
    await tick(6000); // window (5 s) fully drains
    expect(store.getSnapshot(KEY)?.hz).toBeUndefined();
  });

  it("coalesces hz windows to the max across handles", async () => {
    store.acquire(INFO, { windowMs: 5000, decode: false });
    const wide = store.acquire(INFO, { windowMs: 30_000, decode: false });
    await tick(0);
    transport.push(new Uint8Array([1]));
    transport.push(new Uint8Array([1]));
    await tick(10_000); // past 5 s but inside 30 s
    expect(store.getSnapshot(KEY)?.hz).not.toBeUndefined();
    wide.release();
    await tick(1000); // linger — the remaining 5 s handle shrinks the window
    await tick(200);
    expect(store.getSnapshot(KEY)?.hz).toBeUndefined();
  });

  it("lingers through release→re-acquire (StrictMode) without resubscribing", async () => {
    const h1 = store.acquire({ ...INFO, transientLocal: true });
    transport.getReplies = [{ keyexpr: KEY, payload: new Uint8Array([9]) }];
    h1.release();
    const h2 = store.acquire({ ...INFO, transientLocal: true });
    await tick(60_000);
    expect(transport.subs).toHaveLength(1);
    expect(transport.subs[0].closed).toBe(false);
    expect(transport.getCalls).toHaveLength(1); // transient-local seed fired once, not twice
    h2.release();
    await tick(1000);
    expect(transport.subs[0].closed).toBe(true);
    expect(store.getSnapshot(KEY)).toBeNull();
  });

  it("a handle releases at most once", async () => {
    const h1 = store.acquire(INFO);
    store.acquire(INFO);
    h1.release();
    h1.release();
    await tick(60_000);
    expect(transport.subs[0].closed).toBe(false); // second handle still holds the entry
  });

  it("transient-local: seeds latched once; a live sample beats the seed", async () => {
    const seeded = { ...INFO, transientLocal: true };
    transport.getReplies = [{ keyexpr: KEY, payload: new Uint8Array([5]) }];
    store.acquire(seeded);
    await tick(200);
    expect(store.getSnapshot(KEY)?.latched).toBe(true);
    expect(store.getSnapshot(KEY)?.message).toEqual({ n: 5 });
    // live samples flip latched off
    transport.push(new Uint8Array([6]));
    await tick(200);
    expect(store.getSnapshot(KEY)?.latched).toBe(false);
  });

  it("decode errors set error and clear on the next good sample", async () => {
    resolver.warning = undefined;
    store.acquire(INFO);
    await tick(0);
    const decoder = await resolver.resolve({ flavor: "ros2", typeName: "x", rihsHash: "y" });
    // sabotage: make decode throw once
    const original = decoder.decode.bind(decoder);
    let boom = true;
    decoder.decode = (b) => {
      if (boom) {
        boom = false;
        throw new Error("truncated CDR");
      }
      return original(b);
    };
    transport.push(new Uint8Array([1]));
    await tick(200);
    expect(store.getSnapshot(KEY)?.error).toMatch(/decode failed: truncated CDR/);
    transport.push(new Uint8Array([2]));
    await tick(200);
    expect(store.getSnapshot(KEY)?.error).toBeUndefined();
    expect(store.getSnapshot(KEY)?.message).toEqual({ n: 2 });
  });

  it("a Subscription resolving after teardown is closed immediately", async () => {
    transport.deferSubscribe = true;
    const h = store.acquire(INFO);
    h.release();
    await tick(1000); // linger elapses, entry torn down while subscribe still pending
    transport.resolvePendingSubs();
    await tick(0);
    expect(transport.subs[0].closed).toBe(true);
  });

  it("subscribe rejection surfaces as an error snapshot", async () => {
    transport.failSubscribe = true;
    store.acquire(INFO);
    await tick(0);
    expect(store.getSnapshot(KEY)?.error).toMatch(/subscribe failed: bridge down/);
  });

  it("closeAll closes every sub and clears every timer", async () => {
    store.acquire(INFO);
    store.acquire({ ...INFO, dataKeyexpr: "0/other/std_msgs::msg::dds_::String_/RIHS01_bb" });
    await tick(0);
    store.closeAll();
    expect(transport.subs.every((s) => s.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
