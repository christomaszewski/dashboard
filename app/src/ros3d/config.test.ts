import { describe, expect, it } from "vitest";
import { parseDashboardConfig, visibleTabs } from "../config/schema";
import { parseSceneOverrides, sceneConfig } from "./config";
describe("3D configuration", () => {
  it("registers a pointcloud widget and opt-in tab sharing scene defaults", () => {
    const c = parseDashboardConfig("tabs: [ros3d]\nros3d:\n  fixed_frame: odom\n  displays:\n    - topic: /ouster/points\n      history_s: 5\nhome:\n  version: 1\n  widgets:\n    - type: pointcloud\n      label: Lidar\n");
    expect(visibleTabs(c.tabs)).toEqual(["home", "ros3d"]); expect(c.home?.widgets[0].ok).toBe(true);
    expect(sceneConfig(c.ros3d).displays[0].history_s).toBe(5);
  });
  it("isolates invalid scene and widget settings", () => {
    const c = parseDashboardConfig("ros3d: { max_points: -1 }\nhome:\n  version: 1\n  widgets:\n    - { type: pointcloud, tf_wait_ms: 0 }\n    - { type: pointcloud }\n");
    expect(c.ros3d_error).toMatch(/max_points/); expect(c.home?.widgets.map((w) => w.ok)).toEqual([false, true]);
    expect(() => parseSceneOverrides({ displays: [{ id: "x", topic: "/a" }, { id: "x", topic: "/b" }] })).toThrow(/unique/);
  });
  it("keeps replay controls an independently opted-in widget", () => {
    const c = parseDashboardConfig("home:\n  version: 1\n  widgets:\n    - { type: rosbag_playback, domain_id: 3, service: /player }\n    - { type: rosbag_playback, domain_id: -1 }\n");
    expect(c.home?.widgets.map((w) => w.ok)).toEqual([true, false]);
    expect(visibleTabs(c.tabs)).toEqual(["home"]);
  });
});
