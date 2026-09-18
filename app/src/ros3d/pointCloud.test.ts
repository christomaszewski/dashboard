import { describe, expect, it } from "vitest";
import { parsePointCloud } from "./pointCloud";

export function cloudMessage(options: { big?: boolean; padding?: number; float64?: boolean; invalid?: boolean } = {}) {
  const width = 3; const height = 2; const step = options.float64 ? 32 : 20; const row = width * step + (options.padding ?? 0);
  const data = new Uint8Array(row * height).fill(0xee); const view = new DataView(data.buffer); const le = !options.big;
  const xyz = options.float64 ? [16, 0, 8] : [8, 0, 4];
  for (let i = 0; i < 6; i++) {
    const start = Math.floor(i / width) * row + i % width * step;
    [i + (options.float64 ? 1e9 : 0), i * 2, options.invalid && i === 2 ? NaN : i * 3].forEach((v, axis) => {
      if (options.float64) view.setFloat64(start + xyz[axis], v, le); else view.setFloat32(start + xyz[axis], v, le);
    });
    view.setUint32(start + (options.float64 ? 24 : 12), 0xff804020, le);
    view.setUint16(start + (options.float64 ? 28 : 16), i * 100, le);
  }
  return { header: { frame_id: "test_ouster", stamp: { sec: 1000, nanosec: 1 } }, width, height, point_step: step, row_step: row,
    is_bigendian: !!options.big, is_dense: true, data, fields: [
      ...["x", "y", "z"].map((name, i) => ({ name, offset: xyz[i], datatype: options.float64 ? 8 : 7, count: 1 })),
      { name: "rgba", offset: options.float64 ? 24 : 12, datatype: 7, count: 1 },
      { name: "intensity", offset: options.float64 ? 28 : 16, datatype: 4, count: 1 },
    ] };
}
describe("PointCloud2 binary parsing", () => {
  it.each([false, true])("honors reordered fields, row padding, and endianness (%s)", (big) => {
    const cloud = parsePointCloud(cloudMessage({ big, padding: 11 }));
    expect(cloud.count).toBe(6); expect(Array.from(cloud.positions)).toEqual([0, 0, 0, 1, 2, 3, 2, 4, 6, 3, 6, 9, 4, 8, 12, 5, 10, 15]);
    expect(Array.from(cloud.colors!.slice(0, 4))).toEqual([128, 64, 32, 255]); expect(cloud.scalars.intensity[5]).toBe(500);
  });
  it("rebases FLOAT64 coordinates before float32 conversion and skips NaNs even with is_dense", () => {
    const cloud = parsePointCloud(cloudMessage({ float64: true, invalid: true }));
    expect(cloud.origin[0]).toBe(1e9); expect(cloud.count).toBe(5); expect(cloud.invalidCount).toBe(1);
    expect(Array.from(cloud.positions.slice(6, 9))).toEqual([3, 6, 9]); expect(cloud.scalars.intensity[2]).toBe(300);
  });
  it("samples across the whole cloud within its point budget", () => {
    const cloud = parsePointCloud(cloudMessage(), 3);
    expect(cloud.count).toBe(3); expect(cloud.sampledCount).toBe(3); expect(Array.from(cloud.scalars.intensity)).toEqual([0, 200, 400]);
  });
  it("rejects malformed buffers and schemas before reading", () => {
    expect(() => parsePointCloud({ ...cloudMessage(), row_step: 1 })).toThrow(/strides/);
    expect(() => parsePointCloud({ ...cloudMessage(), data: new Uint8Array(1) })).toThrow(/length/);
    const m = cloudMessage(); m.fields[0].offset = 999;
    expect(() => parsePointCloud(m)).toThrow(/out-of-bounds/);
    expect(() => parsePointCloud({ ...cloudMessage(), fields: [] })).toThrow(/requires scalar/);
  });
  it("supports Lyrical integer64/bool fields and reports unsafe numeric conversion", () => {
    const m = cloudMessage(); m.fields = m.fields.filter((f) => f.name !== "rgba" && f.name !== "intensity");
    m.fields.push({ name: "time", offset: 12, datatype: 10, count: 1 });
    const view = new DataView(m.data.buffer); for (let i = 0; i < 6; i++) view.setBigUint64(i * 20 + 12, i ? 123n : 2n ** 60n, true);
    const cloud = parsePointCloud(m); expect(cloud.scalars.time[1]).toBe(123); expect(cloud.warning).toMatch(/safe numeric/);
  });
});
