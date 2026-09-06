import { describe, expect, it } from "vitest";
import { parsePlaybackDescriptor, parsePlaybackKey, positionText, speedText } from "./types";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const PLAYING = {
  schema_version: 1, service: "camera-service", instance: "playback", source: "pcap",
  state: "playing", controls: ["pause", "set_speed", "set_loop", "restart"],
  speed: 1, loop: true, cycle: 8, position_s: 0.8, duration_s: 4.032, frames: 21,
};

describe("playback keys + descriptors (PLAYBACK.md)", () => {
  it("parses the playback key and nothing else", () => {
    expect(parsePlaybackKey("fleet/1/svc/playback/playback")).toEqual({ vehicleId: "1", instance: "playback" });
    expect(parsePlaybackKey("fleet/1/svc/playback/lifecycle")).toBeNull();       // the sibling keyspace
    expect(parsePlaybackKey("fleet/1/svc/playback/playback/state")).toBeNull();  // 6 segments
    expect(parsePlaybackKey("fleet//svc/x/playback")).toBeNull();
  });

  it("accepts the bench's real descriptor and rejects malformed ones", () => {
    const d = parsePlaybackDescriptor(enc(PLAYING));
    expect(d).toMatchObject({ source: "pcap", state: "playing", cycle: 8, duration_s: 4.032 });
    expect(d?.controls).toEqual(["pause", "set_speed", "set_loop", "restart"]);
    for (const bad of [{ ...PLAYING, controls: "pause" }, { ...PLAYING, source: 3 }, { ...PLAYING, schema_version: "1" }, [1], "x"])
      expect(parsePlaybackDescriptor(enc(bad))).toBeNull();
    expect(parsePlaybackDescriptor(new TextEncoder().encode("{nope"))).toBeNull();
  });

  it("formats position and speed the way the tile shows them", () => {
    expect(positionText(parsePlaybackDescriptor(enc(PLAYING))!)).toBe("0.8 / 4.0 s");
    expect(positionText(parsePlaybackDescriptor(enc({ ...PLAYING, duration_s: null, position_s: 12.34 }))!)).toBe("12.3 s");
    expect(speedText(1)).toBe("×1");
    expect(speedText(0)).toBe("max");       // the contract's 0 = as fast as it drains
    expect(speedText(undefined)).toBe("");
  });
});
