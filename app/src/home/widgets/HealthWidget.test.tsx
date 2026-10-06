// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthWidgetConfig } from "../../config/schema";
import { health, renderWith } from "../../test/harness";
import { HealthWidget } from "./HealthWidget";

afterEach(cleanup);

const widget = (over: Partial<HealthWidgetConfig> = {}): HealthWidgetConfig => ({ type: "health", history_s: 300, precision: 1, ...over });

// The two cameras this widget was written for: a GigE camera reporting two GenICam temperatures,
// and a Boson reporting its FPA temperature over the serial command channel.
const gige = () =>
  health("cam_gige", {
    camera: { message: "44.5 C", hardware_id: "Basler acA1920 sn 4", values: { "temp.sensor_c": 44.5, "temp.mainboard_c": 39, "ptp.state": "Slave" } },
    stream: { values: { "fps.delivered": 24 } },
  });
const boson = () =>
  health("cam_thermal", {
    camera: { message: "33.25 C", hardware_id: "FLIR Boson 20640A012 sn 123", values: { "temp.sensor_c": 33.25, "ffc.state": "complete" } },
    stream: { values: { "fps.delivered": 60 } },
  });

const instance = (name: string) => document.querySelector<HTMLElement>(`.health-instance[data-instance="${name}"]`)!;
const rows = (root: ParentNode) =>
  [...root.querySelectorAll(".panel-row")].map((r) => [r.querySelector(".row-label")?.textContent, r.querySelector(".row-value")?.textContent]);

describe("HealthWidget", () => {
  it("with no `services`, shows every instance publishing health and each of its temperatures", () => {
    renderWith(<HealthWidget widget={widget({ label: "Camera temperatures" })} />, { healths: [gige(), boson()] });
    expect(rows(instance("cam_gige"))).toEqual([
      ["sensor", "44.5 °C"],
      ["mainboard", "39.0 °C"],
    ]);
    expect(rows(instance("cam_thermal"))).toEqual([["sensor", "33.3 °C"]]);
    expect(instance("cam_gige").querySelector(".pill")?.textContent).toBe("OK");
    expect(instance("cam_thermal").querySelector(".health-hardware")?.textContent).toBe("FLIR Boson 20640A012 sn 123");
    expect(document.querySelector(".health-note")).toBeNull(); // nothing to say while everything is OK
  });

  it("`services` picks instances in config order; one not advertising is a placeholder, not a gap", () => {
    renderWith(<HealthWidget widget={widget({ services: ["cam_thermal", "cam_missing"] })} />, { healths: [gige(), boson()] });
    const names = [...document.querySelectorAll(".health-instance")].map((n) => n.getAttribute("data-instance"));
    expect(names).toEqual(["cam_thermal", "cam_missing"]);
    expect(instance("cam_missing").querySelector(".pill")?.textContent).toBe("not advertised");
    expect(instance("cam_missing").textContent).toContain("fleet/*/svc/cam_missing/health");
  });

  it("waits, saying for what, when nothing publishes health", () => {
    renderWith(<HealthWidget widget={widget()} />);
    expect(screen.getByText("not advertised")).toBeTruthy();
    expect(screen.getByText(/waiting for fleet\/\*\/svc\/\*\/health/)).toBeTruthy();
  });

  it("a status that is not OK is said in words, under the instance's worst level", () => {
    const hot = health("cam_gige", {
      camera: { level: 1, message: "temp.sensor_c 66 > 65", values: { "temp.sensor_c": 66 } },
      stream: { level: 2, message: "no frames for 6.0s", values: {} },
    });
    renderWith(<HealthWidget widget={widget()} />, { healths: [hot] });
    expect(instance("cam_gige").querySelector(".pill")?.className).toContain("err");
    expect(instance("cam_gige").querySelector(".pill")?.textContent).toBe("ERROR");
    const notes = [...document.querySelectorAll(".health-note")].map((n) => [n.className, n.textContent]);
    expect(notes).toEqual([
      ["health-note warn", "camera WARN · temp.sensor_c 66 > 65"],
      ["health-note err", "stream ERROR · no frames for 6.0s"],
    ]);
  });

  it("`components` narrows both the rows and the verdict", () => {
    const lossy = health("cam_thermal", {
      camera: { values: { "temp.sensor_c": 33 } },
      stream: { level: 1, message: "3 frame(s) lost in the last 10s", values: {} },
    });
    renderWith(<HealthWidget widget={widget({ components: ["camera"] })} />, { healths: [lossy] });
    expect(instance("cam_thermal").querySelector(".pill")?.textContent).toBe("OK");
    expect(document.querySelector(".health-note")).toBeNull();
  });

  it("thresholds color each temperature", () => {
    renderWith(<HealthWidget widget={widget({ warn_above: 40, err_above: 60 })} />, { healths: [gige(), boson()] });
    const value = (name: string, i: number) => instance(name).querySelectorAll(".row-value")[i].className;
    expect(value("cam_gige", 0)).toBe("row-value warn"); // 44.5
    expect(value("cam_gige", 1)).toBe("row-value ok"); // 39
    expect(value("cam_thermal", 0)).toBe("row-value ok"); // 33.25
  });

  it("an offline or silent instance keeps its last readings on screen, dimmed", () => {
    const offline = { ...health("cam_gige", { camera: { level: 1, message: "temp.sensor_c 47 > 46", values: { "temp.sensor_c": 47 } } }), alive: false };
    const silent = { ...boson(), receivedAtMs: Date.now() - 20_000 };
    renderWith(<HealthWidget widget={widget({ warn_above: 40 })} />, { healths: [offline, silent] });
    expect(instance("cam_gige").querySelector(".pill")?.textContent).toBe("offline");
    expect(instance("cam_thermal").querySelector(".pill")?.textContent).toMatch(/^silent 2\ds$/);
    expect(instance("cam_gige").querySelector(".row-value")?.className).toBe("row-value idle");
    expect(instance("cam_gige").querySelector(".health-note")?.className).toBe("health-note idle"); // was WARN when last heard
    expect(rows(instance("cam_thermal"))).toEqual([["sensor", "33.3 °C"]]);
  });

  it("draws a trend once a temperature has history, and none when `history_s` is 0", () => {
    const now = Date.now();
    const healthSeries = { "cam_gige/temp.sensor_c": [40, 42, 44.5].map((v, i) => ({ t: now - (2 - i) * 1000, v })) };
    const { unmount } = renderWith(<HealthWidget widget={widget()} />, { healths: [gige()], healthSeries });
    const sensor = instance("cam_gige").querySelectorAll(".panel-row")[0];
    expect(sensor.querySelector("svg path")?.getAttribute("d")).toMatch(/^M0\.0 /);
    expect(sensor.getAttribute("title")).toBe("cam_gige: camera · temp.sensor_c · 40.0 … 44.5 °C over 300 s");
    expect(instance("cam_gige").querySelectorAll(".panel-row")[1].querySelector("svg")).toBeNull(); // mainboard: no history yet
    unmount();
    renderWith(<HealthWidget widget={widget({ history_s: 0 })} />, { healths: [gige()], healthSeries });
    expect(document.querySelector(".health-instance svg")).toBeNull();
  });

  it("`details` lists every status with the rest of its values", () => {
    renderWith(<HealthWidget widget={widget({ details: true, services: ["cam_thermal"] })} />, { healths: [boson()] });
    expect([...document.querySelectorAll(".health-note")].map((n) => n.textContent)).toEqual(["camera OK · 33.25 C", "stream OK"]);
    const values = [...document.querySelectorAll(".health-values > div")].map((d) => d.textContent);
    expect(values).toEqual(["ffc.statecomplete", "fps.delivered60"]);
  });

  it("as a panel item: one row per temperature, named by instance; a pill only when something is off", () => {
    const hot = health("cam_thermal", { camera: { level: 1, message: "temp.sensor_c 61 > 60", values: { "temp.sensor_c": 61 } } });
    renderWith(
      <div className="panel-rows">
        <HealthWidget widget={widget()} compact />
      </div>,
      { healths: [gige(), hot, health("playback", { stream: {} })] },
    );
    expect(rows(document)).toEqual([
      ["cam_gige sensor", "44.5 °C"],
      ["cam_gige mainboard", "39.0 °C"],
      ["cam_thermal sensor", "61.0 °C"],
      ["playback", undefined],
    ]);
    const pills = [...document.querySelectorAll(".panel-row")].map((r) => r.querySelector(".pill")?.textContent);
    expect(pills).toEqual([undefined, undefined, "WARN", "OK"]);
  });
});
