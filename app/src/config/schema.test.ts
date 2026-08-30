import { describe, expect, it } from "vitest";
import { parseDashboardConfig, parseHome } from "./schema";

const FULL = `
service: dashboard
name: dash-1
web_port: 8081
ws_port: 10001
home:
  version: 1
  title: Mission Overview
  widgets:
    - type: status
      label: Front camera
      source: stream
      stream: cam0
    - type: status
      label: Nav node
      source: node
      node: /navsat_transform
    - type: status
      label: IMU rate
      source: topic_hz
      topic: /imu/data
      min_hz: 90
    - type: service_button
      label: Start recording
      service: /recorder/start
      confirm: true
      timeout_s: 3
      request:
        data: true
    - type: video
      stream: cam0
      span: full
    - type: topic_value
      label: Battery
      topic: /battery_state
      field: voltage
      precision: 1
      unit: V
      warn_below: 22.0
      err_below: 20.0
`;

describe("parseDashboardConfig", () => {
  it("parses the flat instance keys and a full home block", () => {
    const cfg = parseDashboardConfig(FULL);
    expect(cfg).toMatchObject({ name: "dash-1", web_port: 8081, ws_port: 10001 });
    expect(cfg.home?.fatal).toBeUndefined();
    expect(cfg.home?.title).toBe("Mission Overview");
    const widgets = cfg.home!.widgets;
    expect(widgets).toHaveLength(6);
    expect(widgets.every((w) => w.ok)).toBe(true);
    expect(widgets[0]).toMatchObject({ ok: true, widget: { type: "status", source: "stream", stream: "cam0" } });
    expect(widgets[3]).toMatchObject({
      ok: true,
      widget: { type: "service_button", service: "/recorder/start", confirm: true, timeout_s: 3, request: { data: true } },
    });
    expect(widgets[4]).toMatchObject({ ok: true, widget: { type: "video", span: "full" } });
    expect(widgets[5]).toMatchObject({
      ok: true,
      widget: { type: "topic_value", field: "voltage", warn_below: 22.0, err_below: 20.0 },
    });
  });

  it("handles a config with no home block", () => {
    const cfg = parseDashboardConfig("service: dashboard\nname: d\nweb_port: 8080\nws_port: 10000\n");
    expect(cfg.home).toBeUndefined();
    expect(cfg.ws_port).toBe(10000);
  });

  it("throws only on unparseable YAML", () => {
    expect(() => parseDashboardConfig("a: [unclosed")).toThrow();
  });
});

describe("parseHome widget isolation", () => {
  it("one malformed widget errors in place; the rest still parse", () => {
    const home = parseHome({
      widgets: [
        { type: "status", label: "A", source: "node", node: "/a" },
        { type: "status", label: "B", source: "topic_hz" }, // missing topic
        { type: "video", stream: "cam0" },
      ],
    });
    expect(home.fatal).toBeUndefined();
    expect(home.widgets[0].ok).toBe(true);
    expect(home.widgets[1]).toMatchObject({ ok: false, index: 1 });
    if (!home.widgets[1].ok) expect(home.widgets[1].message).toMatch(/widgets\[1\] \(status\): 'topic' is required/);
    expect(home.widgets[2].ok).toBe(true);
  });

  it("rejects unknown widget types with a positioned message", () => {
    const home = parseHome({ widgets: [{ type: "dial", label: "X" }] });
    expect(home.widgets[0]).toMatchObject({ ok: false });
    if (!home.widgets[0].ok) expect(home.widgets[0].message).toMatch(/unknown widget type 'dial'/);
  });

  it("rejects a non-mapping widget and a bad source", () => {
    const home = parseHome({ widgets: ["nope", { type: "status", label: "S", source: "carrier_pigeon" }] });
    expect(home.widgets.filter((w) => !w.ok)).toHaveLength(2);
  });

  it("unsupported version is fatal (banner + default Home), widgets dropped", () => {
    const home = parseHome({ version: 2, widgets: [{ type: "video", stream: "cam0" }] });
    expect(home.fatal).toMatch(/version 2/);
    expect(home.widgets).toHaveLength(0);
  });

  it("widgets that is not a list is fatal", () => {
    expect(parseHome({ widgets: "cam0" }).fatal).toMatch(/must be a list/);
  });

  it("missing widgets list is an empty (non-fatal) home", () => {
    const home = parseHome({ title: "T" });
    expect(home.fatal).toBeUndefined();
    expect(home.widgets).toHaveLength(0);
  });
});
