import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../ros/graph";
import { TransportError } from "../transport/reconnecting";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";
import type { Decoder, SchemaResolver } from "../schema/types";
import { FakeStore } from "./testkit";
import { FrameServer, serveFrameQuery } from "./frames";
import { FrameFetcher, type FrameUpdate } from "./frameClient";

const CAM = "@ros2_lv/0/z/1/1/MP/%/%/cam/%camera%image_raw/sensor_msgs::msg::dds_::Image_/RIHS01_cc/2:2:1,10";
const graph = buildGraph([CAM]);
const camKey = graph.topics[0].dataKeyexpr;

/** Frame queries answered in-process, after an adjustable "link" delay. */
class FrameLink implements Transport {
  delayMs = 0;
  down = false;
  requests: Record<string, unknown>[] = [];
  constructor(private readonly server: FrameServer) {}
  async get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    if (this.down) throw new TransportError("disconnected", "link lost: test");
    this.requests.push(JSON.parse(new TextDecoder().decode(opts?.payload)));
    const replies: GetReply[] = [];
    await serveFrameQuery(this.server, {
      keyexpr, payload: opts?.payload,
      reply: async (payload) => void replies.push({ keyexpr, payload }),
      replyErr: async (m) => opts?.onReplyError?.(m),
    });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return replies;
  }
  subscribe(): never { throw new Error("no"); }
  readonly liveliness = { subscribe: () => Promise.resolve({ close: () => Promise.resolve() }), get: () => Promise.resolve([] as string[]) };
  close() { return Promise.resolve(); }
}

describe("FrameFetcher", () => {
  let store: FakeStore;
  let server: FrameServer;
  let link: FrameLink;
  let updates: FrameUpdate[];
  let fetcher: FrameFetcher;
  let n = 0;
  const resolver: SchemaResolver = {
    resolve: () => Promise.resolve<Decoder>({ decode: (b) => ({ width: 8, height: 4, step: 24, encoding: "rgb8", data: new Uint8Array(96).fill(b[0]) }) }),
  };
  const publish = () => store.emit(camKey, { raw: new Uint8Array([++n % 256]) });

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    server = new FrameServer({
      store, resolver, epoch: "e1", holdMs: 2000,
      encoder: { encode: async (_s, o) => ({ bytes: new Uint8Array(o.maxWidth), width: o.maxWidth, height: 1, mime: "image/jpeg" }) },
    });
    server.setGraph(graph);
    link = new FrameLink(server);
    updates = [];
  });
  afterEach(() => {
    fetcher?.stop();
    server.close();
    vi.useRealTimers();
  });
  const start = (maxHz = 2) => {
    fetcher = new FrameFetcher({
      transport: link, base: "fleet/r1/dash/d/state", topic: "/camera/image_raw",
      options: { maxHz, maxWidth: 640, quality: 60, format: "jpeg", normalize: true },
      onUpdate: (u) => updates.push(u),
    });
    fetcher.start();
  };
  const frames = () => updates.filter((u) => u.image);

  it("never asks faster than max_hz, and only for frames newer than the one shown", async () => {
    publish();
    start(2);
    for (let i = 0; i < 20; i++) {
      publish(); // a 10 Hz camera
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(frames().length).toBeGreaterThanOrEqual(3);
    expect(frames().length).toBeLessThanOrEqual(5); // 2 s at 2 Hz
    const seqs = frames().map((u) => u.header!.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(link.requests.slice(1).every((r) => (r.since as number) > 0 && r.epoch === "e1")).toBe(true);
  });

  it("shrinks frames when they cross slowly and grows them back when the link recovers", async () => {
    publish();
    start(2);
    link.delayMs = 1200; // a frame takes 1.2 s to cross: more than 1.5 × the 500 ms interval
    for (let i = 0; i < 30; i++) {
      publish();
      await vi.advanceTimersByTimeAsync(200);
    }
    const slow = frames().at(-1)!;
    expect(slow.level).toBeGreaterThanOrEqual(2);
    expect(link.requests.at(-1)!.max_width).toBeLessThanOrEqual(320);
    expect(link.requests.at(-1)!.quality).toBeLessThanOrEqual(40);
    link.delayMs = 0;
    for (let i = 0; i < 100; i++) {
      publish();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(frames().at(-1)!.level).toBe(0);
    expect(link.requests.at(-1)!.max_width).toBe(640);
  });

  it("keeps the last frame through a link outage (no error) and resumes", async () => {
    publish();
    start(2);
    await vi.advanceTimersByTimeAsync(600);
    const before = frames().length;
    link.down = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates.at(-1)).toMatchObject({ link: "link lost: test" });
    expect(updates.some((u) => u.error)).toBe(false);
    link.down = false;
    publish();
    await vi.advanceTimersByTimeAsync(1200);
    expect(frames().length).toBeGreaterThan(before);
  });

  it("reports a vehicle that does not answer, and stops when asked", async () => {
    const empty = new FrameLink(server);
    empty.get = async () => [];
    fetcher = new FrameFetcher({
      transport: empty, base: "fleet/r1/dash/d/state", topic: "/camera/image_raw",
      options: { maxHz: 2, maxWidth: 640, quality: 60, format: "jpeg", normalize: true },
      onUpdate: (u) => updates.push(u),
    });
    fetcher.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates).toEqual([]); // a brief gap stays quiet
    await vi.advanceTimersByTimeAsync(1600);
    expect(updates[0].error).toMatch(/not reachable \(fleet\/r1\/dash\/d\/state\/frame\)/);
    fetcher.stop();
    const count = updates.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updates.length).toBe(count);
  });
});
