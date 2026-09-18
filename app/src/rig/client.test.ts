import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelJob, encodeJobRequest, getRun, listRuns, RigError, submitJob } from "./client";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";

const KEY = "fleet/1/rig";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b));
const JOB = { job_id: "j-1", verb: "standby", args: {}, argv: ["standby", "lidar"], client: null, self_terminating: false, state: "queued", submitted_unix_s: 1, started_unix_s: null, ended_unix_s: null, deadline_unix_s: null, timeout_s: 300, exit_code: null, error: null, error_kind: null, guard_projects: [], log_tail: [], result: {} };

function stubTransport(handler: (keyexpr: string, opts: TransportGetOptions) => GetReply[] | "hang" | "error") {
  const calls: { keyexpr: string; opts: TransportGetOptions }[] = [];
  const transport = {
    get: async (keyexpr: string, opts: TransportGetOptions) => {
      calls.push({ keyexpr, opts });
      const r = handler(keyexpr, opts);
      if (r === "hang") {
        vi.advanceTimersByTime(opts.timeoutMs ?? 10_000);
        return [];
      }
      if (r === "error") {
        opts.onReplyError?.("queryable exploded");
        return [];
      }
      return r;
    },
  } as unknown as Transport;
  return { transport, calls };
}

describe("encodeJobRequest", () => {
  it("emits only the fields that are set", () => {
    expect(dec(encodeJobRequest({ verb: "up" }))).toEqual({ verb: "up" });
    expect(dec(encodeJobRequest({ verb: "down", names: [], end_run: true, force: false, client: "dash" }))).toEqual({ verb: "down", end_run: true, client: "dash" });
    expect(dec(encodeJobRequest({ verb: "new-run", label: "flight1", force: true, timeout_s: 90 }))).toEqual({ verb: "new-run", label: "flight1", force: true, timeout_s: 90 });
    expect(dec(encodeJobRequest({ verb: "standby", names: ["lidar"], label: "" }))).toEqual({ verb: "standby", names: ["lidar"] });
  });
});

describe("rig client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("submit queries <key>/jobs/submit with the payload and returns the ack", async () => {
    const { transport, calls } = stubTransport(() => [{ keyexpr: `${KEY}/jobs/submit`, payload: enc({ ok: true, job_id: "j-1", job: JOB }) }]);
    const r = await submitJob(transport, KEY, { verb: "standby", names: ["lidar"], client: "dash" });
    expect(calls[0].keyexpr).toBe(`${KEY}/jobs/submit`);
    expect(dec(calls[0].opts.payload)).toEqual({ verb: "standby", names: ["lidar"], client: "dash" });
    expect(calls[0].opts.timeoutMs).toBe(5_000);
    expect(r).toMatchObject({ ok: true, job_id: "j-1", job: { argv: ["standby", "lidar"] } });
  });

  it("refusals pass through as ok:false; cancel carries the job id", async () => {
    const { transport, calls } = stubTransport(() => [{ keyexpr: KEY, payload: enc({ ok: false, error: "busy: j-0 (up) is running", job_id: "j-0" }) }]);
    expect(await submitJob(transport, KEY, { verb: "up" })).toEqual({ ok: false, error: "busy: j-0 (up) is running", job_id: "j-0" });
    await cancelJob(transport, KEY, "j-0");
    expect(calls[1].keyexpr).toBe(`${KEY}/jobs/cancel`);
    expect(dec(calls[1].opts.payload)).toEqual({ job_id: "j-0" });
  });

  it("runs + run detail", async () => {
    const { transport, calls } = stubTransport((k) =>
      k.endsWith("/runs")
        ? [{ keyexpr: k, payload: enc({ ok: true, data_dir: "/d", current: null, problem: null, runs: [{ run: "r1", state: "sealed" }] }) }]
        : [{ keyexpr: k, payload: enc({ ok: true, run: "r1", state: "sealed", dir: "/d/runs/r1", manifest: { label: "x" } }) }],
    );
    expect((await listRuns(transport, KEY)).runs[0]).toMatchObject({ run: "r1", state: "sealed" });
    expect((await getRun(transport, KEY, "r1")).manifest).toEqual({ label: "x" });
    expect(calls[1].keyexpr).toBe(`${KEY}/run/r1`);
  });

  it("distinguishes timeout, no-reply, and bad-reply", async () => {
    await expect(submitJob(stubTransport(() => "hang").transport, KEY, { verb: "up" })).rejects.toMatchObject({ kind: "timeout" });
    await expect(submitJob(stubTransport(() => []).transport, KEY, { verb: "up" })).rejects.toMatchObject({ kind: "no-reply" });
    await expect(submitJob(stubTransport(() => "error").transport, KEY, { verb: "up" })).rejects.toMatchObject({ kind: "bad-reply" });
    const err = await listRuns(stubTransport(() => [{ keyexpr: KEY, payload: new TextEncoder().encode("<html>") }]).transport, KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RigError);
    expect((err as RigError).kind).toBe("bad-reply");
  });
});
