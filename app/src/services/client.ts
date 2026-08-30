// Per-transport client identity + the raw query primitive. The dashboard deliberately declares no
// SC liveliness token (the graph cache is introspection-only) — servers answer queries regardless;
// the only visible consequence is `ros2 service list -v` not counting the dashboard as a client.
import type { GetReply, Transport } from "../transport/types";
import { GID_LENGTH, encodeAttachment } from "./attachment";

interface ClientState {
  gid: Uint8Array; // random per transport session (browser tab)
  nextSeq: bigint;
}

const states = new WeakMap<Transport, ClientState>();

export function clientState(transport: Transport): ClientState {
  let s = states.get(transport);
  if (!s) {
    const gid = new Uint8Array(GID_LENGTH);
    crypto.getRandomValues(gid);
    s = { gid, nextSeq: 1n };
    states.set(transport, s);
  }
  return s;
}

export interface RawCallResult {
  replies: GetReply[];
  seq: bigint;
  elapsedMs: number;
  replyErrors: string[];
}

/** One service-shaped query: rmw attachment + CDR payload, ALL_COMPLETE / no consolidation
 *  (mirrors rmw_zenoh's own rmw_send_request options). */
export async function rawCall(
  transport: Transport,
  keyexpr: string,
  payload: Uint8Array,
  timeoutMs: number,
): Promise<RawCallResult> {
  const state = clientState(transport);
  const seq = state.nextSeq++;
  const attachment = encodeAttachment({
    sequenceNumber: seq,
    sourceTimestamp: BigInt(Date.now()) * 1_000_000n,
    gid: state.gid,
  });
  const replyErrors: string[] = [];
  const started = performance.now();
  const replies = await transport.get(keyexpr, {
    payload,
    attachment,
    timeoutMs,
    target: "all-complete",
    consolidation: "none",
    onReplyError: (m) => replyErrors.push(m),
  });
  return { replies, seq, elapsedMs: performance.now() - started, replyErrors };
}
