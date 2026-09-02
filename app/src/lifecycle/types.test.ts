import { describe, expect, it } from "vitest";
import { parseLifecycleDescriptor, parseLifecycleKey } from "./types";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("parseLifecycleKey", () => {
  it("accepts exactly fleet/<vehicle>/svc/<instance>/lifecycle", () => {
    expect(parseLifecycleKey("fleet/veh1/svc/cam0/lifecycle")).toEqual({ vehicleId: "veh1", instance: "cam0" });
  });

  it("rejects media keys, sub-keys, and empty segments", () => {
    expect(parseLifecycleKey("fleet/veh1/media/cam0")).toBeNull();
    expect(parseLifecycleKey("fleet/veh1/svc/cam0/lifecycle/state")).toBeNull();
    expect(parseLifecycleKey("fleet/veh1/svc/cam0/lifecycle/change_state")).toBeNull();
    expect(parseLifecycleKey("fleet//svc/cam0/lifecycle")).toBeNull();
    expect(parseLifecycleKey("fleet/veh1/svc//lifecycle")).toBeNull();
  });
});

describe("parseLifecycleDescriptor", () => {
  const good = {
    schema_version: 1,
    service: "camera-service",
    instance: "cam0",
    state: "active",
    transitions: ["deactivate"],
    since_unix_s: 1_700_000_000,
    boot_reason: "config",
    recording: { prefix: "fake-20260901-120000", frames: 1234, encoder: "ffv1", segment_seconds: 30 },
    health: { publish_drops: 0, stalled: false },
    last_error: null,
  };

  it("accepts the contract's descriptor", () => {
    expect(parseLifecycleDescriptor(enc(good))).toMatchObject({ instance: "cam0", state: "active", transitions: ["deactivate"] });
  });

  it("rejects missing/invalid REQUIRED fields and bad JSON", () => {
    const { transitions: _t, ...noTransitions } = good;
    expect(parseLifecycleDescriptor(enc(noTransitions))).toBeNull();
    expect(parseLifecycleDescriptor(enc({ ...good, transitions: [1] }))).toBeNull();
    expect(parseLifecycleDescriptor(enc({ ...good, state: 7 }))).toBeNull();
    expect(parseLifecycleDescriptor(enc({ ...good, schema_version: "1" }))).toBeNull();
    expect(parseLifecycleDescriptor(enc([good]))).toBeNull();
    expect(parseLifecycleDescriptor(new TextEncoder().encode("{not json"))).toBeNull();
  });
});
