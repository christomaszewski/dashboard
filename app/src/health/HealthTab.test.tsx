// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWith, health } from "../test/harness";
import { HealthTab } from "./HealthTab";
import { HealthWidget } from "../home/widgets/HealthWidget";

vi.mock("../rig/RigContext", () => ({ useRigContext: () => ({ agents: [{ vehicleId: "1", alive: true, state: { stacks: [
  { name: "never_seen", enabled: true, state: "down", op_state: "down" },
  { name: "disabled_sensor", enabled: false, state: "down", op_state: null },
] } }] }) }));
afterEach(cleanup);

it("shows electrical units, missing inventory and filtered services", () => {
  renderWith(<HealthTab />, { healths: [health("cam", { camera: { values: { "supply.power_w": 12, "supply.voltage_v": 24, "supply.current_a": 0.5 } } })] });
  expect(screen.getByRole("button", { name: "input power: 12.0 W" })).toBeTruthy();
  expect(document.querySelector(".health-component-details")?.hasAttribute("open")).toBe(false);
  fireEvent.click(screen.getByText(/Component details/));
  expect(screen.getByText("input voltage")).toBeTruthy();
  expect(screen.getByText("1/never_seen")).toBeTruthy();
  expect(screen.getByText("disabled · health not reported")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter health services"), { target: { value: "never_seen" } });
  expect(screen.queryByText("input power")).toBeNull();
  expect(screen.getByText("1/never_seen")).toBeTruthy();
});

it("dims a stale measurement without dimming another fresh component", () => {
  const current = { "health.sample_age_s": 0, "health.stale_after_s": 5 };
  const stale = { ...current, "health.sample_age_s": 10 };
  renderWith(<HealthWidget widget={{ type: "health", history_s: 0, precision: 1 }} />, { healths: [health("lidar", {
    temperature: { values: { ...stale, "temp.internal_c": 42 } },
    power: { values: { ...current, "supply.power_w": 18 } },
  })] });
  const rows = [...document.querySelectorAll(".health-summary-metric")];
  expect(rows.find((r) => r.textContent?.includes("internal"))?.querySelector(".row-value")?.className).toContain("idle");
  expect(rows.find((r) => r.textContent?.includes("power"))?.querySelector(".row-value")?.className).toContain("ok");
});

it("puts faults first and searches their messages and vendor codes", () => {
  renderWith(<HealthTab />, { healths: [health("a_ok", { camera: {} }), health("z_fault", {
    "alert/POWER_LOW": { level: 2, message: "Input voltage below range", values: { "alert.active": true, "alert.code": "POWER_LOW" } },
  })] });
  const names = () => [...document.querySelectorAll(".health-summary")].map((e) => e.getAttribute("data-instance"));
  expect(names()).toEqual(["z_fault", "a_ok"]);
  fireEvent.change(screen.getByLabelText("Sort health services"), { target: { value: "name" } });
  expect(names()).toEqual(["a_ok", "z_fault"]);
  fireEvent.click(screen.getByLabelText("Needs attention"));
  expect(names()).toEqual(["z_fault"]);
  fireEvent.change(screen.getByLabelText("Filter health services"), { target: { value: "voltage below" } });
  expect(names()).toEqual(["z_fault"]);
  fireEvent.change(screen.getByLabelText("Filter health services"), { target: { value: "POWER_LOW" } });
  expect(names()).toEqual(["z_fault"]);
});
