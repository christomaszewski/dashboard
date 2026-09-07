// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWith, stream } from "../test/harness";
import { CameraConsole } from "./CameraConsole";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const modes = () => [...document.querySelectorAll(".stream-view")].map((el) => el.className.split(" ")[1]);

describe("CameraConsole", () => {
  it("lists what discovery found; subscribing tiles a feed; maximize focuses it, Esc returns to the grid", () => {
    renderWith(<CameraConsole />, { streams: [stream("a", { role: "front" }), stream("b", { role: "rear" })] });
    expect(screen.getByText("2 available")).toBeTruthy();
    expect(screen.getByText(/Select a camera above/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /front/ }));
    fireEvent.click(screen.getByRole("button", { name: /rear/ }));
    expect(modes()).toEqual(["grid", "grid"]);
    expect(screen.getByText("2 available · 2 watching")).toBeTruthy();
    fireEvent.click(document.querySelectorAll("button[title='maximize']")[1]);
    expect(modes()).toEqual(["thumb", "focused"]);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(modes()).toEqual(["focused", "thumb"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(modes()).toEqual(["grid", "grid"]);
    expect(JSON.parse(localStorage.getItem("dashboard.cameras.subscribed")!)).toEqual(["fleet/1/media/a", "fleet/1/media/b"]);
  });
});
