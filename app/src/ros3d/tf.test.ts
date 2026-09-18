import { describe, expect, it } from "vitest";
import { TfBuffer, readTransform, type TransformSample } from "./tf";
import { compose, inverse, rotate, stampNs, type Vec3 } from "./math";
const sample = (parent: string, child: string, stamp: bigint, x = 0, yaw = 0): TransformSample => ({ parent, child, stamp,
  translation: [x, 0, 0], rotation: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)] });
function closeVector(actual: Vec3, expected: Vec3) { actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8)); }
describe("timestamped TF", () => {
  it("composes child-to-parent transforms and inverses in the correct direction", () => {
    const tf = new TfBuffer();
    tf.insert(sample("world", "base", 1n, 10, Math.PI / 2), true);
    tf.insert(sample("base", "sensor", 1n, 2), true);
    const pose = tf.lookup("world", "sensor", 50n);
    closeVector(pose.translation, [10, 2, 0]); closeVector(rotate(pose.rotation, [1, 0, 0]), [0, 1, 0]);
    closeVector(compose(tf.lookup("sensor", "world", 50n), pose).translation, [0, 0, 0]);
    closeVector(inverse(pose).translation, [-2, 10, 0]);
  });
  it("interpolates translation and quaternion at the cloud stamp with nanosecond precision", () => {
    const tf = new TfBuffer(); const t = 1_700_000_000_000_000_000n;
    tf.insert(sample("map", "base", t, 0, 0), false); tf.insert(sample("map", "base", t + 2n, 2, Math.PI), false);
    const pose = tf.lookup("map", "base", t + 1n);
    closeVector(pose.translation, [1, 0, 0]); closeVector(rotate(pose.rotation, [1, 0, 0]), [0, 1, 0]);
    expect(stampNs({ sec: 1_700_000_000, nanosec: 1 })).toBe(t + 1n);
  });
  it("accepts out of order updates, bounds history, and refuses extrapolation", () => {
    const tf = new TfBuffer(10n, 3);
    for (const t of [10n, 14n, 12n, 16n]) tf.insert(sample("map", "sensor", t, Number(t)), false);
    expect(tf.frames()[0].samples).toBe(3);
    expect(() => tf.lookup("map", "sensor", 10n)).toThrow(/oldest/);
    expect(() => tf.lookup("map", "sensor", 17n)).toThrow(/latest/);
    expect(tf.lookup("map", "sensor", 13n).translation[0]).toBe(13);
  });
  it("does not require time coverage above the common ancestor", () => {
    const tf = new TfBuffer(); tf.insert(sample("map", "base", 10n), false);
    tf.insert(sample("base", "left", 0n, 1), true); tf.insert(sample("base", "right", 0n, -1), true);
    expect(tf.lookup("right", "left", 100n).translation[0]).toBe(2);
  });
  it("resolves latest COMMON time instead of combining latest edges", () => {
    const tf = new TfBuffer();
    for (const t of [10n, 20n]) tf.insert(sample("world", "base", t, Number(t)), false);
    for (const t of [10n, 15n]) tf.insert(sample("base", "sensor", t, Number(t)), false);
    expect(tf.latest("world", "sensor")).toMatchObject({ stamp: 15n, transform: { translation: [30, 0, 0] } });
  });
  it("rejects parent interpolation, cycles, disconnected trees and invalid quaternions", () => {
    const tf = new TfBuffer(); tf.insert(sample("a", "sensor", 1n), false); tf.insert(sample("b", "sensor", 3n), false);
    expect(() => tf.lookup("a", "sensor", 2n)).toThrow(/parent changed/);
    tf.clear(); tf.insert(sample("a", "b", 0n), true); tf.insert(sample("b", "a", 0n), true);
    expect(() => tf.lookup("a", "b", 1n)).toThrow(/cycle/);
    tf.clear(); tf.insert(sample("a", "b", 0n), true); tf.insert(sample("c", "d", 0n), true);
    expect(() => tf.lookup("a", "d", 1n)).toThrow(/no TF path/);
    expect(() => readTransform({ header: { frame_id: "a", stamp: { sec: 1, nanosec: 0 } }, child_frame_id: "b",
      transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 0 } } })).toThrow(/quaternion/);
  });
  it("merges static batches, detects ownership conflicts, and retains statics on a time reset", () => {
    const tf = new TfBuffer(); tf.insert(sample("world", "base", 0n), true); tf.insert(sample("base", "sensor", 0n, 3), true);
    tf.insert(sample("sensor", "moving", 1n), false); tf.clear(true);
    expect(tf.lookup("world", "sensor", 999n).translation[0]).toBe(3);
    expect(tf.names()).not.toContain("moving");
    tf.insert(sample("base", "sensor", 2n, 4), false);
    expect(() => tf.lookup("base", "sensor", 2n)).toThrow(/static and dynamic/);
  });
});
