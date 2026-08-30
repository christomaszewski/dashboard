import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSessionPool, type VideoLike } from "./sessionPool";
import type { StreamSource, StreamSourceHooks } from "../source/types";
import type { DiscoveredStream, StreamDescriptor } from "../types";

// ---- fakes ------------------------------------------------------------------------------------

class FakeSource implements StreamSource {
  hooks: StreamSourceHooks | null = null;
  closed = false;
  constructor(readonly descriptor: StreamDescriptor) {}
  open(hooks: StreamSourceHooks): Promise<void> {
    this.hooks = hooks;
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
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
});
