import { describe, expect, it } from "vitest";
import { parseDashboardConfig, parseHome, TAB_DEFAULT_VISIBLE, TAB_IDS } from "./schema";

describe("rig tab visibility", () => {
  it("is off by default, on with rig_agent: true, and tabs.rig always wins", () => {
    expect(TAB_IDS).toContain("rig");
    expect(TAB_DEFAULT_VISIBLE.rig).toBe(false);
    expect(parseDashboardConfig("name: d\n").tabs).toBeUndefined();
    expect(parseDashboardConfig("name: d\nrig_agent: true\n")).toMatchObject({ rig_agent: true, tabs: { rig: true } });
    expect(parseDashboardConfig("name: d\nrig_agent: true\ntabs:\n  debug: false\n").tabs).toEqual({ debug: false, rig: true });
    expect(parseDashboardConfig("name: d\nrig_agent: true\ntabs:\n  rig: false\n").tabs).toEqual({ rig: false });
    expect(parseDashboardConfig("name: d\ntabs:\n  rig: true\n").tabs).toEqual({ rig: true });
    expect(parseDashboardConfig("name: d\nrig_agent: nope\n").rig_agent).toBeUndefined();
  });
});

describe("rig widget", () => {
  it("parses as a home widget and as a panel item", () => {
    const home = parseHome({
      widgets: [
        { type: "rig" },
        { type: "rig", label: "Deployment", stacks: ["cam_front", "lidar"], actions: false, runs: false, confirm: true, use_run_label: false, span: 1 },
        { type: "panel", title: "Ops", items: [{ type: "rig", stacks: ["cam_front"] }] },
      ],
    });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { type: "rig", span: undefined } });
    expect(home.widgets[1]).toMatchObject({ ok: true, widget: { type: "rig", label: "Deployment", stacks: ["cam_front", "lidar"], actions: false, runs: false, confirm: true, use_run_label: false, span: 1 } });
    expect(home.widgets[2]).toMatchObject({ ok: true });
  });

  it("validates stacks", () => {
    const home = parseHome({ widgets: [{ type: "rig", stacks: "cam_front" }, { type: "rig", stacks: [1] }] });
    expect(home.widgets[0]).toMatchObject({ ok: false, message: expect.stringContaining("'stacks' must be a list") });
    expect(home.widgets[1]).toMatchObject({ ok: false });
  });
});
