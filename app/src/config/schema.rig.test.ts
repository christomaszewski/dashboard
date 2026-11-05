import { describe, expect, it } from "vitest";
import { parseDashboardConfig, parseHome, visibleTabs, TAB_DEFAULT_VISIBLE, TAB_IDS } from "./schema";

describe("rig tab visibility", () => {
  it("is off by default, on with rig_agent: true, and tabs.rig always wins", () => {
    expect(TAB_IDS).toContain("rig");
    expect(TAB_DEFAULT_VISIBLE.rig).toBe(false);
    expect(parseDashboardConfig("name: d\n").tabs).toBeUndefined();
    expect(parseDashboardConfig("name: d\nrig_agent: true\n")).toMatchObject({ rig_agent: true, tabs: { rig: true } });
    expect(parseDashboardConfig("name: d\nrig_agent: true\ntabs:\n  debug: false\n").tabs).toEqual({ debug: false, rig: true });
    expect(parseDashboardConfig("name: d\nrig_agent: true\ntabs:\n  rig: false\n").tabs).toEqual({ rig: false });
    expect(parseDashboardConfig("name: d\ntabs:\n  rig: true\n").tabs).toEqual({ rig: true });
    expect(parseDashboardConfig("name: d\nrig_agent: nope\n").rig_agent).toBe(false);
  });

  it("infers an agent from visible Rig or Logs tabs without revealing another tab", () => {
    for (const yaml of ["tabs: [rig]", "tabs:\n  rig: true", "tabs: [logs]", "tabs: {home: false, logs: true}"]) {
      expect(parseDashboardConfig(yaml).rig_agent).toBe(true);
    }
    const logs = parseDashboardConfig("tabs: [logs]");
    expect(visibleTabs(logs.tabs)).toEqual(["home", "logs"]);
    expect(parseDashboardConfig("tabs: {rig: false, logs: false}").rig_agent).toBe(false);
    expect(parseDashboardConfig("rig_agent: false\ntabs: [rig, logs]").rig_agent).toBe(false);
    expect(parseDashboardConfig("rig_agent: true\ntabs: {rig: false}").rig_agent).toBe(true);
  });

  it("infers only valid Rig widgets that Home will render, including panel items", () => {
    const parse = (home: unknown, tabs?: unknown) => parseDashboardConfig(JSON.stringify({ home, tabs }));
    expect(parse({ widgets: [{ type: "rig" }] }).rig_agent).toBe(true);
    expect(parse({ widgets: [{ type: "panel", items: [{ type: "rig" }] }] }).rig_agent).toBe(true);
    expect(parse({ widgets: [{ type: "rig" }] }, { home: false, cameras: true }).rig_agent).toBe(false);
    // With no other visible tab, the shell restores Home.
    expect(parse({ widgets: [{ type: "rig" }] }, { home: false }).rig_agent).toBe(true);
    expect(parse({ version: 99, widgets: [{ type: "rig" }] }).rig_agent).toBe(false);
    expect(parse({ widgets: [{ type: "rig", stacks: "invalid" }] }).rig_agent).toBe(false);
    expect(parse({ widgets: [{ type: "panel", items: [{ type: "panel", items: [{ type: "rig" }] }] }] }).rig_agent).toBe(false);
    expect(parseDashboardConfig("rig_agent: false\nhome: {widgets: [{type: rig}]}").rig_agent).toBe(false);
  });

  it("keeps ordinary monitoring and recording independent of the agent", () => {
    const config = parseDashboardConfig(`tabs: [health, cameras, ros, ros3d, clouds, debug]
vehicle_state: true
home:
  widgets:
    - type: health
    - type: preflight
      recording_controls: true
      groups: []
`);
    expect(config.rig_agent).toBe(false);
    expect(parseDashboardConfig("{}").rig_agent).toBe(false);
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
