// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeLocators, vehicleHost } from "./locator";
import { resolveSignallingUrl } from "../streams/signalling";
import { parseDashboardConfig } from "../config/schema";
import type { StreamDescriptor } from "../streams/types";

function page(hostname: string, protocol = "http:") {
  vi.stubGlobal("location", { hostname, protocol });
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("bridge addresses", () => {
  it("prefers loopback independently of the configured vehicle WebSocket port", () => {
    page("192.168.1.20");
    expect(bridgeLocators(10001)).toEqual({ vehicleLocator: "ws/192.168.1.20:10001", localLocator: "ws/127.0.0.1:10000" });
    expect(vehicleHost()).toBe("192.168.1.20");
    expect(resolveSignallingUrl({ signalling: "ws://internal-name:8443" } as StreamDescriptor)).toBe("ws://192.168.1.20:8443");
  });
  it("supports a custom secure loopback endpoint and vehicle-only configuration", () => {
    page("vehicle.local", "https:");
    const cfg = parseDashboardConfig("local_bridge: wss/localhost:11000");
    expect(bridgeLocators(10000, cfg.local_bridge)).toEqual({ vehicleLocator: "wss/vehicle.local:10000", localLocator: "wss/localhost:11000" });
    expect(bridgeLocators(10000, parseDashboardConfig("local_bridge: false").local_bridge)).toEqual({ vehicleLocator: "wss/vehicle.local:10000" });
  });
  it("does not probe the same localhost endpoint twice", () => {
    page("localhost");
    expect(bridgeLocators()).toEqual({ vehicleLocator: "ws/localhost:10000" });
    page("[::1]");
    expect(bridgeLocators()).toEqual({ vehicleLocator: "ws/[::1]:10000" });
  });
  it("keeps explicit development overrides pinned and supports an independent vehicle host", () => {
    page("localhost");
    vi.stubEnv("VITE_REMOTE_API_LOCATOR", "ws/10.1.1.2:11000");
    expect(bridgeLocators()).toEqual({ vehicleLocator: "ws/10.1.1.2:11000" });
    expect(vehicleHost()).toBe("10.1.1.2");
    vi.stubEnv("VITE_REMOTE_API_LOCATOR", "ws/127.0.0.1:10000");
    vi.stubEnv("VITE_VEHICLE_HOST", "10.1.1.2");
    expect(vehicleHost()).toBe("10.1.1.2");
  });
  it("ignores malformed or non-loopback local candidates", () => {
    page("vehicle");
    for (const local of ["nope", "ws/other-vehicle:10000", "http/localhost:10000", "ws://user:pass@localhost:10000"])
      expect(bridgeLocators(10000, local)).toEqual({ vehicleLocator: "ws/vehicle:10000" });
  });
});
