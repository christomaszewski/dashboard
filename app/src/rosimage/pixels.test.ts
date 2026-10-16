import { describe, expect, it } from "vitest";
import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import { ros2jazzy } from "@foxglove/rosmsg-msgs-common";
import { buildRos2StaticDecoder } from "../schema/decoders/staticDefs";
import { imagePixels, MAX_IMAGE_PIXELS } from "./pixels";
import { parseHome } from "../config/schema";

const mono = { width: 2, height: 1, step: 4, encoding: "mono16", is_bigendian: 0, data: new Uint8Array([0, 0, 255, 255]) };
describe("ROS image pixels", () => {
  it("decodes a ROS CDR mono16 frame through the dashboard's real decoder", async () => {
    const writer = new MessageWriter([ros2jazzy["sensor_msgs/Image"], ros2jazzy["std_msgs/Header"], ros2jazzy["builtin_interfaces/Time"]]);
    const wire = writer.writeMessage({ ...mono, header: { stamp: { sec: 7, nanosec: 8 }, frame_id: "os_sensor" } });
    const decoder = await buildRos2StaticDecoder("sensor_msgs/msg/Image");
    expect([...imagePixels(decoder.decode(wire), false).rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
  it.each([0, 1])("respects byte order %i, padded rows and byte-array offsets", (big) => {
    const bytes = new Uint8Array(14);
    const view = new DataView(bytes.buffer, 2, 12);
    [0, 32768, 65535, 16384].forEach((value, i) => view.setUint16(Math.floor(i / 2) * 6 + (i % 2) * 2, value, !big));
    const pixels = imagePixels({ ...mono, height: 2, step: 6, is_bigendian: big, data: bytes.subarray(2) }, false);
    expect([...pixels.rgba].filter((_, i) => i % 4 === 0)).toEqual([0, 128, 255, 64]);
  });
  it("stretches narrow grayscale values and handles constant/zero frames", () => {
    expect([...imagePixels({ ...mono, encoding: "mono8", step: 2, data: [100, 110] }, true).rgba]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(imagePixels({ ...mono, data: [0, 128, 0, 128] }, true).rgba[0]).toBe(128);
    expect(imagePixels({ ...mono, data: [0, 0, 0, 0] }, true).rgba[0]).toBe(0);
  });
  it.each(["rgb8", "bgr8", "rgba8", "bgra8"])("preserves %s channel order and alpha", (encoding) => {
    const bgr = encoding.startsWith("bgr"), alpha = encoding.includes("a");
    const data = bgr ? [30, 20, 10] : [10, 20, 30];
    if (alpha) data.push(128);
    expect([...imagePixels({ width: 1, height: 1, step: data.length, encoding, is_bigendian: 0, data }, true).rgba])
      .toEqual([10, 20, 30, alpha ? 128 : 255]);
  });
  it.each([
    { width: 0 }, { height: -1 }, { width: 0.5 }, { width: MAX_IMAGE_PIXELS },
    { step: 3 }, { step: Infinity }, { data: [1, 2] }, { data: [1, -1, 2, 3] },
    { data: [1, 256, 2, 3] }, { is_bigendian: 2 }, { encoding: "bayer_rggb8" }, { encoding: "constructor" },
  ])("rejects invalid/unsupported frames %j before drawing", (over) => {
    expect(() => imagePixels({ ...mono, ...over }, true)).toThrow();
  });
  it.each(["8UC1", "16UC1"])("accepts scalar encoding %s", (encoding) => {
    expect(imagePixels({ ...mono, encoding }, false).rgba).toHaveLength(8);
  });
});

describe("ROS image configuration", () => {
  const parse = (extra = {}) => parseHome({ version: 1, widgets: [{ type: "ros_image", topic: "/image", ...extra }] }).widgets[0];
  it("supplies safe defaults and accepts the documented overrides", () => {
    expect(parse()).toMatchObject({ ok: true, widget: { normalize: true, stale_after_s: 3 } });
    expect(parse({ topics: ["/image", "/nearir"], domain_id: 7, normalize: false, stale_after_s: 8, area: "lidar" }).ok).toBe(true);
  });
  it.each([{ topic: "image" }, { topics: [] }, { topics: ["/other"] }, { topics: 4 }, { domain_id: -1 }, { domain_id: 0.5 },
    { stale_after_s: 0 }, { stale_after_s: "3" }, { normalize: "true" }])("rejects unusable options %j", (over) => expect(parse(over).ok).toBe(false));
});
