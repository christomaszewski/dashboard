import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSessionPool, formatStats, type VideoLike } from "./sessionPool";
import type { StreamSource, StreamSourceHooks, StreamStats } from "../source/types";
import type { DiscoveredStream, StreamDescriptor } from "../types";

// ---- fakes ------------------------------------------------------------------------------------

class FakeSource implements StreamSource {
  hooks: StreamSourceHooks | null = null;
  closed = false;
  /** When set, the source reports receive-path stats; the pool must sample them BEFORE close(). */
  statsToReport: StreamStats | null = null;
  statsCalls = 0;
  statsSampledWhileOpen = true;
  constructor(readonly descriptor: StreamDescriptor) {}
  open(hooks: StreamSourceHooks): Promise<void> {
    this.hooks = hooks;
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  stats(): Promise<StreamStats | null> {
    this.statsCalls += 1;
    if (this.closed) this.statsSampledWhileOpen = false;
    return Promise.resolve(this.statsToReport);
  }
}

function descriptor(overrides: Partial<StreamDescriptor> = {}): StreamDescriptor {
  return {
    schema_version: 1,
    id: "cam0",
    producer: "camera-service",
    protocol: "gstwebrtc-api",
    signalling: "ws://veh:8443",
    producer_id: "cam0-webrtc",
    ...overrides,
  };
}

function stream(key: string, alive = true, d: Partial<StreamDescriptor> = {}): DiscoveredStream {
  return { key, vehicleId: "veh", sensorId: key.split("/").pop() ?? key, descriptor: descriptor(d), alive };
}

function fakeVideo(): VideoLike & { firePlaying(): void; playCalls: number } {
  const listeners = new Set<() => void>();
  return {
    srcObject: null,
    currentTime: 0,
    paused: false,
    playCalls: 0,
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    addEventListener(_t: "playing", cb: () => void) {
      listeners.add(cb);
    },
    removeEventListener(_t: "playing", cb: () => void) {
      listeners.delete(cb);
    },
    firePlaying() {
      for (const cb of [...listeners]) cb();
    },
  };
}

const fakeMedia = () => ({ getTracks: () => [] }) as unknown as MediaStream;

const KEY = "fleet/veh/media/cam0";

// ---- spec -------------------------------------------------------------------------------------

describe("StreamSessionPool", () => {
  let sources: FakeSource[];
  let pool: StreamSessionPool;

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    pool = new StreamSessionPool({
      createSource: (d) => {
        const s = new FakeSource(d);
        sources.push(s);
        return s;
      },
    });
    pool.updateStreams([stream(KEY)]);
  });

  afterEach(() => {
    pool.closeAll();
    vi.useRealTimers();
  });

  it("opens ONE source per key however many handles acquire it", () => {
    const h1 = pool.acquire(KEY);
    const h2 = pool.acquire(KEY);
    expect(sources).toHaveLength(1);
    expect(pool.getSnapshot(KEY)?.state).toBe("opening");
    h1.release();
    h2.release();
  });

  it("fans the MediaStream out to every attached element, late joiners included", () => {
    const h = pool.acquire(KEY);
    const v1 = fakeVideo();
    const v2 = fakeVideo();
    h.attach(v1);
    h.attach(v2);
    const media = fakeMedia();
    sources[0].hooks!.onStream(media);
    expect(v1.srcObject).toBe(media);
    expect(v2.srcObject).toBe(media);
    expect(v1.playCalls).toBe(1);
    const v3 = fakeVideo();
    h.attach(v3); // late joiner gets the already-negotiated stream
    expect(v3.srcObject).toBe(media);
    h.release();
  });

  it("closes only after the linger grace; re-acquire inside it cancels the close", () => {
    const h = pool.acquire(KEY);
    h.release();
    expect(sources[0].closed).toBe(false);
    vi.advanceTimersByTime(2999);
    const h2 = pool.acquire(KEY); // inside the linger
    vi.advanceTimersByTime(10_000);
    expect(sources[0].closed).toBe(false);
    expect(sources).toHaveLength(1); // no renegotiation
    h2.release();
    vi.advanceTimersByTime(3000);
    expect(sources[0].closed).toBe(true);
    expect(pool.getSnapshot(KEY)).toBeNull();
  });

  it("survives a StrictMode mount→unmount→mount in one tick with exactly one source", () => {
    const h1 = pool.acquire(KEY);
    h1.release();
    const h2 = pool.acquire(KEY);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(false);
    h2.release();
  });

  it("a handle releases at most once", () => {
    const h1 = pool.acquire(KEY);
    const h2 = pool.acquire(KEY);
    h1.release();
    h1.release(); // double release must not steal h2's ref
    vi.advanceTimersByTime(60_000);
    expect(sources[0].closed).toBe(false);
    h2.release();
  });

  it("retries with exponential backoff capped at 10 s", () => {
    pool.acquire(KEY);
    sources[0].hooks!.onError!("ice failed");
    expect(pool.getSnapshot(KEY)?.state).toBe("reconnecting");
    expect(pool.getSnapshot(KEY)?.error).toBe("ice failed");
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].hooks!.onError!("again");
    vi.advanceTimersByTime(1999);
    expect(sources).toHaveLength(2); // 2 s backoff not elapsed yet
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    sources[2].hooks!.onError!("again");
    vi.advanceTimersByTime(4000);
    expect(sources).toHaveLength(4);
    for (let i = 3; i < 12; i++) {
      sources[i].hooks!.onError!("again");
      vi.advanceTimersByTime(10_000); // capped
      expect(sources).toHaveLength(i + 2);
    }
  });

  it("error+closed firing together schedule ONE retry", () => {
    pool.acquire(KEY);
    sources[0].hooks!.onError!("boom");
    sources[0].hooks!.onClosed?.();
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(20_000);
    expect(sources).toHaveLength(2);
  });

  it("an attached element's `playing` event resets the backoff", () => {
    const h = pool.acquire(KEY);
    const v = fakeVideo();
    h.attach(v);
    sources[0].hooks!.onError!("x");
    vi.advanceTimersByTime(1000); // backoff now 2 s
    sources[1].hooks!.onStream(fakeMedia());
    v.firePlaying();
    expect(pool.getSnapshot(KEY)?.state).toBe("playing");
    sources[1].hooks!.onError!("y");
    vi.advanceTimersByTime(1000); // backoff was reset → base delay again
    expect(sources).toHaveLength(3);
  });

  it("stall watchdog: frozen currentTime for >12 s at 3 s polls triggers a retry", () => {
    const h = pool.acquire(KEY);
    const v = fakeVideo();
    h.attach(v);
    sources[0].hooks!.onStream(fakeMedia());
    v.firePlaying();
    // advancing time with advancing currentTime → healthy
    for (let i = 0; i < 4; i++) {
      v.currentTime += 1;
      vi.advanceTimersByTime(3000);
    }
    expect(sources).toHaveLength(1);
    // now freeze currentTime
    vi.advanceTimersByTime(15_000);
    expect(pool.getSnapshot(KEY)?.state).toBe("reconnecting");
    expect(pool.getSnapshot(KEY)?.error).toBe("video stalled");
  });

  it("stall watchdog counts decoded frames when the element can: a held source's 1 Hz stills keep it alive", () => {
    const h = pool.acquire(KEY);
    const v = fakeVideo() as ReturnType<typeof fakeVideo> & { frames: number; getVideoPlaybackQuality(): { totalVideoFrames: number } };
    v.frames = 0;
    v.getVideoPlaybackQuality = () => ({ totalVideoFrames: v.frames });
    h.attach(v);
    sources[0].hooks!.onStream(fakeMedia());
    v.firePlaying();
    for (let i = 0; i < 8; i++) {
      v.frames += 1; // one still per poll, currentTime frozen
      vi.advanceTimersByTime(3000);
    }
    expect(sources).toHaveLength(1);
    expect(pool.getSnapshot(KEY)?.state).toBe("playing");
    vi.advanceTimersByTime(15_000); // frames frozen too → a real stall
    expect(pool.getSnapshot(KEY)?.state).toBe("reconnecting");
  });

  it("stall watchdog idles with zero live attachments instead of false-positiving", () => {
    const h = pool.acquire(KEY);
    const v = fakeVideo();
    h.attach(v);
    sources[0].hooks!.onStream(fakeMedia());
    v.firePlaying();
    h.detach(v);
    vi.advanceTimersByTime(120_000);
    expect(pool.getSnapshot(KEY)?.state).toBe("playing"); // no sample to judge → no churn
    expect(sources).toHaveLength(1);
  });

  it("liveliness flap: withdraw closes the session, revive redials immediately with the FRESH descriptor", () => {
    pool.acquire(KEY);
    sources[0].hooks!.onStream(fakeMedia());
    pool.updateStreams([stream(KEY, false)]);
    expect(pool.getSnapshot(KEY)?.state).toBe("offline");
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1); // no dialing a withdrawn producer
    pool.updateStreams([stream(KEY, true, { signalling: "ws://veh:9443" })]);
    expect(sources).toHaveLength(2);
    expect(sources[1].descriptor.signalling).toBe("ws://veh:9443"); // post-restart ports honored
  });

  it("a key disappearing from discovery entirely is treated as offline", () => {
    pool.acquire(KEY);
    pool.updateStreams([]);
    expect(pool.getSnapshot(KEY)?.state).toBe("offline");
    expect(sources[0].closed).toBe(true);
  });

  it("a pending retry is cancelled when the producer withdraws", () => {
    pool.acquire(KEY);
    sources[0].hooks!.onError!("x"); // retry pending
    pool.updateStreams([stream(KEY, false)]);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1); // the pending retry never fired
    expect(pool.getSnapshot(KEY)?.state).toBe("offline");
  });

  it("acquiring an undiscovered key waits offline, then dials on discovery", () => {
    const other = "fleet/veh/media/zr30";
    pool.acquire(other);
    expect(pool.getSnapshot(other)?.state).toBe("offline");
    expect(sources).toHaveLength(0); // nothing to dial yet
    pool.updateStreams([stream(KEY), stream(other, true, { id: "zr30" })]);
    expect(sources).toHaveLength(1); // only the acquired key dials
    expect(sources[0].descriptor.id).toBe("zr30");
  });

  it("stale source callbacks after close are ignored (release-during-open race)", () => {
    const h = pool.acquire(KEY);
    const src = sources[0];
    h.release();
    vi.advanceTimersByTime(3000); // linger elapses → teardown
    expect(src.closed).toBe(true);
    expect(() => src.hooks!.onStream(fakeMedia())).not.toThrow();
    expect(() => src.hooks!.onError?.("late")).not.toThrow();
    expect(sources).toHaveLength(1); // no zombie retry
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it("a retry logs WHY, with the receive-path stats sampled from the source before it is closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = pool.acquire(KEY);
    const v = fakeVideo();
    h.attach(v);
    sources[0].statsToReport = { packetsReceived: 1234, packetsLost: 5, framesDecoded: 398, freezeCount: 1, totalFreezesDuration: 0.9, transport: "udp host->host", currentRoundTripTime: 0.003 };
    sources[0].hooks!.onStream(fakeMedia());
    v.firePlaying();
    v.currentTime = 1;
    vi.advanceTimersByTime(3000);
    vi.advanceTimersByTime(15_000); // frozen → stall watchdog
    expect(pool.getSnapshot(KEY)?.error).toBe("video stalled");
    expect(sources[0].statsCalls).toBe(1);
    expect(sources[0].statsSampledWhileOpen).toBe(true);
    await Promise.resolve(); // the stats promise settles on the microtask queue
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("retry"));
    expect(line).toContain(`retry ${KEY} in 1000 ms: video stalled (no new frame for 15.0 s)`);
    expect(line).toContain("pkts 1234 lost 5 | frames dec 398 freezes 1 (0.9 s) | udp host->host rtt 3 ms");
    warn.mockRestore();
    h.release();
  });

  it("a retry still logs when the source has no stats to give", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pool.acquire(KEY);
    sources[0].hooks!.onError!("ice failed"); // statsToReport is null: nothing connected yet
    await Promise.resolve();
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("retry"));
    expect(line).toBe(`[stream-pool] retry ${KEY} in 1000 ms: ice failed`);
    warn.mockRestore();
  });
});

describe("formatStats", () => {
  it("prints only what was reported, in a fixed order", () => {
    expect(formatStats({})).toBe("");
    expect(formatStats({ transport: "tcp host->host" })).toBe("tcp host->host");
    expect(
      formatStats({
        packetsReceived: 10, packetsLost: 0, nackCount: 2, pliCount: 1,
        framesReceived: 8, framesDecoded: 7, framesDropped: 1, freezeCount: 0,
        jitterBufferDelay: 0.61, jitterBufferEmittedCount: 10,
        transport: "udp host->srflx", currentRoundTripTime: 0.0124,
      }),
    ).toBe("pkts 10 lost 0 nack 2 pli 1 | frames rx 8 dec 7 drop 1 freezes 0 | jb 61 ms | udp host->srflx rtt 12 ms");
  });
});
