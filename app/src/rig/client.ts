import type { Transport } from "../transport/types";
import {
  parseJobsReply,
  parseRigState,
  parseRunDetail,
  parseRunsReply,
  parseSubmitReply,
  type RigJob,
  type RigJobRequest,
  type RigRunDetail,
  type RigRunsReply,
  type RigState,
  type RigSubmitReply,
} from "./types";

/** Every agent queryable answers from a cached snapshot or the filesystem — never docker or rig —
 *  so a few seconds is generous. Verbs themselves are jobs (submit acks immediately). */
export const RIG_QUERY_TIMEOUT_MS = 5_000;

export type RigErrorKindT = "timeout" | "no-reply" | "bad-reply";

/** Transport-level failures only; contract refusals come back as `ok:false` replies. */
export class RigError extends Error {
  constructor(
    readonly kind: RigErrorKindT,
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = "RigError";
  }
}

/** The submit payload — only the fields that are set (exported for tests). */
export function encodeJobRequest(req: RigJobRequest): Uint8Array {
  const body: Record<string, unknown> = { verb: req.verb };
  if (req.names && req.names.length > 0) body.names = req.names;
  if (req.label !== undefined && req.label !== "") body.label = req.label;
  if (req.force) body.force = true;
  if (req.end_run) body.end_run = true;
  if (req.timeout_s !== undefined) body.timeout_s = req.timeout_s;
  if (req.client) body.client = req.client;
  return new TextEncoder().encode(JSON.stringify(body));
}

async function query<T>(
  transport: Transport,
  key: string,
  what: string,
  parse: (bytes: Uint8Array) => T | null,
  opts?: { payload?: Uint8Array; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? RIG_QUERY_TIMEOUT_MS;
  const started = performance.now();
  const replyErrors: string[] = [];
  const replies = await transport.get(key, {
    payload: opts?.payload,
    timeoutMs,
    onReplyError: (m) => replyErrors.push(m),
  });
  const rttMs = performance.now() - started;
  if (replies.length === 0) {
    if (replyErrors.length > 0) throw new RigError("bad-reply", key, replyErrors.join("; "));
    if (rttMs >= timeoutMs * 0.95) throw new RigError("timeout", key, `no reply to ${what} within ${timeoutMs / 1000} s`);
    throw new RigError("no-reply", key, `${what}: query completed with no reply (agent gone?)`);
  }
  const parsed = parse(replies[0].payload);
  if (parsed === null) throw new RigError("bad-reply", key, `${what}: reply is not the contract's shape`);
  return parsed;
}

/** Submit a verb as a job. Refusals (`busy`, unknown row, guard…) are `ok:false` values. */
export function submitJob(transport: Transport, agentKey: string, req: RigJobRequest, opts?: { timeoutMs?: number }): Promise<RigSubmitReply> {
  return query(transport, `${agentKey}/jobs/submit`, `submit ${req.verb}`, parseSubmitReply, {
    payload: encodeJobRequest(req),
    timeoutMs: opts?.timeoutMs,
  });
}

export function cancelJob(transport: Transport, agentKey: string, jobId: string): Promise<RigSubmitReply> {
  return query(transport, `${agentKey}/jobs/cancel`, `cancel ${jobId}`, parseSubmitReply, {
    payload: new TextEncoder().encode(JSON.stringify({ job_id: jobId })),
  });
}

export function fetchState(transport: Transport, agentKey: string): Promise<RigState> {
  return query(transport, `${agentKey}/state`, "state", parseRigState);
}

export function listRuns(transport: Transport, agentKey: string): Promise<RigRunsReply> {
  return query(transport, `${agentKey}/runs`, "runs", parseRunsReply);
}

export function getRun(transport: Transport, agentKey: string, runId: string): Promise<RigRunDetail> {
  return query(transport, `${agentKey}/run/${runId}`, `run ${runId}`, parseRunDetail);
}

export function listJobs(transport: Transport, agentKey: string): Promise<RigJob[]> {
  return query(transport, `${agentKey}/jobs`, "jobs", parseJobsReply);
}
