// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthWidgetConfig } from "../../config/schema";
import { health, renderWith } from "../../test/harness";
import { TransportCtx } from "../../transport/TransportContext";
import { HealthWidget } from "./HealthWidget";

afterEach(() => { cleanup(); localStorage.clear(); });
const widget = (over: Partial<HealthWidgetConfig> = {}): HealthWidgetConfig => ({ type: "health", history_s: 300, precision: 1, ...over });
const gige = () => health("cam_gige", {
  camera: { message: "44.5 C", hardware_id: "Basler acA1920 sn 4", values: { "temp.sensor_c": 44.5, "temp.mainboard_c": 39, "ptp.state": "Slave" } },
  stream: { values: { "fps.delivered": 24 } },
});
const boson = () => health("cam_thermal", {
  camera: { message: "33.25 C", hardware_id: "FLIR Boson 20640A012 sn 123", values: { "temp.sensor_c": 33.25, "ffc.state": "complete" } },
  stream: { values: { "fps.delivered": 60 } },
});
const instance = (name: string) => document.querySelector<HTMLElement>(`.health-summary[data-instance="${name}"]`)!;
const rows = (root: ParentNode) => [...root.querySelectorAll(".health-summary-metric")]
  .map((r) => [r.querySelector(".health-metric-label")?.textContent, r.querySelector(".row-value")?.textContent]);

describe("HealthWidget", () => {
  it("auto-discovers native and ROS reporters, showing all temperatures and power without clutter", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), boson(), health("lidar", {
      power: { values: { "supply.power_w": 18, "supply.voltage_v": 24, "supply.current_a": 0.75 } },
    }, { source: "ros2", sourceLabel: "ROS /diagnostics" })] });
    expect(rows(instance("cam_gige"))).toEqual([["sensor", "44.5 °C"], ["mainboard", "39.0 °C"]]);
    expect(rows(instance("cam_thermal"))).toEqual([["sensor", "33.3 °C"]]);
    expect(rows(instance("lidar"))).toEqual([["power", "18.0 W"]]);
    expect(instance("cam_gige").querySelector(".health-verdict")?.textContent).toBe("OK");
    expect(document.querySelector(".health-issue")).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: /input power: 18.0 W/ }));
    expect(screen.getByRole("tooltip").textContent).toContain("supply.voltage_v24 V");
    expect(screen.getByRole("tooltip").textContent).toContain("supply.current_a0.75 A");
    expect(screen.getByRole("tooltip").textContent).toContain("ROS /diagnostics");
  });

  it("keeps explicit order, qualified identity and never-seen placeholders", () => {
    renderWith(<HealthWidget widget={widget({ services: ["1/cam_thermal", "cam_missing"] })} />, { healths: [gige(), boson()] });
    expect([...document.querySelectorAll(".health-summary")].map((n) => n.getAttribute("data-instance"))).toEqual(["cam_thermal", "cam_missing"]);
    expect(instance("cam_missing").textContent).toContain("not reported");
  });

  it("explains both discovery sources while waiting", () => {
    renderWith(<HealthWidget widget={widget()} />);
    expect(screen.getByText(/Waiting for service health or ROS 2 diagnostics/)).toBeTruthy();
    expect(screen.getByText("fleet/*/svc/*/health")).toBeTruthy();
  });

  it("shows one severity pill per issue and reveals details on hover, focus, and tap; Escape dismisses", () => {
    const hot = health("cam_gige", {
      camera: { level: 1, message: "temp.sensor_c 66 > 65", values: { "temp.sensor_c": 66 } },
      stream: { level: 2, message: "no frames for 6.0s" },
    });
    renderWith(<HealthWidget widget={widget()} />, { healths: [hot] });
    expect(instance("cam_gige").querySelector(".health-verdict")?.textContent).toBe("ERROR");
    const error = screen.getByRole("button", { name: "ERROR stream" });
    expect(error.className).toContain("err");
    expect(screen.getByRole("button", { name: "WARN camera" }).className).toContain("warn");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(error);
    expect(screen.getByRole("tooltip").textContent).toContain("no frames for 6.0s");
    expect(error.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(error);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(error);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "WARN camera" }));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toContain("temp.sensor_c 66 > 65");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("component selection narrows metrics, issues, and the verdict", () => {
    renderWith(<HealthWidget widget={widget({ components: ["camera"] })} />, { healths: [health("cam", {
      camera: { values: { "temp.sensor_c": 33 } }, stream: { level: 2, message: "frames lost" },
    })] });
    expect(instance("cam").querySelector(".health-verdict")?.textContent).toBe("OK");
    expect(document.querySelector(".health-issue")).toBeNull();
  });

  it("temperature thresholds never color watts or replace the producer verdict", () => {
    renderWith(<HealthWidget widget={widget({ warn_above: 40, err_above: 60 })} />, { healths: [health("cam", {
      camera: { values: { "temp.sensor_c": 44.5, "temp.mainboard_c": 65, "supply.power_w": 70 } },
    })] });
    expect([...instance("cam").querySelectorAll(".row-value")].map((n) => n.className)).toEqual(["row-value warn", "row-value err", "row-value ok"]);
    expect(instance("cam").querySelector(".health-verdict")?.textContent).toBe("OK");
  });

  it("retains offline/silent readings explicitly marked last known, and preserves last fault severity", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("cam", {
      camera: { level: 3, message: "poll failed", values: { "health.last_level": 2, "temp.sensor_c": 47 } },
    }, { alive: false }), { ...boson(), receivedAtMs: Date.now() - 20_000 }] });
    expect(instance("cam").querySelector(".health-verdict")?.textContent).toBe("ERROR · offline");
    expect(instance("cam").querySelector(".health-issue")?.className).toContain("err");
    expect(instance("cam").querySelector(".row-value")?.className).toContain("idle");
    expect(instance("cam").textContent).toContain("last known");
    expect(instance("cam_thermal").querySelector(".health-verdict")?.textContent).toMatch(/^silent 2\ds$/);
    expect(rows(instance("cam_thermal"))).toEqual([["sensor", "33.3 °C"]]);
  });

  it("distinguishes unavailable metrics, unsupported metrics, and genuine zero", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("cam", { camera: { values: {
      "temp.sensor_c": null, "supply.power_w": 0, "temp.board_c": null,
      "health.metric.temp.board_c.state": "unsupported",
    } } })] });
    expect(rows(instance("cam"))).toEqual([["sensor", "— °C"], ["power", "0.0 W"]]);
    expect(instance("cam").textContent).toContain("unavailable");
  });

  it("retains vendor codes/notices, hides cleared alerts and duplicate alert summaries", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("top", {
      alerts: { level: 2, message: "2 active", values: { "alerts.active": 2 } },
      "alert/POWER_LOW": { level: 2, message: "voltage low", values: { "alert.active": true, "alert.code": "POWER_LOW", "alert.category": "POWER", "alert.detail": "Check cable" } },
      "alert/BOOT": { level: 0, values: { "alert.active": true, "alert.code": "BOOT", "alert.severity": "NOTICE" } },
      "alert/HOT": { level: 0, values: { "alert.active": false, "alert.code": "HOT" } },
    })] });
    expect([...document.querySelectorAll(".health-issue")].map((e) => e.textContent)).toEqual(["ERRORPOWER_LOW", "INFOBOOT"]);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ERROR POWER_LOW" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Check cable");
    expect(screen.getByRole("tooltip").textContent).toContain("POWER");
  });

  it("draws temperature and power history with a hover range; history_s=0 disables it", () => {
    const healthSeries = { "cam_gige/temp.sensor_c": [40, 42, 44.5].map((v, i) => ({ t: Date.now() - (2 - i) * 1000, v })) };
    const view = renderWith(<HealthWidget widget={widget()} />, { healths: [gige()], healthSeries });
    const sensor = instance("cam_gige").querySelector(".health-summary-metric")!;
    expect(sensor.querySelector("svg path")?.getAttribute("d")).toMatch(/^M0\.0 /);
    fireEvent.mouseEnter(sensor);
    expect(screen.getByRole("tooltip").textContent).toContain("40.0 … 44.5 °C over 300 s");
    view.unmount();
    renderWith(<HealthWidget widget={widget({ history_s: 0 })} />, { healths: [gige()], healthSeries });
    expect(document.querySelector(".health-summary svg")).toBeNull();
  });

  it("details opens full component inspection, including non-health values", () => {
    renderWith(<HealthWidget widget={widget({ details: true })} />, { healths: [boson()] });
    expect(document.querySelector(".health-component-details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("ffc.state")).toBeTruthy();
    expect(screen.getByText("fps.delivered")).toBeTruthy();
  });

  it("uses the same compact summaries inside panels", () => {
    renderWith(<HealthWidget widget={widget()} compact />, { healths: [gige(), health("playback", { stream: {} })] });
    expect(document.querySelector(".widget-card")).toBeNull();
    expect(rows(instance("cam_gige"))).toHaveLength(2);
    expect(instance("playback").querySelector(".health-verdict")?.textContent).toBe("OK");
    expect(screen.queryByText(/no temperature/)).toBeNull();
  });

  it("remembers a manual selection across remounts and can resume discovery including new reporters", () => {
    const view = renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), boson()] });
    fireEvent.click(screen.getByLabelText("Choose health services"));
    fireEvent.click(screen.getByLabelText("1/cam_gige"));
    expect(instance("cam_gige")).toBeNull();
    view.unmount();
    renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), boson(), health("new", { stream: {} })] });
    expect(instance("cam_gige")).toBeNull();
    expect(instance("new")).toBeNull();
    fireEvent.click(screen.getByLabelText("Choose health services"));
    fireEvent.click(screen.getByLabelText("Auto-discover all reporters"));
    expect(instance("new")).toBeTruthy();
    expect(instance("cam_gige")).toBeTruthy();
  });

  it("lock overrides browser selections; changed config starts a fresh selection scope", () => {
    const view = renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), boson()] });
    fireEvent.click(screen.getByLabelText("Choose health services"));
    fireEvent.click(screen.getByLabelText("1/cam_gige"));
    view.unmount();
    const locked = renderWith(<HealthWidget widget={widget({ lock: true })} />, { healths: [gige(), boson()] });
    expect(instance("cam_gige")).toBeTruthy();
    expect(screen.queryByLabelText("Choose health services")).toBeNull();
    locked.unmount();
    renderWith(<HealthWidget widget={widget({ services: ["cam_gige"] })} />, { healths: [gige(), boson()] });
    expect(instance("cam_gige")).toBeTruthy();
    expect(instance("cam_thermal")).toBeNull();
  });

  it("distinguishes same-name services on different vehicles", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), { ...gige(), key: "fleet/2/svc/cam_gige/health", vehicleId: "2" }] });
    expect(screen.getByText("1/cam_gige", { selector: ".health-name" })).toBeTruthy();
    expect(screen.getByText("2/cam_gige", { selector: ".health-name" })).toBeTruthy();
  });

  it("marks dashboard disconnection once, dims readings immediately, and never claims a sensor fault", () => {
    renderWith(<TransportCtx.Provider value={{ transport: null, status: "reconnecting", error: "", locator: "test" }}>
      <HealthWidget widget={widget()} /></TransportCtx.Provider>, { healths: [gige()] });
    expect(screen.getByRole("status").textContent).toContain("Updates reconnecting");
    expect(instance("cam_gige").querySelector(".health-verdict")?.textContent).toBe("last known OK");
    expect(instance("cam_gige").querySelector(".row-value")?.className).toContain("idle");
    expect(document.querySelector(".health-issue")).toBeNull();
  });

  it("dims a silent reporter even when its component has a longer observation TTL", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("slow", {
      camera: { values: { "temp.sensor_c": 40, "health.stale_after_s": 60 } },
    }, { receivedAtMs: Date.now() - 10_000 })] });
    expect(instance("slow").querySelector(".row-value")?.className).toContain("idle");
    fireEvent.focus(screen.getByRole("button", { name: /sensor: 40.0/ }));
    expect(screen.getByRole("tooltip").textContent).toContain("Reporter silent · last known");
  });

  it("never suppresses an alert summary with incomplete history or a failed poll", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("lidar", {
      alerts: { level: 1, message: "Alert history incomplete", values: { "alerts.active": 1, "alerts.history_gap": true } },
      "alert/HOT": { level: 2, values: { "alert.active": true } },
    })] });
    expect(screen.getByRole("button", { name: "WARN alerts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ERROR alert/HOT" })).toBeTruthy();
  });

  it("a generic ROS reporter can be selected by stable key and remains an expected row after reload", () => {
    const generic = health("/driver: health", { status: { level: 1 } }, {
      key: "ros2/0/%2Fdiagnostics/%2Fdriver%3Ahealth", vehicleId: "ROS domain 0", source: "ros2",
    });
    const view = renderWith(<HealthWidget widget={widget()} />, { healths: [gige(), generic] });
    fireEvent.click(screen.getByLabelText("Choose health services"));
    fireEvent.click(screen.getByLabelText("1/cam_gige"));
    expect(document.querySelectorAll(".health-summary")).toHaveLength(1);
    view.unmount();
    renderWith(<HealthWidget widget={widget()} />, { healths: [] });
    expect(screen.getByText("not reported")).toBeTruthy();
    expect(document.querySelector(".health-name")?.textContent).toBe(generic.key);
  });

  it("keeps an informational history-gap pill after every active sensor alert clears", () => {
    renderWith(<HealthWidget widget={widget()} />, { healths: [health("lidar", {
      alerts: { level: 0, message: "0 active alert(s)", values: { "alerts.active": 0, "alerts.history_gap": true } },
    })] });
    const gap = screen.getByRole("button", { name: "INFO alert history gap" });
    fireEvent.focus(gap);
    expect(screen.getByRole("tooltip").textContent).toContain("Alert history is incomplete");
    expect(instance("lidar").querySelector(".health-verdict")?.textContent).toBe("OK");
  });

});
