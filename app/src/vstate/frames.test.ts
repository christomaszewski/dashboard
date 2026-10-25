import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../ros/graph";
import type { Decoder, SchemaResolver } from "../schema/types";
import { FakeStore } from "./testkit";
import {
  FrameServer,
  decodeFrameReply,
  encodeFrameReply,
  frameSource,
  serveFrameQuery,
  type FrameEncoder,
  type FrameSource,
} from "./frames";

const CAM = "@ros2_lv/0/z/1/1/MP/%/%/cam/%camera%image_raw/sensor_msgs::msg::dds_::Image_/RIHS01_cc/2:2:1,10";
const IMU = "@ros2_lv/0/z/1/2/MP/%/%/imu/%imu%data/sensor_msgs::msg::dds_::Imu_/RIHS01_aa/2:2:1,10";
const graph = buildGraph([CAM, IMU]);
const camKey = graph.topics.find((t) => t.name === "/camera/image_raw")!.dataKeyexpr;

const image = (n: number) => ({
  header: { stamp: { sec: 1000 + n, nanosec: 500_000_000 } },
  width: 4, height: 2, step: 12, encoding: "rgb8", is_bigendian: 0, data: new Uint8Array(24).fill(n),
});

describe("FrameServer", () => {
  let store: FakeStore;
  let encodes: { source: FrameSource; maxWidth: number; quality: number }[];
  let encoder: FrameEncoder;
  let server: FrameServer;
  let t = 0;
  const messages = new Map<number, Record<string, unknown>>();
  const resolver: SchemaResolver = {
    resolve: () => Promise.resolve<Decoder>({ decode: (bytes) => messages.get(bytes[0])! }),
  };
  const publish = (n: number) => {
    messages.set(n, image(n));
    store.emit(camKey, { raw: new Uint8Array([n]) });
  };
  const ask = (extra: Record<string, unknown> = {}) => server.request({ v: 1, topic: "/camera/image_raw", ...extra });

  beforeEach(() => {
    vi.useFakeTimers();
    t = 0;
    store = new FakeStore();
    encodes = [];
    encoder = {
      encode: async (source, opts) => {
        encodes.push({ source, maxWidth: opts.maxWidth, quality: opts.quality });
        return { bytes: new Uint8Array([0xff, 0xd8, opts.quality]), width: 2, height: 1, mime: "image/jpeg" };
      },
    };
    server = new FrameServer({ store, resolver, encoder, epoch: "e1", now: () => t, holdMs: 2000 });
    server.setGraph(graph);
  });
  afterEach(() => {
    server.close();
    vi.useRealTimers();
  });
  const advance = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  it("subscribes raw only, waits for the first frame, then sends it encoded with its stamp and source size", async () => {
    const pending = ask({ max_width: 320, quality: 50 });
    await advance(100);
    expect(store.acquired).toEqual([{ key: camKey, opts: { decode: false, raw: true }, released: false }]);
    publish(1);
    await advance(0);
    const { header, image: bytes } = await pending;
    expect(header).toMatchObject({ seq: 1, epoch: "e1", t: "sensor_msgs/msg/Image", w: 2, h: 1, sw: 4, sh: 2, enc: "rgb8", mime: "image/jpeg", stamp: 1_001_500, held: 100 });
    expect(bytes).toEqual(new Uint8Array([0xff, 0xd8, 50]));
    expect(encodes[0]).toMatchObject({ maxWidth: 320, quality: 50, source: { kind: "raw", channels: 3, width: 4, height: 2 } });
  });

  it("holds a caller that has the latest frame until a newer one, or answers 'nothing newer' after the hold", async () => {
    publish(1);
    expect((await ask()).header.seq).toBe(1);
    const waiting = ask({ since: 1, epoch: "e1" });
    await advance(500);
    publish(2);
    await advance(0);
    const next = await waiting;
    expect(next.header.seq).toBe(2);
    expect(next.image).toBeDefined();
    const idle = ask({ since: 2, epoch: "e1" });
    await advance(2000);
    const r = await idle;
    expect(r.header).toMatchObject({ seq: 2, held: 2000 });
    expect(r.image).toBeUndefined();
  });

  it("encodes a frame once per size and quality, however many operators ask", async () => {
    publish(1);
    await Promise.all([ask(), ask(), ask({ quality: 30 })]);
    expect(encodes.map((e) => e.quality).sort()).toEqual([30, 60]);
  });

  it("ignores `since` from another epoch (a restarted service) and answers at once", async () => {
    publish(1);
    const r = await ask({ since: 1, epoch: "old" });
    expect(r.header.seq).toBe(1);
    expect(r.image).toBeDefined();
  });

  it("reports topics that are not advertised as images, staleness, and expiry", async () => {
    const none = await server.request({ v: 1, topic: "/imu/data" });
    expect(none.header.t).toBeUndefined();
    publish(1);
    await ask();
    await advance(6000);
    const held = ask({ since: 1, epoch: "e1" });
    await advance(2000);
    expect((await held).header).toMatchObject({ seq: 1, s: 1 });
    await advance(11_000);
    server.tick();
    expect(store.live(camKey)).toBe(0);
  });

  it("puts encoder failures and oversized frames in the header", async () => {
    encoder.encode = () => Promise.reject(new Error("vips: bad data"));
    publish(1);
    expect((await ask()).header.e).toBe("frame: vips: bad data");
    encoder.encode = async () => ({ bytes: new Uint8Array(3 * 1024 * 1024), width: 1, height: 1, mime: "image/jpeg" });
    publish(2);
    expect((await ask({ quality: 61 })).header.e).toMatch(/frame too large/);
  });

  it("answers queries with a binary reply and rejects bad requests with a reply error", async () => {
    publish(1);
    const out: Uint8Array[] = [];
    const errs: string[] = [];
    const q = (body: unknown) => ({
      keyexpr: "k", payload: new TextEncoder().encode(JSON.stringify(body)),
      reply: async (b: Uint8Array) => void out.push(b), replyErr: async (m: string) => void errs.push(m),
    });
    await serveFrameQuery(server, q({ v: 1, topic: "/camera/image_raw" }));
    await serveFrameQuery(server, q({ v: 1, topic: "camera", max_width: 5 }));
    expect(decodeFrameReply(out[0]).header.seq).toBe(1);
    expect(errs[0]).toMatch(/absolute ROS topic name/);
  });
});

describe("frame sources and replies", () => {
  it("pass 8-bit images to the encoder as they are, dropping row padding", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 9, 10, 11, 12, 0, 0]);
    const src = frameSource({ width: 2, height: 2, step: 8, encoding: "bgr8", data }, true);
    expect(src).toMatchObject({ kind: "raw", channels: 3, bgr: true, width: 2, height: 2 });
    expect(src.kind === "raw" && [...src.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("convert 16-bit images through the shared converter, normalized", () => {
    const data = new Uint8Array(new Uint16Array([1000, 3000]).buffer);
    const src = frameSource({ width: 2, height: 1, step: 4, encoding: "mono16", is_bigendian: 0, data }, true);
    expect(src.kind === "raw" && [src.channels, ...src.data]).toEqual([4, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it("re-encode compressed images, but not compressed depth", () => {
    expect(frameSource({ format: "jpeg", data: new Uint8Array([1]) }, true)).toMatchObject({ kind: "compressed", format: "jpeg" });
    expect(() => frameSource({ format: "16UC1; compressedDepth png", data: new Uint8Array([1]) }, true)).toThrow(/compressedDepth/);
  });

  it("round-trip header and image through the binary reply", () => {
    const r = decodeFrameReply(encodeFrameReply({ v: 1, epoch: "e", seq: 3, w: 2 }, new Uint8Array([9, 8])));
    expect(r).toEqual({ header: { v: 1, epoch: "e", seq: 3, w: 2 }, image: new Uint8Array([9, 8]) });
    expect(decodeFrameReply(encodeFrameReply({ v: 1, epoch: "e", seq: 3 })).image).toBeUndefined();
  });
});
