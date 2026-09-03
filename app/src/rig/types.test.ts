import { describe, expect, it } from "vitest";
import {
  jobStateLevel,
  opStateLevel,
  parseRigDescriptor,
  parseRigJob,
  parseRigKey,
  parseRigState,
  parseRunDetail,
  parseRunsReply,
  parseSubmitReply,
  runStateLevel,
  stackLevel,
} from "./types";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

const STATE = {
  schema_version: 1,
  vehicle_id: "1",
  vehicle: "orin-dev",
  at_unix_s: 1000,
  ok: true,
  error: null,
  rig_version: "0.2.46",
  run: { id: "20260902T140000Z_flight1", label: "flight1", started: "2026-09-02T14:00:00+00:00", stacks: ["cam_front"], config: "ab12", disk_kb: 42 },
  registry: { data_dir: "/home/uxv/logs", free_kb: 99, problem: null },
  stacks: [
    { name: "dashboard", service: "dashboard", tier: "infra", order: 5, enabled: true, project: "dashboard-vehicle-1", state: "running", health: "n/a", op_state: null, running: 2, total: 2, state_verbs: false, self: true },
    { name: "lidar", service: "ouster", tier: "sensor", order: 20, enabled: true, project: "lidar-vehicle-1", state: "running", health: "healthy", op_state: "standby", running: 1, total: 1, state_verbs: true, self: false },
    { name: "bag_player", service: "ros2-bag-player", enabled: false },
  ],
  job: null,
};

const JOB = {
  schema_version: 1,
  job_id: "j-20260902T140000Z-a1f2",
  verb: "standby",
  args: { names: ["lidar"], force: false },
  argv: ["standby", "lidar"],
  client: "dashboard @ host",
  self_terminating: false,
  state: "running",
  submitted_unix_s: 1000,
  started_unix_s: 1001,
  ended_unix_s: null,
  deadline_unix_s: 1301,
  timeout_s: 300,
  exit_code: null,
  error: null,
  error_kind: null,
  guard_projects: [],
  log_tail: ["==> lidar [ouster]: standby"],
  result: {},
};

describe("rig keys", () => {
  it("parses fleet/<vid>/rig only", () => {
    expect(parseRigKey("fleet/1/rig")).toEqual({ vehicleId: "1" });
    expect(parseRigKey("fleet/1/rig/state")).toBeNull();
    expect(parseRigKey("fleet//rig")).toBeNull();
    expect(parseRigKey("fleet/1/svc/cam0/lifecycle")).toBeNull();
  });
});

describe("rig parsers", () => {
  it("descriptor: required fields, numeric vehicle_id stringified, embedded job parsed", () => {
    const d = parseRigDescriptor(enc({ schema_version: 1, service: "rig-agent", vehicle_id: 1, capabilities: { actuate: false }, job: JOB }));
    expect(d?.vehicle_id).toBe("1");
    expect(d?.capabilities?.actuate).toBe(false);
    expect(d?.job?.job_id).toBe(JOB.job_id);
    expect(parseRigDescriptor(enc({ service: "rig-agent", vehicle_id: "1" }))).toBeNull();
    expect(parseRigDescriptor(enc("<html>"))).toBeNull();
  });

  it("state: rows normalized, missing optionals defaulted, run + registry carried", () => {
    const s = parseRigState(enc(STATE));
    expect(s).not.toBeNull();
    expect(s!.stacks).toHaveLength(3);
    expect(s!.stacks[0]).toMatchObject({ name: "dashboard", self: true, state: "running" });
    expect(s!.stacks[2]).toMatchObject({ name: "bag_player", enabled: false, state: "down", health: "n/a", op_state: null, running: 0, total: 0, state_verbs: false });
    expect(s!.run).toMatchObject({ id: "20260902T140000Z_flight1", label: "flight1", stacks: ["cam_front"], disk_kb: 42 });
    expect(s!.registry).toEqual({ data_dir: "/home/uxv/logs", free_kb: 99, problem: null });
    expect(s!.job).toBeNull();
    expect(parseRigState(enc({ ...STATE, at_unix_s: "soon" }))).toBeNull();
    expect(parseRigState(enc({ ...STATE, stacks: "none" }))).toBeNull();
    const noRun = parseRigState(enc({ ...STATE, run: null, registry: null }));
    expect(noRun!.run).toBeNull();
    expect(noRun!.registry).toEqual({ data_dir: null, free_kb: null, problem: null });
  });

  it("job: unknown state reads as failed, arrays sanitized", () => {
    const j = parseRigJob(JOB);
    expect(j).toMatchObject({ job_id: JOB.job_id, state: "running", argv: ["standby", "lidar"], deadline_unix_s: 1301 });
    expect(parseRigJob({ ...JOB, state: "weird", argv: [1, "x"], log_tail: null })).toMatchObject({ state: "failed", argv: ["x"], log_tail: [] });
    expect(parseRigJob({ verb: "up" })).toBeNull();
  });

  it("submit reply / runs / run detail", () => {
    expect(parseSubmitReply(enc({ ok: true, job_id: "j-1", job: JOB }))).toMatchObject({ ok: true, job_id: "j-1", job: { verb: "standby" } });
    expect(parseSubmitReply(enc({ ok: false, error: "busy: j-1 (up) is running", job_id: "j-1" }))).toEqual({ ok: false, error: "busy: j-1 (up) is running", job_id: "j-1" });
    expect(parseSubmitReply(enc({ job_id: "j-1" }))).toBeNull();
    const runs = parseRunsReply(enc({ schema_version: 1, ok: true, data_dir: "/d", current: "r2", problem: null, runs: [
      { run: "r1", label: "a", state: "sealed", started: "s", ended: "e", disk_kb: 5, replay_of: null, linked: false },
      { run: "r2", state: "OPEN" },
      { run: "r3", state: "bogus" },
      { nope: true },
    ] }));
    expect(runs?.current).toBe("r2");
    expect(runs?.runs.map((r) => [r.run, r.state, r.label])).toEqual([["r1", "sealed", "a"], ["r2", "OPEN", null], ["r3", "corrupt", null]]);
    expect(parseRunDetail(enc({ ok: true, run: "r1", state: "sealed", dir: "/d/runs/r1", manifest: { label: "a" } }))).toEqual({ ok: true, run: "r1", state: "sealed", dir: "/d/runs/r1", manifest: { label: "a" } });
    expect(parseRunDetail(enc({ ok: false, error: "no such run" }))).toEqual({ ok: false, error: "no such run" });
    expect(parseRunDetail(enc({ ok: true }))).toBeNull();
  });
});

describe("levels", () => {
  it("map states to pill levels", () => {
    expect(runStateLevel("OPEN")).toBe("ok");
    expect(runStateLevel("sealed")).toBe("idle");
    expect(runStateLevel("interrupted")).toBe("warn");
    expect(runStateLevel("corrupt")).toBe("err");
    const s = parseRigState(enc(STATE))!;
    expect(stackLevel(s.stacks[0])).toBe("ok");
    expect(stackLevel({ ...s.stacks[0], health: "unhealthy" })).toBe("err");
    expect(stackLevel({ ...s.stacks[0], state: "partial" })).toBe("warn");
    expect(stackLevel(s.stacks[2])).toBe("idle");
    expect(opStateLevel("active")).toBe("ok");
    expect(opStateLevel("standby")).toBe("idle");
    expect(opStateLevel("transitioning")).toBe("warn");
    expect(opStateLevel("unknown")).toBe("warn");
    expect(jobStateLevel("succeeded")).toBe("ok");
    expect(jobStateLevel("running")).toBe("warn");
    expect(jobStateLevel("killed")).toBe("err");
    expect(jobStateLevel("cancelled")).toBe("idle");
  });
});
