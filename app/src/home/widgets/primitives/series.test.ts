import { describe, expect, it } from "vitest";
import { SeriesBuffer, seriesPath } from "./series";

describe("SeriesBuffer", () => {
  it("keeps only the window and the point cap", () => {
    const b = new SeriesBuffer(1000, 3);
    b.push(0, 1);
    b.push(100, 2);
    b.push(200, 3);
    b.push(300, 4); // cap 3 → drops t=0
    expect(b.points.map((p) => p.v)).toEqual([2, 3, 4]);
    b.push(1500, 5); // window 1000 → drops everything older than 500
    expect(b.points.map((p) => p.v)).toEqual([5]);
    expect(b.last?.v).toBe(5);
  });

  it("ignores non-finite samples", () => {
    const b = new SeriesBuffer(1000);
    b.push(0, NaN);
    b.push(1, Infinity);
    expect(b.points).toHaveLength(0);
  });
});

describe("seriesPath", () => {
  it("scales x over the time span and y over the padded value range", () => {
    const p = seriesPath(
      [
        { t: 0, v: 0 },
        { t: 50, v: 10 },
        { t: 100, v: 5 },
      ],
      100,
      20,
    );
    expect(p).not.toBeNull();
    expect(p!.min).toBeCloseTo(-0.5);
    expect(p!.max).toBeCloseTo(10.5);
    expect(p!.d.startsWith("M0.0 ")).toBe(true);
    expect(p!.d).toContain("L100.0 ");
  });

  it("draws a flat line mid-height and honors overrides", () => {
    const flat = seriesPath([{ t: 0, v: 5 }, { t: 10, v: 5 }], 100, 20)!;
    expect(flat.d).toBe("M0.0 10.0 L100.0 10.0");
    const fixed = seriesPath([{ t: 0, v: 50 }], 100, 20, 0, 100)!;
    expect(fixed).toMatchObject({ min: 0, max: 100 });
    expect(fixed.d).toBe("M100.0 10.0"); // single point sits at the right edge
  });

  it("returns null for no points", () => {
    expect(seriesPath([], 10, 10)).toBeNull();
  });
});
