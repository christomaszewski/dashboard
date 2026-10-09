// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildGraph, type TopicEntry } from "../ros/graph";
import { TopicStore } from "../ros/topicStore";
import type { Sample, Transport } from "../transport/types";
import RosImageWidget from "./RosImageWidget";
import type { RosImageWidgetConfig } from "./spec";

const world = vi.hoisted(() => ({ topics: [] as TopicEntry[], store: null as TopicStore | null, status: "connected", active: true }));
vi.mock("../ros/RosGraphContext", () => ({ useRosGraphContext: () => ({ graph: { topics: world.topics }, store: world.store }) }));
vi.mock("../transport/TransportContext", () => ({ useTransportContext: () => ({ status: world.status }) }));
vi.mock("../shell/TabActivity", () => ({ useTabActive: () => world.active }));

const topic = (name = "/ouster/nearir_image", domain = 1) => buildGraph([
  `@ros2_lv/${domain}/z/1/1/MP/_/%ouster/driver/${name.replaceAll("/", "%")}/sensor_msgs::msg::dds_::Image_/RIHS01_image/2:2:1,10`,
]).topics[0];
const settings: RosImageWidgetConfig = { type: "ros_image", label: "Lidar", topic: "/ouster/nearir_image", normalize: true, stale_after_s: 3 };
const frame = { width: 2, height: 1, step: 4, encoding: "mono16", is_bigendian: 0, data: [0, 0, 255, 255] };
let callbacks: Map<string, (sample: Sample) => void>;
let put: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
const tick = (ms = 210) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const publish = async (entry = world.topics[0], message = frame) => {
  await act(async () => callbacks.get(entry.dataKeyexpr)?.({ kind: "put", keyexpr: entry.dataKeyexpr, payload: new TextEncoder().encode(JSON.stringify(message)) }));
  await tick();
};
beforeEach(() => {
  vi.useFakeTimers();
  callbacks = new Map(); world.topics = [topic()]; world.status = "connected"; world.active = true;
  put = vi.fn();
  const ctx = { createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: put };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  subscribe = vi.fn(async (key: string, cb: (sample: Sample) => void) => {
    callbacks.set(key, cb); return { close: async () => { callbacks.delete(key); } };
  });
  const transport = { subscribe, get: async () => [], close: async () => {}, liveliness: { get: async () => [], subscribe: async () => ({ close: async () => {} }) } } as Transport;
  world.store = new TopicStore({ transport, lingerMs: 0, resolver: { resolve: async () => ({ decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) }) } });
});
afterEach(() => { cleanup(); world.store?.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("renders decoded pixels, ages a stopped stream, and does not refresh it on contrast changes", async () => {
  render(<RosImageWidget widget={settings} />);
  await tick(); await publish();
  expect([...put.mock.calls.at(-1)![0].data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  expect(screen.getByText("live")).toBeTruthy();
  await tick(4000);
  expect(screen.getByText("last frame")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Auto contrast" }));
  expect(screen.getByText("last frame")).toBeTruthy();
  await publish(); expect(screen.getByText("live")).toBeTruthy();
});

it("subscribes only to the chosen image and releases the previous topic and hidden Home view", async () => {
  world.topics.push(topic("/ouster/reflec_image"));
  const view = render(<RosImageWidget widget={settings} />);
  await tick(); await publish();
  expect(callbacks.size).toBe(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Image topic for Lidar" }), { target: { value: "/ouster/reflec_image" } });
  await tick();
  expect([...callbacks.keys()]).toEqual([world.topics[1].dataKeyexpr]);
  expect(screen.getByText("Waiting for image data…")).toBeTruthy();
  world.active = false; view.rerender(<RosImageWidget widget={settings} />); await tick();
  expect(callbacks.size).toBe(0);
  world.active = true; view.rerender(<RosImageWidget widget={settings} />); await tick();
  expect(callbacks.size).toBe(1);
  view.unmount(); await tick(); expect(callbacks.size).toBe(0);
});

it("requires an explicit choice for a same-name image in multiple ROS domains", async () => {
  world.topics.push(topic(undefined, 2));
  render(<RosImageWidget widget={settings} />); await tick();
  expect(screen.getByText("Choose a ROS domain for this image topic.")).toBeTruthy();
  expect(callbacks.size).toBe(0);
  fireEvent.change(screen.getByRole("combobox", { name: "ROS domain for Lidar" }), { target: { value: "2" } });
  await tick(); expect([...callbacks.keys()]).toEqual([world.topics[1].dataKeyexpr]);
});

it("keeps a disconnected/disappeared publisher's last frame labeled and reconnects", async () => {
  const view = render(<RosImageWidget widget={settings} />); await tick(); await publish();
  world.status = "disconnected"; world.topics = [];
  view.rerender(<RosImageWidget widget={settings} />);
  expect(screen.getByText("last frame")).toBeTruthy();
  expect(screen.getByRole("img").getAttribute("hidden")).toBeNull();
  world.status = "connected"; world.topics = [topic()]; view.rerender(<RosImageWidget widget={settings} />);
  await tick(4000); expect(screen.getByText("last frame")).toBeTruthy();
  await publish(); expect(screen.getByText("live")).toBeTruthy();
});

it("rejects unsupported encodings and clears the invalid image instead of retaining a live-looking frame", async () => {
  render(<RosImageWidget widget={settings} />); await tick(); await publish();
  await publish(world.topics[0], { ...frame, encoding: "bayer_rggb8" });
  expect(screen.getByRole("alert").textContent).toContain("Unsupported image encoding");
  expect(document.querySelector("canvas")?.hasAttribute("hidden")).toBe(true);
  await publish(); expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByText("live")).toBeTruthy();
});

it("does not resubscribe when graph objects are refreshed, and enforces the configured allowlist", async () => {
  const config = { ...settings, topics: [settings.topic, "/ouster/reflec_image"] };
  world.topics.push(topic("/camera/image"));
  const view = render(<RosImageWidget widget={config} />); await tick();
  expect(screen.queryByRole("option", { name: "/camera/image" })).toBeNull();
  world.topics = world.topics.map((t) => ({ ...t })); view.rerender(<RosImageWidget widget={config} />); await tick();
  expect(subscribe).toHaveBeenCalledTimes(1);
});

it("reports a configured topic with the wrong ROS type without subscribing", async () => {
  world.topics = [{ ...topic(), typeName: "sensor_msgs/msg/CompressedImage" }];
  render(<RosImageWidget widget={settings} />); await tick();
  expect(screen.getByRole("alert").textContent).toContain("sensor_msgs/msg/CompressedImage");
  expect(callbacks.size).toBe(0);
});

it("does not guess between conflicting image schemas within one domain", async () => {
  world.topics.push({ ...topic(), typeHash: "RIHS01_other", dataKeyexpr: "other/schema" });
  render(<RosImageWidget widget={settings} />); await tick();
  expect(screen.getByText("Multiple image schemas are advertised for this topic in the same domain.")).toBeTruthy();
  expect(callbacks.size).toBe(0);
});
