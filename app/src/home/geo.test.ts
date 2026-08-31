import { describe, expect, it } from "vitest";
import { extractLatLon } from "./geo";

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
