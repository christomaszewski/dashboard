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
  // The landed LIFECYCLE.md example, verbatim in shape.
  const good = {
    schema_version: 1,
    service: "camera-service",
    instance: "cam0",
    state: "active",
    transitions: ["deactivate"],
    since_unix_s: 1756700000.0,
    boot_reason: "config",
    recording_enabled: true,
    health: {
      frames: 12345,
      source_gaps: 0,
      frames_missing: 0,
      enqueue_failures: 0,
      publish_drops: 0,
      pts_rebases: 0,
      stalled: false,
      reconnecting: false,
    },
    recording: {
      index: 2,
      prefix: "cam-20260901-120000",
      output_dir: "/data/runs/42/recordings/front-left",
      started_unix_s: 1756700000.0,
      frames: 1234,
      segments: 3,
      skipped_awaiting_keyframe: 0,
      encoder: "hw-hevc-lossless",
      segment_seconds: 60,
      error: null,
    },
    last_error: null,
  };

  it("accepts the contract's descriptor and keeps the service-specific fields", () => {
    const d = parseLifecycleDescriptor(enc(good));
    expect(d).toMatchObject({ instance: "cam0", state: "active", transitions: ["deactivate"], recording_enabled: true });
    expect(d?.recording).toMatchObject({ index: 2, segments: 3, encoder: "hw-hevc-lossless" });
    expect(d?.health).toMatchObject({ frames: 12345, reconnecting: false });
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
