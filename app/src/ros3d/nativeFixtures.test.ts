import { describe, expect, it } from "vitest";
import { buildRos2StaticDecoder } from "../schema/decoders/staticDefs";
import { parsePointCloud } from "./pointCloud";
import { TfBuffer, readTransform } from "./tf";
import { add, rotate, type Vec3 } from "./math";
import expected from "./fixtures/expected.json";
import vectors from "./fixtures/native.json";
const bytes = (name: keyof typeof vectors) => new Uint8Array(vectors[name]);
describe("native Lyrical interoperability", () => {
  it("decodes native CDR and matches native tf2's lookup and stationary world geometry", async () => {
    const decoder = await buildRos2StaticDecoder("tf2_msgs/msg/TFMessage"); const tf = new TfBuffer();
    for (const name of ["tf_static", "tf"] as const) {
      const message = decoder.decode(bytes(name));
      for (const value of message.transforms as unknown[]) tf.insert(readTransform(value), name === "tf_static");
      expect(decoder.lastWarning?.()).toBeUndefined();
    }
    const cloudDecoder = await buildRos2StaticDecoder("sensor_msgs/msg/PointCloud2");
    const cloud = parsePointCloud(cloudDecoder.decode(bytes("points")));
    expect(cloudDecoder.lastWarning?.()).toBeUndefined();
    const pose = tf.lookup("map", cloud.frame, cloud.stamp);
    pose.translation.forEach((v, i) => expect(v).toBeCloseTo(expected.transform.translation[i], 10));
    pose.rotation.forEach((v, i) => expect(v).toBeCloseTo(expected.transform.rotation[i], 10));
    for (let i = 0; i < cloud.count; i++) {
      const local = add(cloud.origin, Array.from(cloud.positions.slice(i * 3, i * 3 + 3)) as Vec3);
      const world = add(pose.translation, rotate(pose.rotation, local));
      world.forEach((v, axis) => expect(v).toBeCloseTo(expected.world_points[i][axis], 4));
    }
    const clock = await buildRos2StaticDecoder("rosgraph_msgs/msg/Clock");
    expect(clock.decode(bytes("clock"))).toEqual({ clock: { sec: 1002, nanosec: 0 } });
  });
});
