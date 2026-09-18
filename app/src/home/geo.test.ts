import { describe, expect, it } from "vitest";
import { extractHeading, extractLatLon } from "./geo";

describe("extractLatLon", () => {
  it("extracts NavSatFix-style top-level fields", () => {
    expect(extractLatLon({ latitude: 42.36, longitude: -71.06 }, "latitude", "longitude")).toEqual({
      lat: 42.36,
      lon: -71.06,
    });
  });

  it("extracts nested dot-path fields", () => {
    const msg = { fix: { position: { lat: 1.5, lon: 2.5 } } };
    expect(extractLatLon(msg, "fix.position.lat", "fix.position.lon")).toEqual({ lat: 1.5, lon: 2.5 });
  });

  it("rejects no-fix values: NaN, missing fields, null island, out-of-range", () => {
    expect(extractLatLon({ latitude: NaN, longitude: 1 }, "latitude", "longitude")).toBeNull();
    expect(extractLatLon({ longitude: 1 }, "latitude", "longitude")).toBeNull();
    expect(extractLatLon({ latitude: 0, longitude: 0 }, "latitude", "longitude")).toBeNull();
    expect(extractLatLon({ latitude: 91, longitude: 0 }, "latitude", "longitude")).toBeNull();
    expect(extractLatLon({ latitude: 45, longitude: 181 }, "latitude", "longitude")).toBeNull();
    expect(extractLatLon({ latitude: "42", longitude: 1 }, "latitude", "longitude")).toBeNull();
  });

  it("accepts bigint fields", () => {
    expect(extractLatLon({ latitude: 42n, longitude: -71n }, "latitude", "longitude")).toEqual({ lat: 42, lon: -71 });
  });
});

describe("extractHeading", () => {
  const imu = (yaw: number) => ({ orientation: { x: 0, y: 0, z: Math.sin(yaw * Math.PI / 360), w: Math.cos(yaw * Math.PI / 360) } });
  it("converts ROS ENU yaw to a clockwise compass bearing", () => {
    for (const [yaw, bearing] of [[0, 90], [90, 0], [180, 270], [-90, 180]])
      expect(extractHeading(imu(yaw))).toBeCloseTo(bearing);
  });
  it("supports NED, nested quaternion fields and a clockwise mounting/heading offset", () => {
    expect(extractHeading(imu(0), { orientation_frame: "ned" })).toBe(0);
    expect(extractHeading(imu(90), { orientation_frame: "ned" })).toBeCloseTo(90);
    expect(extractHeading({ pose: { orientation: imu(90).orientation } }, {
      orientation_field: "pose.orientation", heading_offset_deg: -10,
    })).toBeCloseTo(350);
  });
  it("normalizes non-unit quaternions and rejects unavailable/invalid orientation", () => {
    expect(extractHeading({ orientation: { x: 0, y: 0, z: 0, w: 5 } })).toBe(90);
    expect(extractHeading({ ...imu(0), orientation_covariance: new Float64Array([-1, 0, 0, 0, 0, 0, 0, 0, 0]) })).toBeNull();
    expect(extractHeading({ ...imu(0), orientation_covariance: Array(9).fill(0) })).toBe(90);
    for (const orientation of [null, {}, { x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: NaN, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: "1" }])
      expect(extractHeading({ orientation })).toBeNull();
    expect(extractHeading(undefined)).toBeNull();
  });
  it("uses the forward axis with roll/pitch and rejects a vertical forward axis", () => {
    // Pure roll leaves the forward axis pointing east; 90-degree pitch makes bearing undefined.
    expect(extractHeading({ orientation: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } })).toBeCloseTo(90);
    expect(extractHeading({ orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } })).toBeNull();
  });
});
