import { describe, expect, it } from "vitest";
import { SceneTime } from "./time";
import { rosTimeInput } from "./playback";
describe("ROS scene time", () => {
  it("holds paused time and resets for loops and external forward seeks", () => {
    const time = new SceneTime("ros_clock");
    time.update(100_000_000_000n, 0); time.update(100_000_000_000n, 10000);
    expect(time.epoch).toBe(0); time.update(10_000_000_000n, 10100); expect(time.epoch).toBe(1);
    time.update(50_000_000_000n, 10200); expect(time.epoch).toBe(2);
  });
  it("does not let ordinary cloud reordering reset the clock", () => {
    const time = new SceneTime("live"); time.observeCloud(20n); time.observeCloud(10n);
    expect(time.stamp).toBe(20n); expect(time.epoch).toBe(0);
  });
  it("parses seek nanoseconds without rounding an epoch-sized float", () => {
    expect(rosTimeInput("1700000000.000000001")).toEqual({ sec: 1700000000, nanosec: 1 });
    expect(() => rosTimeInput("NaN")).toThrow(); expect(() => rosTimeInput("1.1234567890")).toThrow();
  });
});
