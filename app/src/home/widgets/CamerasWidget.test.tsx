// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CamerasWidgetConfig } from "../../config/schema";
import { renderWith, stream } from "../../test/harness";
import { CamerasWidget } from "./CamerasWidget";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const widget = (over: Partial<CamerasWidgetConfig> = {}): CamerasWidgetConfig => ({
  type: "cameras",
  layout: "focus",
  controls: "auto",
  ...over,
});
const three = () => [stream("a", { role: "front" }), stream("b", { role: "rear" }), stream("c", { role: "thermal" })];
const modes = () => [...document.querySelectorAll(".stream-view")].map((el) => el.className.split(" ")[1]);
const focusedLabel = () => document.querySelector(".stream-view.focused .tile-overlay strong")?.textContent;

describe("CamerasWidget", () => {
  it("with no `streams` shows every discovered feed: one in focus, the rest as a carousel of thumbnails", () => {
    renderWith(<CamerasWidget widget={widget({ label: "Deck" })} />, { streams: three() });
    expect(modes()).toEqual(["focused", "thumb", "thumb"]);
    expect(focusedLabel()).toBe("front");
    expect(screen.getByText("3 of 3 watching")).toBeTruthy();
    expect(document.querySelector('[data-layout="focus"]')).not.toBeNull();
  });

  it("clicking a thumbnail brings it into focus; the toggle flips to a grid and back; both are remembered", () => {
    renderWith(<CamerasWidget widget={widget({ label: "Deck" })} />, { streams: three() });
    fireEvent.click(document.querySelectorAll(".stream-view.thumb")[1]);
    expect(focusedLabel()).toBe("thermal");
    fireEvent.click(screen.getByRole("button", { name: /grid/ }));
    expect(modes()).toEqual(["grid", "grid", "grid"]);
    expect(JSON.parse(localStorage.getItem("dashboard.widget.cameras.Deck")!)).toMatchObject({ focus: "fleet/1/media/c", layout: "grid" });
    fireEvent.click(screen.getByRole("button", { name: /focus/ }));
    expect(modes()).toEqual(["thumb", "thumb", "focused"]); // focus remembered: thermal
  });

  it("`streams:` limits the set; ✕ removes a feed and the picker adds one; the set is remembered", () => {
    renderWith(<CamerasWidget widget={widget({ label: "Deck", streams: ["a", "b"] })} />, { streams: three() });
    expect(modes()).toHaveLength(2);
    expect(screen.getByText("2 of 3 watching")).toBeTruthy();
    // thumbnails carry no chrome (a click focuses them); ✕ lives on the focused / grid tiles
    expect(document.querySelector(".stream-view.thumb button[title='unsubscribe']")).toBeNull();
    fireEvent.click(document.querySelector(".stream-view.focused button[title='unsubscribe']")!);
    expect(modes()).toEqual(["focused"]);                                   // rear moved up
    expect(document.querySelector(".stream-view.focused .tile-overlay strong")?.textContent).toBe("rear");
    fireEvent.change(screen.getByLabelText("add a feed"), { target: { value: "fleet/1/media/c" } });
    expect(modes()).toEqual(["focused", "thumb"]);
    expect(JSON.parse(localStorage.getItem("dashboard.widget.cameras.Deck")!).keys).toEqual(["fleet/1/media/b", "fleet/1/media/c"]);
  });

  it("`lock` fixes the set: no picker, no ✕, and nothing remembered", () => {
    localStorage.setItem("dashboard.widget.cameras.Deck", JSON.stringify({ keys: ["fleet/1/media/c"], layout: "grid" }));
    renderWith(<CamerasWidget widget={widget({ label: "Deck", streams: ["a", "b"], lock: true, layout: "grid", columns: 2 })} />, {
      streams: three(),
    });
    expect(modes()).toEqual(["grid", "grid"]);
    expect(screen.queryByLabelText("add a feed")).toBeNull();
    expect(document.querySelector("button[title='unsubscribe']")).toBeNull();
    expect((document.querySelector(".console-grid") as HTMLElement).style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("with nothing discovered it waits", () => {
    renderWith(<CamerasWidget widget={widget()} />);
    expect(screen.getByText(/waiting for streams/)).toBeTruthy();
  });
});
