// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CameraWidgetConfig } from "../../config/schema";
import { renderWith, stream } from "../../test/harness";
import { CameraWidget } from "./CameraWidget";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const widget = (over: Partial<CameraWidgetConfig> = {}): CameraWidgetConfig => ({ type: "camera", controls: "auto", ...over });
const tileLabel = () => document.querySelector(".widget-camera .tile-overlay strong")?.textContent ?? null;
const picker = () => document.querySelector<HTMLSelectElement>(".stream-picker");

describe("CameraWidget", () => {
  it("with no `stream` and one discovered stream, that stream auto-selects (no picker to show)", () => {
    const { pool } = renderWith(<CameraWidget widget={widget()} />, { streams: [stream("cam_front")] });
    expect(tileLabel()).toBe("cam_front");
    expect(picker()).toBeNull();
    expect(pool.getSnapshot("fleet/1/media/cam_front")?.state).toBe("opening"); // acquired for real
  });

  it("with nothing discovered it waits; with several and no `stream` it offers the picker in the tile's place", () => {
    const { unmount } = renderWith(<CameraWidget widget={widget({ label: "Pick" })} />);
    expect(screen.getByText(/waiting for/).textContent).toContain("a stream");
    unmount();
    renderWith(<CameraWidget widget={widget({ label: "Pick" })} />, { streams: [stream("cam_front"), stream("cam_rear")] });
    expect(tileLabel()).toBeNull();
    expect(picker()).not.toBeNull();
    fireEvent.change(picker()!, { target: { value: "fleet/1/media/cam_rear" } });
    expect(tileLabel()).toBe("Pick");
    expect(document.querySelector(".widget-camera .tile-actions .stream-picker")).not.toBeNull(); // still changeable
    expect(JSON.parse(localStorage.getItem("dashboard.widget.camera.Pick")!)).toBe("fleet/1/media/cam_rear");
  });

  it("a remembered choice outranks the configured default; `lock` pins the config and hides the picker", () => {
    localStorage.setItem("dashboard.widget.camera.Front", JSON.stringify("fleet/1/media/cam_rear"));
    const streams = [stream("cam_front", { role: "front" }), stream("cam_rear", { role: "rear" })];
    const { unmount } = renderWith(<CameraWidget widget={widget({ label: "Front", stream: "cam_front" })} />, { streams });
    expect(document.querySelector(".widget-camera .tile-overlay .meta")?.textContent).toContain("H264 640×480");
    expect((document.querySelector<HTMLSelectElement>(".tile-actions .stream-picker"))?.value).toBe("fleet/1/media/cam_rear");
    unmount();
    renderWith(<CameraWidget widget={widget({ label: "Front", stream: "cam_front", lock: true })} />, { streams });
    expect(picker()).toBeNull();
    expect(document.querySelector<HTMLVideoElement>(".widget-camera video")).not.toBeNull();
  });

  it("the picker's options name each stream and mark offline ones", () => {
    renderWith(<CameraWidget widget={widget({ label: "Pick" })} />, {
      streams: [stream("cam_front", { role: "front" }), stream("cam_rear", { role: "rear" }, false)],
    });
    const options = [...picker()!.options].map((o) => o.textContent);
    expect(options).toEqual(["select a stream…", "front 640×480", "rear 640×480 (offline)"]);
  });
});
