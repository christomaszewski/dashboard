import type { Transport } from "../transport/types";
import { parsePlaybackDescriptor, type PlaybackDescriptor, type PlaybackOp } from "./types";

/** The contract says a request takes effect sub-second; 5 s is generous. */
export const PLAYBACK_CONTROL_TIMEOUT_MS = 5_000;

export interface PlaybackResult {
  ok: boolean;
  state?: string;
  noop?: boolean;
  /** The producer accepted a restart but the feeder hadn't taken it within its bound. */
  pending?: boolean;
  error?: string;
  descriptor?: PlaybackDescriptor;
  rttMs: number;
}

export type PlaybackErrorKind = "timeout" | "no-reply" | "bad-reply";

export class PlaybackError extends Error {
  constructor(
    readonly kind: PlaybackErrorKind,
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaybackError";
  }
}

export interface PlaybackParams {
  speed?: number;
  loop?: boolean;
}

export function encodePlaybackRequest(op: PlaybackOp, params?: PlaybackParams): Uint8Array {
  const body: Record<string, unknown> = { op };
  if (params?.speed !== undefined) body.speed = params.speed;
  if (params?.loop !== undefined) body.loop = params.loop;
  return new TextEncoder().encode(JSON.stringify(body));
}

export function parsePlaybackReply(bytes: Uint8Array): Omit<PlaybackResult, "rttMs"> | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const r = obj as Record<string, unknown>;
    if (typeof r.ok !== "boolean") return null;
    const out: Omit<PlaybackResult, "rttMs"> = { ok: r.ok };
    if (typeof r.state === "string") out.state = r.state;
    if (typeof r.noop === "boolean") out.noop = r.noop;
    if (typeof r.pending === "boolean") out.pending = r.pending;
    if (typeof r.error === "string") out.error = r.error;
    if (r.descriptor !== undefined) {
      const d = parsePlaybackDescriptor(new TextEncoder().encode(JSON.stringify(r.descriptor)));
      if (d) out.descriptor = d;
    }
    return out;
  } catch {
    return null;
  }
}

/** One query on `<key>/control` carrying the JSON request; the single reply is the result. */
export async function playbackControl(
  transport: Transport,
  key: string,
  op: PlaybackOp,
  params?: PlaybackParams,
  opts?: { timeoutMs?: number },
): Promise<PlaybackResult> {
  const timeoutMs = opts?.timeoutMs ?? PLAYBACK_CONTROL_TIMEOUT_MS;
  const started = performance.now();
  const replyErrors: string[] = [];
  const replies = await transport.get(`${key}/control`, {
    payload: encodePlaybackRequest(op, params),
    timeoutMs,
    onReplyError: (m) => replyErrors.push(m),
  });
  const rttMs = performance.now() - started;
  if (replies.length === 0) {
    if (replyErrors.length > 0) throw new PlaybackError("bad-reply", key, replyErrors.join("; "));
    if (rttMs >= timeoutMs * 0.95) throw new PlaybackError("timeout", key, `no reply to ${op} within ${timeoutMs / 1000} s`);
    throw new PlaybackError("no-reply", key, `${op}: query completed with no reply (service gone?)`);
  }
  const parsed = parsePlaybackReply(replies[0].payload);
  if (!parsed) throw new PlaybackError("bad-reply", key, `${op}: reply is not a playback control result`);
  return { ...parsed, rttMs };
}
