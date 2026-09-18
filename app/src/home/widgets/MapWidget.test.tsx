// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import L from "leaflet";
import { StrictMode } from "react";
import { MapWidget } from "./MapWidget";
import { defaultBasemap, mapLayers } from "../basemaps";
import type { MapWidgetConfig } from "../mapConfig";

const topics = vi.hoisted(() => new Map<string, { topic: object; snapshot: { message?: unknown; error?: string } }>());
vi.mock("../../ros/useTopic", () => ({ useTopic: (name: string) => topics.get(name) ?? { topic: undefined, snapshot: null } }));
const publish = (name: string, message: unknown) => topics.set(name, { topic: {}, snapshot: { message } });

beforeEach(() => {
  topics.clear();
  publish("/fix", { latitude: 33.77, longitude: -84.4 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // jsdom has no SVG detection; Leaflet's SVG implementation itself works in it.
  vi.spyOn(L.Browser, "svg", "get").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("map basemaps", () => {
  it("preserves custom/offline defaults and only adds Custom when a URL exists", () => {
    expect(defaultBasemap({})).toBe("streets");
    expect(defaultBasemap({ tiles: "none" })).toBe("none");
    expect(defaultBasemap({ tiles: "/tiles/{z}/{x}/{y}.png" })).toBe("custom");
    expect(defaultBasemap({ tiles: "none", basemap: "satellite" })).toBe("satellite");
    expect(mapLayers({}).map(l => l.id)).not.toContain("custom");
    expect(mapLayers({ tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" }).at(-1)?.attribution)
      .toContain("OpenStreetMap");
  });

  it("switches the real Leaflet layer and attribution without rebuilding the map or trail", () => {
    const createMap = vi.spyOn(L, "map");
    const createTrail = vi.spyOn(L, "polyline");
    const view = render(<MapWidget widget={{ type: "map", topic: "/fix", label: "Position", basemap: "satellite" }} />);
    const map = createMap.mock.results[0].value as L.Map;
    const trail = createTrail.mock.results[0].value as L.Polyline;
    const select = screen.getByRole("combobox", { name: "Basemap for Position" });
    const tiles = () => { const found: L.TileLayer[] = []; map.eachLayer(l => { if (l instanceof L.TileLayer) found.push(l); }); return found; };
    expect((select as HTMLSelectElement).value).toBe("satellite");
    expect(tiles()).toHaveLength(1);
    expect(view.container.querySelector(".leaflet-control-attribution")?.textContent).toContain("Esri");
    act(() => { map.fire("dragstart"); map.setView([34, -85], 12, { animate: false }); });
    const center = map.getCenter();
    const points = [...trail.getLatLngs()];
    fireEvent.change(select, { target: { value: "streets" } });
    expect(tiles()).toHaveLength(1);
    expect(view.container.querySelector(".leaflet-control-attribution")?.textContent).toContain("OpenStreetMap");
    expect(map.getCenter()).toEqual(center);
    expect(map.getZoom()).toBe(12);
    expect(trail.getLatLngs()).toEqual(points);
    expect(screen.getByRole("button", { name: /follow/ })).toBeTruthy();
    fireEvent.change(select, { target: { value: "none" } });
    expect(tiles()).toHaveLength(0);
    expect(map.hasLayer(trail)).toBe(true);
    expect(createMap).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("rotates an optional heading without moving position or adding trail points, then falls back to a dot", () => {
    const createTrail = vi.spyOn(L, "polyline");
    const widget: MapWidgetConfig = { type: "map", topic: "/fix", label: "Vehicle", basemap: "none", orientation_topic: "/imu" };
    const view = render(<MapWidget widget={widget} />);
    const marker = () => view.container.querySelector(".map-vehicle-symbol")!;
    expect(marker().classList.contains("has-heading")).toBe(false);
    const trail = createTrail.mock.results[0].value as L.Polyline;
    const points = [...trail.getLatLngs()];
    publish("/imu", { orientation: { x: 0, y: 0, z: 0, w: 1 } });
    view.rerender(<MapWidget widget={widget} />);
    expect(screen.getByRole("img", { name: "Vehicle, heading 90°" })).toBeTruthy();
    expect((marker().querySelector(".map-vehicle-arrow") as HTMLElement).style.transform).toBe("rotate(90deg)");
    expect(trail.getLatLngs()).toEqual(points);
    publish("/imu", { orientation: { x: 0, y: 0, z: 0, w: 1 }, orientation_covariance: [-1] });
    view.rerender(<MapWidget widget={widget} />);
    expect(marker().classList.contains("has-heading")).toBe(false);
    expect(trail.getLatLngs()).toEqual(points);
  });

  it("tracks two feeds independently, switches follow, and retains hidden trails", () => {
    publish("/other", { latitude: 34, longitude: -85 });
    const createMap = vi.spyOn(L, "map");
    const createTrail = vi.spyOn(L, "polyline");
    const widget: MapWidgetConfig = { type: "map", label: "Positions", basemap: "none", trail: 2, default_feed: "b", feeds: [
      { id: "a", label: "GNSS", topic: "/fix", orientation_topic: "/imu" },
      { id: "b", label: "Estimate", topic: "/other" },
    ] };
    const view = render(<MapWidget widget={widget} />);
    const map = createMap.mock.results[0].value as L.Map;
    const trail = createTrail.mock.results[0].value as L.Polyline;
    const selector = screen.getByRole("combobox", { name: "Position feed for Positions" });
    expect(view.container.querySelectorAll(".map-vehicle")).toHaveLength(2);
    expect(map.getCenter()).toEqual(L.latLng(34, -85));
    fireEvent.change(selector, { target: { value: "a" } });
    expect(map.getCenter()).toEqual(L.latLng(33.77, -84.4));
    act(() => { map.fire("dragstart"); map.setView([30, -80], 12, { animate: false }); });
    publish("/fix", { latitude: 33.78, longitude: -84.4 });
    view.rerender(<MapWidget widget={widget} />);
    expect(map.getCenter()).toEqual(L.latLng(30, -80));
    fireEvent.click(screen.getByRole("button", { name: /follow/ }));
    expect(map.getCenter()).toEqual(L.latLng(33.78, -84.4));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show GNSS" }));
    expect((selector as HTMLSelectElement).value).toBe("b");
    expect(map.getCenter()).toEqual(L.latLng(34, -85));
    expect(map.hasLayer(trail)).toBe(false);
    publish("/fix", { latitude: 33.79, longitude: -84.4 });
    view.rerender(<MapWidget widget={widget} />);
    fireEvent.change(selector, { target: { value: "a" } }); // choosing a hidden feed shows it
    expect((screen.getByRole("checkbox", { name: "Show GNSS" }) as HTMLInputElement).checked).toBe(true);
    expect(map.hasLayer(trail)).toBe(true);
    expect(trail.getLatLngs()).toEqual([L.latLng(33.78, -84.4), L.latLng(33.79, -84.4)]);
    expect(map.getCenter()).toEqual(L.latLng(33.79, -84.4));
    expect(map.getZoom()).toBe(12);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show GNSS" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Estimate" }));
    expect(view.container.querySelectorAll(".map-vehicle")).toHaveLength(0);
    expect(screen.getByText("All feeds hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show GNSS" }));
    expect((selector as HTMLSelectElement).value).toBe("a");
    expect(createMap).toHaveBeenCalledOnce();
    expect(createTrail).toHaveBeenCalledTimes(2);
  });

  it("cleans up and remounts correctly in StrictMode, including tile and feed layers", () => {
    const view = render(<StrictMode><MapWidget widget={{ type: "map", topic: "/fix" }} /></StrictMode>);
    expect(view.container.querySelectorAll(".map-vehicle")).toHaveLength(1);
    expect(view.container.querySelectorAll(".leaflet-map-pane")).toHaveLength(1);
    view.unmount();
  });

  it("focuses a feed when its first fix arrives without enabling continuous follow", () => {
    const createMap = vi.spyOn(L, "map");
    const widget: MapWidgetConfig = { type: "map", label: "Positions", basemap: "none", follow: false, feeds: [
      { id: "a", topic: "/fix" }, { id: "b", label: "Estimate", topic: "/other" },
    ] };
    const view = render(<MapWidget widget={widget} />);
    const map = createMap.mock.results[0].value as L.Map;
    const selector = screen.getByRole("combobox", { name: "Position feed for Positions" });
    fireEvent.change(selector, { target: { value: "b" } });
    expect(screen.getByText(/Estimate: waiting for/)).toBeTruthy();
    publish("/other", { latitude: 34, longitude: -85 });
    view.rerender(<MapWidget widget={widget} />);
    expect(map.getCenter()).toEqual(L.latLng(34, -85));
    publish("/other", { latitude: 35, longitude: -85 });
    view.rerender(<MapWidget widget={widget} />);
    expect(map.getCenter()).toEqual(L.latLng(34, -85));
    fireEvent.click(screen.getByRole("button", { name: /center/ }));
    expect(map.getCenter()).toEqual(L.latLng(35, -85));
  });
});
