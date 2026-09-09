import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingTransport, TransportError, type LinkStatus } from "./reconnecting";
import type { GetReply, LivelinessEvent, Sample, Subscription, Transport } from "./types";

/** An inner transport under test control: subscriptions are recorded and can be fed; every get
 *  and liveliness get is a deferred the test resolves, rejects, or leaves hanging (a dead socket). */
class FakeInner implements Transport {
  subs: { keyexpr: string; handler: (s: Sample) => void; open: boolean }[] = [];
  live: { keyexpr: string; handler: (e: LivelinessEvent) => void; open: boolean }[] = [];
  pending: { keyexpr: string; resolve: (v: GetReply[] | string[]) => void; reject: (e: unknown) => void }[] = [];
  closed = false;
  constructor(readonly id: number) {}
  async subscribe(keyexpr: string, handler: (s: Sample) => void): Promise<Subscription> {
    const rec = { keyexpr, handler, open: true };
    this.subs.push(rec);
    return { close: async () => void (rec.open = false) };
  }
  private defer<T extends GetReply[] | string[]>(keyexpr: string): Promise<T> {
    return new Promise<T>((resolve, reject) => this.pending.push({ keyexpr, resolve: resolve as (v: GetReply[] | string[]) => void, reject }));
  }
  get(keyexpr: string): Promise<GetReply[]> {
    return this.defer<GetReply[]>(keyexpr);
  }
  readonly liveliness = {
    subscribe: async (keyexpr: string, handler: (e: LivelinessEvent) => void): Promise<Subscription> => {
      const rec = { keyexpr, handler, open: true };
      this.live.push(rec);
      return { close: async () => void (rec.open = false) };
    },
    get: (keyexpr: string): Promise<string[]> => this.defer<string[]>(keyexpr),
  };
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Answer every pending probe/query (a healthy link). */
  answerAll(): void {
    for (const p of this.pending.splice(0)) p.resolve([]);
  }
  probes(): number {
    return this.pending.filter((p) => p.keyexpr === "@dashboard/link-probe").length;
  }
  /** Answer the heartbeats only (a healthy link), leaving other queries pending. */
  answerProbes(): void {
    const hits = this.pending.filter((p) => p.keyexpr === "@dashboard/link-probe");
    this.pending = this.pending.filter((p) => p.keyexpr !== "@dashboard/link-probe");
    for (const p of hits) p.resolve([]);
  }
  /** Answer the pending liveliness queries for `keyexpr` with these live tokens. */
  answerLiveliness(keyexpr: string, keys: string[]): number {
    const hits = this.pending.filter((p) => p.keyexpr === keyexpr);
    this.pending = this.pending.filter((p) => p.keyexpr !== keyexpr);
    for (const p of hits) p.resolve(keys);
    return hits.length;
  }
}

function world(opts: { failFirst?: number } = {}) {
  const inners: FakeInner[] = [];
  let failures = opts.failFirst ?? 0;
  const statuses: LinkStatus[] = [];
  const t = new ReconnectingTransport({
    open: async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("ECONNREFUSED");
      }
      const inner = new FakeInner(inners.length + 1);
      inners.push(inner);
      return inner;
    },
    probeMs: 1000,
    probeTimeoutMs: 500,
    deadlineMarginMs: 100,
    defaultTimeoutMs: 1000,
    retryBaseMs: 200,
    retryMaxMs: 800,
    onStatus: (s) => statuses.push(s),
  });
  return { t, inners, statuses, current: () => inners[inners.length - 1] };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ReconnectingTransport", () => {
  it("connects, declares subscriptions on the inner, and answers queries with a client deadline", async () => {
    const w = world();
    await w.t.start();
    expect(w.t.status()).toBe("connected");
    const seen: Sample[] = [];
    await w.t.subscribe("k/**", (s) => seen.push(s));
    await flush();
    expect(w.current().subs.map((s) => s.keyexpr)).toEqual(["k/**"]);
    w.current().subs[0].handler({ keyexpr: "k/1", payload: new Uint8Array([1]), kind: "put" });
    expect(seen).toHaveLength(1);
    // a query the far end never answers: rejected at timeout + margin, not left hanging
    const q = w.t.get("svc/x", { timeoutMs: 300 });
    const err = q.catch((e) => e);
    await vi.advanceTimersByTimeAsync(399);
    expect(w.t.status()).toBe("connected");
    await vi.advanceTimersByTimeAsync(2);
    expect(await err).toMatchObject({ name: "TransportError", code: "deadline" });
  });

  it("a failed probe drops the link, fails what is in flight at once, refuses new queries, then reconnects and re-declares", async () => {
    const w = world();
    await w.t.start();
    const samples: string[] = [];
    const events: LivelinessEvent[] = [];
    await w.t.subscribe("topic/**", (s) => samples.push(s.keyexpr));
    await w.t.liveliness.subscribe("fleet/*/media/*", (e) => events.push(e));
    await flush();
    const first = w.current();
    first.live[0].handler({ keyexpr: "fleet/1/media/cam", alive: true });
    expect(events).toEqual([{ keyexpr: "fleet/1/media/cam", alive: true }]);

    // a query in flight when the link dies
    const inflight = w.t.get("svc/y", { timeoutMs: 5000 }).catch((e) => e);
    // the heartbeat fires and is never answered -> probe timeout -> drop
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.probes()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(w.t.status()).toBe("reconnecting");
    expect(first.closed).toBe(true);
    expect(await inflight).toMatchObject({ code: "disconnected" });
    // while down: refused immediately, no queue
    await expect(w.t.get("svc/z")).rejects.toMatchObject({ code: "disconnected" });
    // reconnect after the backoff: a NEW inner, the same subscriptions re-declared through the same handles
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(w.inners).toHaveLength(2);
    const second = w.current();
    expect(w.t.status()).toBe("connected");
    expect(second.subs.map((s) => s.keyexpr)).toEqual(["topic/**"]);
    expect(second.live.map((s) => s.keyexpr)).toEqual(["fleet/*/media/*"]);
    // the token seen alive on the old link was reported gone before the re-declare ...
    expect(events[1]).toEqual({ keyexpr: "fleet/1/media/cam", alive: false });
    // ... and the history re-PUT brings it back; samples flow from the new inner, never the old
    second.live[0].handler({ keyexpr: "fleet/1/media/cam", alive: true });
    expect(events[2]).toEqual({ keyexpr: "fleet/1/media/cam", alive: true });
    second.subs[0].handler({ keyexpr: "topic/a", payload: new Uint8Array(), kind: "put" });
    first.subs[0].handler({ keyexpr: "topic/stale", payload: new Uint8Array(), kind: "put" });
    expect(samples).toEqual(["topic/a"]);
    expect(w.statuses).toEqual(["connecting", "connected", "reconnecting", "connected"]);
  });

  it("after a reconnect the live tokens are re-queried, and the ones the history replay missed are PUT", async () => {
    // The bench finding: re-dialing the sidecar the instant its process is back, before it has
    // rejoined the router, gives an EMPTY history replay -- "connected" with every tile offline.
    const w = world();
    await w.t.start();
    const events: LivelinessEvent[] = [];
    await w.t.liveliness.subscribe("fleet/*/media/*", (e) => events.push(e));
    await flush();
    w.current().live[0].handler({ keyexpr: "fleet/1/media/cam", alive: true });
    w.current().live[0].handler({ keyexpr: "fleet/1/media/aux", alive: true });
    await vi.advanceTimersByTimeAsync(1500); // probe unanswered -> drop
    await vi.advanceTimersByTimeAsync(200); // reconnect
    await flush();
    const second = w.current();
    expect(events.slice(2)).toEqual([
      { keyexpr: "fleet/1/media/cam", alive: false },
      { keyexpr: "fleet/1/media/aux", alive: false },
    ]);
    // the history replay brings back only one of the two ...
    second.live[0].handler({ keyexpr: "fleet/1/media/cam", alive: true });
    // ... the first resync (1 s after the re-declare) asks the router for the current set
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.answerLiveliness("fleet/*/media/*", ["fleet/1/media/cam", "fleet/1/media/aux"])).toBe(1);
    await flush();
    expect(events.slice(4)).toEqual([
      { keyexpr: "fleet/1/media/cam", alive: true }, // the replay
      { keyexpr: "fleet/1/media/aux", alive: true }, // the resync -- and cam is NOT put twice
    ]);
    // a later resync that finds nothing new emits nothing (the heartbeats answered as they come,
    // or the link would rightly be dropped again)
    second.answerProbes();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      second.answerProbes();
    }
    expect(second.answerLiveliness("fleet/*/media/*", ["fleet/1/media/cam", "fleet/1/media/aux"])).toBe(1);
    await flush();
    expect(events).toHaveLength(6);
    expect(w.inners).toHaveLength(2); // and the link stayed up throughout
  });

  it("a query issued from a liveliness handler during the re-declaration goes through, not refused", async () => {
    // The bench finding behind the ordering: consumers answer a replayed PUT by fetching the
    // token's descriptor at once; with the link still flagged "reconnecting" until the
    // re-declaration ended, every one of those fetches was refused.
    const w = world();
    await w.t.start();
    const outcomes: string[] = [];
    await w.t.liveliness.subscribe("fleet/*/media/*", (e) => {
      if (e.alive) void w.t.get(e.keyexpr).then(() => outcomes.push("ok"), (err: TransportError) => outcomes.push(err.code));
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1500); // drop
    await vi.advanceTimersByTimeAsync(200); // reconnect: the re-declare runs ...
    await flush();
    const second = w.current();
    second.live[0].handler({ keyexpr: "fleet/1/media/cam", alive: true }); // ... and the history replays
    await flush();
    expect(outcomes).toEqual([]); // the descriptor query is PENDING on the new inner, not refused
    expect(second.pending.map((p) => p.keyexpr)).toContain("fleet/1/media/cam");
    expect(w.t.status()).toBe("connected");
  });

  it("a healthy link is probed and stays connected; a released subscription is not re-declared", async () => {
    const w = world();
    await w.t.start();
    const sub = await w.t.subscribe("gone/**", () => undefined);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.current().probes()).toBe(1);
    w.current().answerAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.t.status()).toBe("connected");
    await sub.close();
    expect(w.current().subs[0].open).toBe(false);
    // force a drop, reconnect: nothing to re-declare
    await vi.advanceTimersByTimeAsync(500);
    expect(w.t.status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(w.current().subs).toEqual([]);
  });

  it("a first dial that fails reports error, keeps retrying with backoff, and resolves start() when it lands", async () => {
    const w = world({ failFirst: 3 });
    const started = w.t.start();
    await flush();
    expect(w.t.status()).toBe("error");
    expect(w.t.lastError()).toBe("ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(200); // attempt 2 fails
    await vi.advanceTimersByTimeAsync(400); // attempt 3 fails
    expect(w.t.status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(800); // attempt 4 lands
    await flush();
    expect(w.t.status()).toBe("connected");
    await started; // resolved on the FIRST connect (the first attempt) — never left pending
    expect(w.inners).toHaveLength(1);
  });

  it("close() fails in-flight queries, stops probing, and refuses further use", async () => {
    const w = world();
    await w.t.start();
    const q = w.t.get("svc/q").catch((e) => e);
    await w.t.close();
    expect(await q).toMatchObject({ code: "closed" });
    await expect(w.t.get("svc/q")).rejects.toBeInstanceOf(TransportError);
    expect(w.current().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.current().probes()).toBe(0);
  });
});
