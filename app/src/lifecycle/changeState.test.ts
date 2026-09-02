import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeState, encodeChangeState, LifecycleError, parseChangeStateReply } from "./changeState";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";

const KEY = "fleet/veh1/svc/cam0/lifecycle";
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b));

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

describe("change_state request/reply encoding", () => {
  it("encodes the transition and omits an empty run_id", () => {
    expect(dec(encodeChangeState("activate"))).toEqual({ transition: "activate" });
    expect(dec(encodeChangeState("activate", ""))).toEqual({ transition: "activate" });
    expect(dec(encodeChangeState("activate", "survey-3"))).toEqual({ transition: "activate", run_id: "survey-3" });
  });

  it("parses replies and rejects non-contract shapes", () => {
    expect(parseChangeStateReply(enc({ ok: true, state: "active", noop: true }))).toEqual({ ok: true, state: "active", noop: true });
    expect(parseChangeStateReply(enc({ ok: false, error: "recording disabled by config" }))).toMatchObject({ ok: false, error: "recording disabled by config" });
    expect(parseChangeStateReply(enc({ state: "active" }))).toBeNull();
    expect(parseChangeStateReply(new TextEncoder().encode("nope"))).toBeNull();
  });
});

describe("changeState", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("queries <key>/change_state with the JSON payload and a ≥15 s timeout, returns the parsed result", async () => {
    const descriptor = { schema_version: 1, service: "camera-service", instance: "cam0", state: "active", transitions: ["deactivate"] };
    const { transport, calls } = stubTransport(() => [{ keyexpr: `${KEY}/change_state`, payload: enc({ ok: true, state: "active", descriptor }) }]);
    const result = await changeState(transport, KEY, "activate", { runId: "survey-3" });
    expect(calls[0].keyexpr).toBe(`${KEY}/change_state`);
    expect(dec(calls[0].opts.payload)).toEqual({ transition: "activate", run_id: "survey-3" });
    expect(calls[0].opts.timeoutMs).toBeGreaterThanOrEqual(15_000);
    expect(result).toMatchObject({ ok: true, state: "active", descriptor: { instance: "cam0" } });
  });

  it("passes contract refusals through as ok:false, not errors", async () => {
    const { transport } = stubTransport(() => [{ keyexpr: KEY, payload: enc({ ok: false, state: "inactive", error: "recording disabled by config" }) }]);
    const result = await changeState(transport, KEY, "activate");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  it("distinguishes timeout, no-reply, and bad-reply", async () => {
    await expect(changeState(stubTransport(() => "hang").transport, KEY, "deactivate", { timeoutMs: 15_000 })).rejects.toMatchObject({ kind: "timeout" });
    await expect(changeState(stubTransport(() => []).transport, KEY, "deactivate")).rejects.toMatchObject({ kind: "no-reply" });
    await expect(changeState(stubTransport(() => "error").transport, KEY, "deactivate")).rejects.toMatchObject({ kind: "bad-reply" });
    const garbage = stubTransport(() => [{ keyexpr: KEY, payload: new TextEncoder().encode("<html>") }]).transport;
    const err = await changeState(garbage, KEY, "deactivate").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LifecycleError);
    expect((err as LifecycleError).kind).toBe("bad-reply");
  });
});
