import { describe, expect, it } from "vitest";
import {
  LIMITS,
  ValueTooLarge,
  canonicalItem,
  decodeMessage,
  encodeMessage,
  itemSignature,
  project,
  quantize,
  revive,
  sparseMessage,
  validatePollRequest,
  validateViewSpec,
  viewId,
} from "./protocol";
import { pluckField } from "../home/pluck";
import { renderTemplate, parseTemplate } from "../home/template";

describe("vehicle-state protocol", () => {
  it("quantizes to the display quantum without binary noise", () => {
    expect(quantize(0.1 + 0.2, 0.001)).toBe(0.3);
    expect(quantize(37.123456789, 1e-7)).toBe(37.1234568);
    expect(quantize(-0.0001, 0.01)).toBe(0);
    expect(Object.is(quantize(-0.0001, 0.01), -0)).toBe(false);
    // The same rounding formatValue applies with no precision.
    const v = 12.34567;
    expect(quantize(v, 0.001)).toBe(Math.round(v * 1000) / 1000);
  });

  it("projects fields, tags bigint/non-finite values and round-trips them through JSON", () => {
    const msg = {
      header: { stamp: { sec: 5, nanosec: 7 } },
      latitude: NaN,
      count: 9007199254740993n,
      ranges: new Float32Array([1.25, 2.5]),
      status: { status: 2 },
    };
    const fields = [{ p: "latitude" }, { p: "count" }, { p: "ranges", q: 0.5 }, { p: "status.status" }, { p: "missing.path" }];
    const values = project(msg, fields);
    expect(values).toEqual([{ $num: "NaN" }, { $big: "9007199254740993" }, [1.5, 2.5], 2, null]);
    const wire = decodeMessage(encodeMessage(values)) as typeof values;
    const sparse = sparseMessage(fields, wire);
    expect(Number.isNaN(pluckField(sparse, "latitude"))).toBe(true);
    expect(pluckField(sparse, "count")).toBe(9007199254740993n);
    expect(pluckField(sparse, "ranges.1")).toBe(2.5);
    expect(pluckField(sparse, "status.status")).toBe(2);
    expect(pluckField(sparse, "missing.path")).toBeUndefined();
  });

  it("rebuilds sparse messages that templates render exactly like the full message", () => {
    const full = { pose: { position: { x: 1.23456, y: -2 } }, frame: "map" };
    const t = parseTemplate("{pose.position.x:.2f}, {pose.position.y} @ {frame}");
    const fields = [{ p: "pose.position.x", q: 0.01 }, { p: "pose.position.y", q: 0.001 }, { p: "frame" }];
    const sparse = sparseMessage(fields, project(full, fields));
    expect(renderTemplate(t, sparse)).toEqual(renderTemplate(t, full));
  });

  it("merges a whole object and one of its members requested separately", () => {
    const msg = { orientation: { x: 0, y: 0, z: 0.5, w: 1 } };
    const a = sparseMessage([{ p: "orientation" }, { p: "orientation.z" }], project(msg, [{ p: "orientation" }, { p: "orientation.z" }]));
    const b = sparseMessage([{ p: "orientation.z" }, { p: "orientation" }], project(msg, [{ p: "orientation.z" }, { p: "orientation" }]));
    expect(a).toEqual(msg);
    expect(b).toEqual(msg);
  });

  it("refuses to flatten huge arrays", () => {
    expect(() => project({ data: new Uint8Array(LIMITS.leaves + 1) }, [{ p: "data" }])).toThrow(ValueTooLarge);
  });

  it("revives nested tags only when they are the whole object", () => {
    expect(revive({ a: { $big: "1" }, b: { $big: "1", other: 2 } })).toEqual({ a: 1n, b: { $big: "1", other: 2 } });
  });

  it("gives equal specs the same signature and view id", () => {
    const a = { topic: "/imu", fields: [{ p: "orientation", q: 0.001 }], hz: false };
    const b = { window_ms: undefined, hz: undefined, fields: [{ q: 0.001, p: "orientation" }], topic: "/imu" };
    expect(itemSignature(a)).toBe(itemSignature(b));
    expect(canonicalItem(a)).toEqual({ topic: "/imu", fields: [{ p: "orientation", q: 0.001 }] });
    expect(viewId([a])).toBe(viewId([b]));
    expect(viewId([a])).not.toBe(viewId([a, { topic: "/gps" }]));
    expect(viewId([a])).toMatch(/^v[0-9a-f]+$/);
  });

  it("validates registrations and polls", () => {
    expect(validateViewSpec({ v: 1, items: [{ topic: "/a/b", fields: [{ p: "x.0" }], hz: true, window_ms: 2000 }] }))
      .toEqual({ v: 1, items: [{ topic: "/a/b", fields: [{ p: "x.0" }], hz: true, window_ms: 2000 }] });
    for (const bad of [
      null,
      { v: 2, items: [] },
      { v: 1, items: [{ topic: "no-slash" }] },
      { v: 1, items: [{ topic: "/a", fields: [{ p: "a..b" }] }] },
      { v: 1, items: [{ topic: "/a", fields: [{ p: "a", q: 0 }] }] },
      { v: 1, items: [{ topic: "/a", window_ms: 10 }] },
      { v: 1, items: Array.from({ length: LIMITS.items + 1 }, () => ({ topic: "/a" })) },
    ]) expect(() => validateViewSpec(bad)).toThrow();
    expect(validatePollRequest({ v: 1, view: "vabc", epoch: "e1", since: 3 })).toEqual({ v: 1, view: "vabc", epoch: "e1", since: 3 });
    for (const bad of [{ v: 1, view: "a b", epoch: "", since: 0 }, { v: 1, view: "v", epoch: "", since: -1 }, { v: 1, view: "v", epoch: "", since: 1.5 }])
      expect(() => validatePollRequest(bad)).toThrow();
  });
});
