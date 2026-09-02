import type { Transport } from "../transport/types";
import { parseLifecycleDescriptor, type LifecycleDescriptor } from "./types";

/** The reply is sent when the transition COMPLETES — a deactivate finalizes files first (≤5 s,
 *  ≤10 s worst case), so the contract asks clients for a ≥15 s query timeout. */
export const CHANGE_STATE_TIMEOUT_MS = 20_000;

export interface ChangeStateResult {
  ok: boolean;
  state?: string;
  noop?: boolean;
  /** Set on ok:false — a refusal (e.g. "recording disabled by config"), never a zenoh error. */
  error?: string;
  descriptor?: LifecycleDescriptor;
  rttMs: number;
}

export type LifecycleErrorKind = "timeout" | "no-reply" | "bad-reply";

/** Transport-level failures only; contract refusals come back as `ok:false` results. */
export class LifecycleError extends Error {
  constructor(
    readonly kind: LifecycleErrorKind,
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

/** Build the change_state request payload (exported for tests). */
export function encodeChangeState(transition: string, runId?: string): Uint8Array {
  const body: Record<string, string> = { transition };
  if (runId !== undefined && runId !== "") body.run_id = runId;
  return new TextEncoder().encode(JSON.stringify(body));
}

/** Parse a change_state reply; null = not the contract's shape. */
export function parseChangeStateReply(bytes: Uint8Array): Omit<ChangeStateResult, "rttMs"> | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const r = obj as Record<string, unknown>;
    if (typeof r.ok !== "boolean") return null;
    const out: Omit<ChangeStateResult, "rttMs"> = { ok: r.ok };
    if (typeof r.state === "string") out.state = r.state;
    if (typeof r.noop === "boolean") out.noop = r.noop;
    if (typeof r.error === "string") out.error = r.error;
    if (r.descriptor !== undefined) {
      const d = parseLifecycleDescriptor(new TextEncoder().encode(JSON.stringify(r.descriptor)));
      if (d) out.descriptor = d;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Request a lifecycle transition: one query on `<key>/change_state` carrying the JSON request as
 * its payload; the single reply is the result. `key` is the service's lifecycle key.
 */
export async function changeState(
  transport: Transport,
  key: string,
  transition: string,
  opts?: { runId?: string; timeoutMs?: number },
): Promise<ChangeStateResult> {
  const timeoutMs = opts?.timeoutMs ?? CHANGE_STATE_TIMEOUT_MS;
  const started = performance.now();
  const replyErrors: string[] = [];
  const replies = await transport.get(`${key}/change_state`, {
    payload: encodeChangeState(transition, opts?.runId),
    timeoutMs,
    onReplyError: (m) => replyErrors.push(m),
  });
  const rttMs = performance.now() - started;
  if (replies.length === 0) {
    if (replyErrors.length > 0) throw new LifecycleError("bad-reply", key, replyErrors.join("; "));
    if (rttMs >= timeoutMs * 0.95)
      throw new LifecycleError("timeout", key, `no reply to ${transition} within ${timeoutMs / 1000} s`);
    throw new LifecycleError("no-reply", key, `${transition}: query completed with no reply (service gone?)`);
  }
  const parsed = parseChangeStateReply(replies[0].payload);
  if (!parsed) throw new LifecycleError("bad-reply", key, `${transition}: reply is not a change_state result`);
  return { ...parsed, rttMs };
}
