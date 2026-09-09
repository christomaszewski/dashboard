import { describe, expect, it } from "vitest";
import { readReplayState } from "./replayState";
const snapshot = { version: 1, run: "recording", epoch: 1, player: "/ros3d_replay", position: "1700000000000000001",
  begin: "1700000000000000000", end: "1700000010000000000", static: [], dynamic: [] };
describe("replay snapshots", () => {
  it("preserves integer nanoseconds and validates before changing the scene", () => {
    expect(readReplayState(JSON.stringify(snapshot)).position).toBe(1700000000000000001n);
    expect(() => readReplayState(JSON.stringify({ ...snapshot, position: 1700000000 }))).toThrow(/time/);
    expect(() => readReplayState(JSON.stringify({ ...snapshot, dynamic: [{}] }))).toThrow(/frame/);
    expect(() => readReplayState(JSON.stringify({ ...snapshot, end: "1" }))).toThrow(/interval/);
    expect(() => readReplayState(JSON.stringify({ ...snapshot, version: 2 }))).toThrow(/identity/);
  });
});
