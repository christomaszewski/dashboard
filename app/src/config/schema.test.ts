import { describe, expect, it } from "vitest";
import { isPanelWidget, parseDashboardConfig, parseHome, parseLayout, parseTabs } from "./schema";

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

  it("camera: controls defaults to auto, an unknown value is that widget's error, stream is required", () => {
    const home = parseHome({
      widgets: [
        { type: "camera", stream: "cam0", run_id: "survey", confirm: true },
        { type: "camera", stream: "cam0", controls: "record" },
        { type: "camera", stream: "cam0", controls: "scrub" },
        { type: "camera", label: "no stream" },
      ],
    });
    expect(home.widgets[0]).toMatchObject({
      ok: true,
      widget: { type: "camera", stream: "cam0", controls: "auto", run_id: "survey", confirm: true },
    });
    expect(home.widgets[1]).toMatchObject({ ok: true, widget: { controls: "record" } });
    expect(home.widgets[2]).toMatchObject({ ok: false, index: 2 });
    if (!home.widgets[2].ok) expect(home.widgets[2].message).toMatch(/controls.*auto \| record \| playback \| none.*scrub/);
    expect(home.widgets[3]).toMatchObject({ ok: false, index: 3 });
    if (!home.widgets[3].ok) expect(home.widgets[3].message).toMatch(/'stream' is required/);
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

  it("back-compat: a layout-free config yields no layout/warning fields", () => {
    const cfg = parseDashboardConfig(FULL);
    expect(cfg.home?.layout).toBeUndefined();
    expect(cfg.home?.layoutWarning).toBeUndefined();
    expect(cfg.home?.widgets.every((w) => w.ok && w.warning === undefined)).toBe(true);
  });
});

describe("parseTabs", () => {
  it("keeps boolean overrides, ignores junk values and unknown keys", () => {
    expect(parseTabs({ debug: false, clouds: true, cameras: "yes", future_tab: false })).toEqual({
      debug: false,
      clouds: true,
    });
  });

  it("rejects non-mapping values", () => {
    expect(parseTabs(["debug"])).toBeUndefined();
    expect(parseTabs("debug")).toBeUndefined();
  });

  it("flows through parseDashboardConfig", () => {
    const cfg = parseDashboardConfig("name: d\ntabs:\n  debug: false\n");
    expect(cfg.tabs).toEqual({ debug: false });
  });
});

describe("map widget", () => {
  it("parses with defaults left to the renderer", () => {
    const home = parseHome({ widgets: [{ type: "map", topic: "/gnss/fix" }] });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { type: "map", topic: "/gnss/fix" } });
  });

  it("parses the full option set", () => {
    const home = parseHome({
      widgets: [
        {
          type: "map",
          label: "Position",
          topic: "/gnss/fix",
          lat_field: "fix.lat",
          lon_field: "fix.lon",
          tiles: "/tiles/{z}/{x}/{y}.png",
          zoom: 15,
          trail: 200,
          follow: false,
          attribution: "© local",
        },
      ],
    });
    expect(home.widgets[0]).toMatchObject({
      ok: true,
      widget: { tiles: "/tiles/{z}/{x}/{y}.png", zoom: 15, trail: 200, follow: false, lat_field: "fix.lat" },
    });
  });

  it("requires topic and a well-formed tiles template", () => {
    const noTopic = parseHome({ widgets: [{ type: "map" }] });
    if (!noTopic.widgets[0].ok) expect(noTopic.widgets[0].message).toMatch(/'topic' is required/);
    const badTiles = parseHome({ widgets: [{ type: "map", topic: "/f", tiles: "https://x/{z}/{x}.png" }] });
    if (!badTiles.widgets[0].ok) expect(badTiles.widgets[0].message).toMatch(/XYZ template/);
    const noneTiles = parseHome({ widgets: [{ type: "map", topic: "/f", tiles: "none" }] });
    expect(noneTiles.widgets[0].ok).toBe(true);
    expect(noTopic.widgets[0].ok).toBe(false);
    expect(badTiles.widgets[0].ok).toBe(false);
  });

  it("is not allowed inside a panel", () => {
    const home = parseHome({ widgets: [{ type: "panel", items: [{ type: "map", topic: "/f" }] }] });
    const pw = home.widgets[0];
    if (!pw.ok || !isPanelWidget(pw.widget)) throw new Error("expected a panel");
    expect(pw.widget.items[0].ok).toBe(false);
    if (!pw.widget.items[0].ok) expect(pw.widget.items[0].message).toMatch(/'map' is not allowed inside a panel/);
  });
});

describe("lifecycle widget", () => {
  it("parses as a home widget and as a panel item", () => {
    const home = parseHome({
      widgets: [
        { type: "lifecycle", label: "Front cam recorder", service: "cam0", confirm: true, run_id: "survey" },
        { type: "panel", title: "Recorders", items: [{ type: "lifecycle", service: "veh1/cam1" }] },
      ],
    });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { type: "lifecycle", service: "cam0", confirm: true, run_id: "survey" } });
    const panel = home.widgets[1];
    if (!panel.ok || !isPanelWidget(panel.widget)) throw new Error("expected a panel");
    expect(panel.widget.items[0]).toMatchObject({ ok: true, item: { type: "lifecycle", service: "veh1/cam1" } });
  });

  it("requires service", () => {
    const home = parseHome({ widgets: [{ type: "lifecycle", label: "x" }] });
    expect(home.widgets[0].ok).toBe(false);
    if (!home.widgets[0].ok) expect(home.widgets[0].message).toMatch(/'service' is required/);
  });
});

describe("declarative primitives", () => {
  it("gauge: min defaults to 0, max is required and must exceed min", () => {
    const ok = parseHome({ widgets: [{ type: "gauge", label: "Batt", topic: "/b", field: "percentage", max: 100, unit: "%" }] });
    expect(ok.widgets[0]).toMatchObject({ ok: true, widget: { type: "gauge", min: 0, max: 100, unit: "%" } });
    const noMax = parseHome({ widgets: [{ type: "gauge", label: "B", topic: "/b", field: "f" }] });
    if (!noMax.widgets[0].ok) expect(noMax.widgets[0].message).toMatch(/'max' is required/);
    const inverted = parseHome({ widgets: [{ type: "gauge", label: "B", topic: "/b", field: "f", min: 10, max: 5 }] });
    if (!inverted.widgets[0].ok) expect(inverted.widgets[0].message).toMatch(/'max' must be greater than 'min'/);
    expect(noMax.widgets[0].ok).toBe(false);
    expect(inverted.widgets[0].ok).toBe(false);
  });

  it("sparkline: optional window/range with sanity checks", () => {
    const ok = parseHome({ widgets: [{ type: "sparkline", label: "Spd", topic: "/odom", field: "twist.twist.linear.x", window_s: 30, min: 0, max: 5 }] });
    expect(ok.widgets[0]).toMatchObject({ ok: true, widget: { type: "sparkline", window_s: 30, min: 0, max: 5 } });
    const bad = parseHome({ widgets: [{ type: "sparkline", label: "S", topic: "/o", field: "f", window_s: 0 }] });
    expect(bad.widgets[0].ok).toBe(false);
  });

  it("indicator: rules are validated per rule, default is optional", () => {
    const ok = parseHome({
      widgets: [
        {
          type: "indicator",
          label: "Armed",
          topic: "/mavros/state",
          field: "armed",
          rules: [
            { equals: true, level: "ok", text: "ARMED" },
            { equals: false, level: "idle", text: "disarmed" },
          ],
          default: { level: "warn", text: "?" },
        },
      ],
    });
    expect(ok.widgets[0]).toMatchObject({ ok: true, widget: { type: "indicator", rules: [{ equals: true, level: "ok" }, { equals: false }], default: { level: "warn", text: "?" } } });
    const badRule = parseHome({ widgets: [{ type: "indicator", label: "A", topic: "/t", field: "f", rules: [{ equals: 1 }] }] });
    if (!badRule.widgets[0].ok) expect(badRule.widgets[0].message).toMatch(/rules\[0\]: 'level' must be one of/);
    const noRules = parseHome({ widgets: [{ type: "indicator", label: "A", topic: "/t", field: "f" }] });
    if (!noRules.widgets[0].ok) expect(noRules.widgets[0].message).toMatch(/'rules' is required/);
    expect(badRule.widgets[0].ok).toBe(false);
    expect(noRules.widgets[0].ok).toBe(false);
  });

  it("text: requires text; all four primitives are panel-capable", () => {
    const home = parseHome({
      widgets: [
        {
          type: "panel",
          items: [
            { type: "text", text: "Radio ch 7" },
            { type: "gauge", label: "B", topic: "/b", field: "f", max: 1 },
            { type: "sparkline", label: "S", topic: "/o", field: "f" },
            { type: "indicator", label: "I", topic: "/t", field: "f", rules: [{ above: 0, level: "ok" }] },
          ],
        },
        { type: "text" },
      ],
    });
    const panel = home.widgets[0];
    if (!panel.ok || !isPanelWidget(panel.widget)) throw new Error("expected a panel");
    expect(panel.widget.items.every((i) => i.ok)).toBe(true);
    expect(home.widgets[1].ok).toBe(false);
    if (!home.widgets[1].ok) expect(home.widgets[1].message).toMatch(/'text' is required/);
  });
});

describe("parseLayout", () => {
  it("accepts a valid areas grid + matching columns", () => {
    const { layout, warning } = parseLayout({
      columns: "2fr 1fr 1fr",
      areas: ["cams cams power", "cams cams nav", "ctrl ctrl nav"],
    });
    expect(warning).toBeUndefined();
    expect(layout).toEqual({
      columns: "2fr 1fr 1fr",
      areas: ["cams cams power", "cams cams nav", "ctrl ctrl nav"],
      areaNames: ["cams", "power", "nav", "ctrl"],
      columnCount: 3,
    });
  });

  it("treats '.' (and '...') as empty cells and normalizes whitespace", () => {
    const { layout, warning } = parseLayout({ areas: ["a   .  b", "a ... b"] });
    expect(warning).toBeUndefined();
    expect(layout?.areas).toEqual(["a . b", "a ... b"]);
    expect(layout?.areaNames).toEqual(["a", "b"]);
  });

  it("drops non-rectangular areas with a positioned warning", () => {
    const { layout, warning } = parseLayout({ areas: ["a a b", "a a"] });
    expect(layout).toBeUndefined();
    expect(warning).toMatch(/not rectangular: row 1 has 2 cells, expected 3/);
  });

  it("drops areas whose name is not a solid rectangle (L-shape / hole)", () => {
    expect(parseLayout({ areas: ["a a", "a b"] }).warning).toMatch(/'a' does not form a solid rectangle/);
    expect(parseLayout({ areas: ["a b a"] }).warning).toMatch(/'a' does not form a solid rectangle/);
  });

  it("rejects invalid and CSS-reserved area names", () => {
    expect(parseLayout({ areas: ["1bad ok"] }).warning).toMatch(/invalid area name '1bad'/);
    expect(parseLayout({ areas: ["auto x"] }).warning).toMatch(/invalid area name 'auto'/);
  });

  it("validates columns independently of areas", () => {
    const { layout, warning } = parseLayout({ columns: "1fr [main] 2fr", areas: ["a b"] });
    expect(warning).toMatch(/unsupported characters/);
    expect(layout?.areas).toEqual(["a b"]); // areas survive a bad columns
    expect(layout?.columns).toBeUndefined();
  });

  it("cross-checks the track count against the areas column count", () => {
    const { layout, warning } = parseLayout({ columns: "1fr 2fr", areas: ["a b c"] });
    expect(warning).toMatch(/2 tracks but areas define 3 columns/);
    expect(layout?.columns).toBeUndefined();
    // repeat()/minmax() forms skip the count check
    const ok = parseLayout({ columns: "repeat(3, minmax(0, 1fr))", areas: ["a b c"] });
    expect(ok.warning).toBeUndefined();
    expect(ok.layout?.columns).toBe("repeat(3, minmax(0, 1fr))");
  });

  it("allows columns without areas (fixed tracks, flowed widgets)", () => {
    const { layout, warning } = parseLayout({ columns: "1fr 1fr" });
    expect(warning).toBeUndefined();
    expect(layout).toEqual({ columns: "1fr 1fr", areas: undefined, areaNames: [], columnCount: 0 });
  });
});

describe("widget area post-pass", () => {
  const LAYOUT = { areas: ["cams side"] };
  const video = (area?: string) => ({ type: "video", stream: "cam0", area });

  it("blesses areas defined in the layout", () => {
    const home = parseHome({ layout: LAYOUT, widgets: [video("cams")] });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { area: "cams" } });
    if (home.widgets[0].ok) expect(home.widgets[0].warning).toBeUndefined();
  });

  it("strips an undefined area with a warning; widget auto-flows", () => {
    const home = parseHome({ layout: LAYOUT, widgets: [video("nope")] });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { area: undefined } });
    if (home.widgets[0].ok) expect(home.widgets[0].warning).toMatch(/'nope' is not defined/);
  });

  it("strips area when no layout.areas exists at all", () => {
    const home = parseHome({ widgets: [video("cams")] });
    if (home.widgets[0].ok) expect(home.widgets[0].warning).toMatch(/home.layout.areas is not defined/);
  });

  it("duplicate claims: first ok widget wins, later ones auto-flow with a warning", () => {
    const home = parseHome({ layout: LAYOUT, widgets: [video("cams"), video("cams")] });
    expect(home.widgets[0]).toMatchObject({ ok: true, widget: { area: "cams" } });
    if (home.widgets[1].ok) {
      expect(home.widgets[1].widget.area).toBeUndefined();
      expect(home.widgets[1].warning).toMatch(/already used by widgets\[0\]/);
    }
  });
});

describe("panel widget", () => {
  it("parses mixed items: shorthands inherit the panel topic, name: aliases label, label defaults to field", () => {
    const home = parseHome({
      widgets: [
        {
          type: "panel",
          title: "GNSS",
          topic: "/gnss/fix",
          items: [
            { field: "latitude", name: "Lat", precision: 6 },
            { field: "status.satellites_used" },
            { field: "voltage", topic: "/battery_state", unit: "V" },
            { type: "status", label: "Nav node", source: "node", node: "/navsat" },
            { type: "service_button", label: "Re-init", service: "/gnss/reset" },
          ],
        },
      ],
    });
    const pw = home.widgets[0];
    expect(pw.ok).toBe(true);
    if (!pw.ok || !isPanelWidget(pw.widget)) throw new Error("expected a panel");
    const items = pw.widget.items;
    expect(items.every((i) => i.ok)).toBe(true);
    expect(items[0]).toMatchObject({
      ok: true,
      item: { type: "topic_value", topic: "/gnss/fix", field: "latitude", label: "Lat", precision: 6 },
    });
    expect(items[1]).toMatchObject({ ok: true, item: { label: "status.satellites_used", topic: "/gnss/fix" } });
    expect(items[2]).toMatchObject({ ok: true, item: { topic: "/battery_state", unit: "V" } });
    expect(items[3]).toMatchObject({ ok: true, item: { type: "status", source: "node" } });
    expect(items[4]).toMatchObject({ ok: true, item: { type: "service_button", service: "/gnss/reset" } });
  });

  it("isolates bad items to their row; siblings still parse", () => {
    const home = parseHome({
      widgets: [
        {
          type: "panel",
          items: [
            { field: "a", topic: "/t" },
            { type: "panel", items: [] }, // nested
            { type: "video", stream: "cam0" }, // not allowed
            { type: "dial" }, // unknown
            { name: "no field" }, // shorthand without field
            { field: "x" }, // no topic anywhere
            { type: "topic_value", label: "L", field: "f" }, // typed items do NOT inherit panel topic
          ],
        },
      ],
    });
    const pw = home.widgets[0];
    if (!pw.ok || !isPanelWidget(pw.widget)) throw new Error("expected a panel");
    const [ok, nested, video, dial, nofield, notopic, typed] = pw.widget.items;
    expect(ok.ok).toBe(true);
    if (!nested.ok) expect(nested.message).toMatch(/nested panels are not supported/);
    if (!video.ok) expect(video.message).toMatch(/'video' is not allowed/);
    if (!dial.ok) expect(dial.message).toMatch(/unknown item type 'dial'/);
    if (!nofield.ok) expect(nofield.message).toMatch(/needs a 'type' or a readout 'field'/);
    if (!notopic.ok) expect(notopic.message).toMatch(/'topic' is required \(set it on the item or on the panel\)/);
    if (!typed.ok) expect(typed.message).toMatch(/items\[6\] \(topic_value\): 'topic' is required/);
    expect([nested, video, dial, nofield, notopic, typed].every((i) => !i.ok)).toBe(true);
  });

  it("panel-level failures (missing/empty items) fail the whole widget", () => {
    const missing = parseHome({ widgets: [{ type: "panel", title: "P" }] });
    if (!missing.widgets[0].ok) expect(missing.widgets[0].message).toMatch(/'items' is required/);
    const empty = parseHome({ widgets: [{ type: "panel", items: [] }] });
    if (!empty.widgets[0].ok) expect(empty.widgets[0].message).toMatch(/'items' must not be empty/);
    expect(missing.widgets[0].ok).toBe(false);
    expect(empty.widgets[0].ok).toBe(false);
  });
});
