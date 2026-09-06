import { describe, expect, it } from "vitest";
import { encodePlaybackRequest, parsePlaybackReply, playbackControl, PlaybackError } from "./playbackControl";
import type { Transport } from "../transport/types";

const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const KEY = "fleet/1/svc/playback/playback";
const DESC = { schema_version: 1, service: "camera-service", instance: "playback", source: "pcap", state: "paused", controls: ["resume"] };

function transportReplying(replies: unknown[], opts: { replyErrors?: string[]; delayMs?: number } = {}) {
  const calls: { keyexpr: string; body: unknown; timeoutMs?: number }[] = [];
  const transport = {
    get: async (keyexpr: string, o: { payload?: Uint8Array; timeoutMs?: number; onReplyError?: (m: string) => void }) => {
      calls.push({ keyexpr, body: o.payload ? dec(o.payload) : null, timeoutMs: o.timeoutMs });
      for (const m of opts.replyErrors ?? []) o.onReplyError?.(m);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return replies.map((r) => ({ keyexpr, payload: enc(r) }));
    },
  } as unknown as Transport;
  return { transport, calls };
}

describe("playback control requests (PLAYBACK.md)", () => {
  it("encodes exactly the op and its parameters", () => {
    expect(dec(encodePlaybackRequest("pause"))).toEqual({ op: "pause" });
    expect(dec(encodePlaybackRequest("set_speed", { speed: 0 }))).toEqual({ op: "set_speed", speed: 0 });
    expect(dec(encodePlaybackRequest("set_loop", { loop: false }))).toEqual({ op: "set_loop", loop: false });
  });

  it("parses replies incl. noop, pending and a refusal; rejects the wrong shape", () => {
    expect(parsePlaybackReply(enc({ ok: true, state: "paused", noop: true, descriptor: DESC }))).toMatchObject({ ok: true, noop: true, descriptor: { state: "paused" } });
    expect(parsePlaybackReply(enc({ ok: true, state: "playing", pending: true }))).toMatchObject({ pending: true });
    expect(parsePlaybackReply(enc({ ok: false, error: "unknown op 'seek'" }))).toMatchObject({ ok: false, error: "unknown op 'seek'" });
    expect(parsePlaybackReply(enc({ state: "paused" }))).toBeNull();
    expect(parsePlaybackReply(enc([1]))).toBeNull();
  });

  it("queries <key>/control with the body and returns the parsed reply + rtt", async () => {
    const { transport, calls } = transportReplying([{ ok: true, state: "paused", descriptor: DESC }]);
    const r = await playbackControl(transport, KEY, "pause");
    expect(calls[0]).toMatchObject({ keyexpr: KEY + "/control", body: { op: "pause" }, timeoutMs: 5000 });
    expect(r.ok && r.state === "paused" && r.rttMs >= 0).toBe(true);
  });

  it("a contract refusal is a result, a transport failure is an error", async () => {
    const refused = await playbackControl(transportReplying([{ ok: false, error: "playback has finished" }]).transport, KEY, "pause");
    expect(refused).toMatchObject({ ok: false, error: "playback has finished" });
    await expect(playbackControl(transportReplying([]).transport, KEY, "pause")).rejects.toMatchObject({ kind: "no-reply" });
    await expect(playbackControl(transportReplying([], { replyErrors: ["boom"] }).transport, KEY, "pause")).rejects.toMatchObject({ kind: "bad-reply" });
    await expect(playbackControl(transportReplying([{ nope: 1 }]).transport, KEY, "pause")).rejects.toBeInstanceOf(PlaybackError);
    await expect(playbackControl(transportReplying([], { delayMs: 30 }).transport, KEY, "pause", undefined, { timeoutMs: 30 })).rejects.toMatchObject({ kind: "timeout" });
  });
});
