import { describe, expect, it } from "vitest";
import { RateMonitor } from "./rate";

describe("RateMonitor", () => {
  it("needs two arrivals in the window", () => {
    const m = new RateMonitor(5000);
    expect(m.hz(0)).toBeUndefined();
    m.record(0);
    expect(m.hz(100)).toBeUndefined();
    m.record(100);
    expect(m.hz(100)).toBeCloseTo(10);
  });

  it("measures a steady rate", () => {
    const m = new RateMonitor(5000);
    for (let t = 0; t <= 1000; t += 100) m.record(t); // 11 arrivals over 1 s → 10 Hz
    expect(m.hz(1000)).toBeCloseTo(10);
  });

  it("setWindow retargets the pruning horizon", () => {
    const m = new RateMonitor(1000);
    m.record(0);
    m.record(100);
    expect(m.hz(2000)).toBeUndefined(); // outside the 1 s window
    const m2 = new RateMonitor(1000);
    m2.record(0);
    m2.record(100);
    m2.setWindow(5000);
    expect(m2.hz(2000)).toBeCloseTo(0.5); // widened window keeps them (1 interval / 2 s)
  });

  it("prunes arrivals outside the window", () => {
    const m = new RateMonitor(1000);
    m.record(0);
    m.record(100);
    m.record(5000);
    m.record(5100);
    expect(m.hz(5100)).toBeCloseTo(10); // only the two recent arrivals count
    expect(m.hz(7000)).toBeUndefined(); // window has moved past everything
  });
});
