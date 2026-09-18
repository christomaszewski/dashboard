import { describe, expect, it } from "vitest";
import { pluckField } from "./pluck";

describe("pluckField", () => {
  const msg = {
    voltage: 24.1,
    pose: { pose: { position: { x: 1.5, y: -2 } } },
    ranges: new Float32Array([0.5, 1.5, 2.5]),
    names: ["a", "b"],
  };

  it("plucks top-level and nested fields", () => {
    expect(pluckField(msg, "voltage")).toBe(24.1);
    expect(pluckField(msg, "pose.pose.position.x")).toBe(1.5);
  });

  it("indexes arrays and TypedArrays with numeric segments", () => {
    expect(pluckField(msg, "ranges.1")).toBe(1.5);
    expect(pluckField(msg, "names.0")).toBe("a");
  });

  it("returns undefined anywhere the path does not apply", () => {
    expect(pluckField(msg, "nope")).toBeUndefined();
    expect(pluckField(msg, "voltage.x")).toBeUndefined();
    expect(pluckField(msg, "pose.pose.orientation.w")).toBeUndefined();
    expect(pluckField(null, "a")).toBeUndefined();
  });
});
