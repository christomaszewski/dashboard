import { describe, expect, it } from "vitest";
import { parseHome } from "../config/schema";
import { getWidget } from "../widgets/registry";

const parse = (over: Record<string, unknown>) => parseHome({ widgets: [{ type: "preflight", ...over }] }).widgets[0];
describe("preflight config", () => {
  it("is opt-in, full-width by default, and defaults to discovered health", () => {
    expect(parseHome({ widgets: [] }).widgets).toEqual([]);
    expect(getWidget("preflight")?.defaultSpan).toBe("full");
    expect(parse({})).toMatchObject({ ok: true, widget: { display: "pills", poll_s: 3, recording_controls: false,
      groups: [{ label: "Services", checks: [{ type: "health" }] }] } });
  });
  it("preserves explicit groups, checks, labels, domain and layout placement", () => {
    const groups = [
      { label: "Services", checks: [{ type: "health", service: "1/ins", components: ["gps"], label: "GPS" }] },
      { label: "Logging", checks: [{ type: "bag_recording", recorder: "/bag/recorder", domain_id: 4 }, { type: "camera_recording", service: "cam0" }] },
      { label: "Control", checks: [{ type: "ros_service", service: "/ouster/get_config", domain_id: 4 }] },
    ];
    expect(parse({ display: "dots", span: 2, poll_s: 5, recording_controls: true, groups })).toMatchObject({ ok: true, widget: { display: "dots", span: 2, poll_s: 5, recording_controls: true, groups } });
  });
  it.each([
    { groups: [] }, { groups: "oops" }, { groups: [{ label: "X", checks: [] }] },
    { groups: [{ label: "X", checks: [{ type: "camera_recording" }] }] },
    { groups: [{ label: "X", checks: [{ type: "ros_service", service: "relative" }] }] },
    { groups: [{ label: "X", checks: [{ type: "bag_recording", recorder: "/logger", domain_id: -1 }] }] },
    { groups: [{ label: "X", checks: [{ type: "health", components: "gps" }] }] },
    { groups: [{ label: "X", checks: [{ type: "typo" }] }] },
    { groups: [{ label: "X", checks: [{ type: "health", services: ["ouster"] }] }] },
    { display: "large" }, { poll_s: 0 }, { poll_s: "3" }, { poll_s: Infinity }, { recording_controls: "true" },
  ])("rejects invalid config in place: %j", (over) => {
    const home = parseHome({ widgets: [{ type: "preflight", ...over }, { type: "preflight" }] });
    expect(home.widgets[0]).toMatchObject({ ok: false });
    expect(home.widgets[1].ok).toBe(true);
    expect(home.fatal).toBeUndefined();
  });
});
