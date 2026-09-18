// The rig-over-zenoh contract — docs/RIG_AGENT.md is the source of truth:
//
//   fleet/<vid>/rig               liveliness token + queryable → descriptor
//   fleet/<vid>/rig/state         publisher + queryable → state snapshot
//   fleet/<vid>/rig/runs          queryable → run registry rows
//   fleet/<vid>/rig/run/<id>      queryable → one run's manifest
//   fleet/<vid>/rig/jobs          queryable → recent job records
//   fleet/<vid>/rig/jobs/submit   queryable, {verb,…} → {ok, job_id, job} | {ok:false, error}
//   fleet/<vid>/rig/jobs/cancel   queryable, {job_id} → {ok, job}
//   fleet/<vid>/rig/jobs/events   publisher: a job record on every transition
//
// One agent per vehicle (the deployment is the noun). Only the fields the parsers check below are
// REQUIRED; everything else is optional and passes through (additive versioning).

export const RIG_PATTERN = "fleet/*/rig";
export const RIG_STATE_PATTERN = "fleet/*/rig/state";
export const RIG_EVENTS_PATTERN = "fleet/*/rig/jobs/events";

export type RigVerb = "standby" | "activate" | "up" | "down" | "new-run" | "end-run";
export const RIG_VERBS: readonly RigVerb[] = ["standby", "activate", "up", "down", "new-run", "end-run"];

export type RigJobState = "queued" | "running" | "succeeded" | "failed" | "killed" | "cancelled";
export const JOB_STATES: readonly RigJobState[] = ["queued", "running", "succeeded", "failed", "killed", "cancelled"];
export const TERMINAL_JOB_STATES: readonly RigJobState[] = ["succeeded", "failed", "killed", "cancelled"];

export type RigErrorKind = "guard-running" | "guard-cannot-tell" | "bad-label" | "no-data-dir" | "timeout" | "other";
export type RigRunState = "OPEN" | "sealed" | "interrupted" | "corrupt" | "dangling";

export interface RigDescriptor {
  schema_version: number;
  service: string; // "rig-agent"
  vehicle_id: string; // MUST equal the key's <vid> segment
  vehicle?: string;
  agent_version?: string;
  rig_version?: string | null;
  root?: string;
  data_dir?: string | null;
  capabilities?: { actuate?: boolean; verbs?: string[]; jobs?: boolean };
  self_instance?: string | null; // the vehicle.yaml row hosting the agent
  poll_s?: number;
  since_unix_s?: number;
  job?: RigJob | null;
}

export interface RigStackRow {
  name: string;
  service: string;
  tier: string; // infra | sensor | autonomy
  order: number;
  enabled: boolean;
  project: string;
  state: string; // rig status roll-up: running | partial | down
  health: string; // healthy | unhealthy | starting | n/a | -
  op_state: string | null; // active | standby | transitioning | down | unknown; null = no trio
  running: number;
  total: number;
  state_verbs: boolean; // declares rig's standby/activate/state trio
  self: boolean; // hosts the agent (the dashboard's own row)
}

export interface RigOpenRun {
  id: string;
  label: string | null;
  started: string | null;
  stacks: string[];
  config?: string | null;
  disk_kb?: number | null;
  corrupt?: boolean;
}

export interface RigRegistryInfo {
  data_dir: string | null;
  free_kb: number | null;
  problem: string | null;
}

export interface RigState {
  schema_version: number;
  vehicle_id: string;
  vehicle: string;
  at_unix_s: number;
  ok: boolean;
  error: string | null;
  rig_version?: string | null;
  run: RigOpenRun | null;
  registry: RigRegistryInfo;
  stacks: RigStackRow[];
  job?: RigJob | null;
}

export interface RigJobResult {
  run_before?: string | null;
  run_after?: string | null;
  sealed?: string | null;
  opened?: string | null;
}

export interface RigJob {
  job_id: string;
  verb: string;
  args: Record<string, unknown>;
  argv: string[];
  client: string | null;
  self_terminating: boolean;
  state: RigJobState;
  submitted_unix_s: number;
  started_unix_s: number | null;
  ended_unix_s: number | null;
  deadline_unix_s: number | null;
  timeout_s: number;
  exit_code: number | null;
  error: string | null;
  error_kind: RigErrorKind | null;
  guard_projects: string[];
  log_tail: string[];
  result: RigJobResult;
}

export interface RigJobRequest {
  verb: RigVerb;
  names?: string[];
  label?: string;
  force?: boolean;
  end_run?: boolean;
  timeout_s?: number;
  client?: string;
}

export interface RigSubmitReply {
  ok: boolean;
  job_id?: string;
  job?: RigJob;
  error?: string;
}

export interface RigRunRow {
  run: string;
  label: string | null;
  state: RigRunState;
  started: string | null;
  ended: string | null;
  disk_kb: number | null;
  replay_of: string | null;
  linked: boolean;
}

export interface RigRunsReply {
  ok: boolean;
  data_dir: string | null;
  current: string | null;
  problem: string | null;
  runs: RigRunRow[];
  error?: string;
}

export interface RigRunDetail {
  ok: boolean;
  run?: string;
  state?: string;
  dir?: string;
  manifest?: Record<string, unknown>;
  error?: string;
}

export interface RigAgent {
  key: string; // fleet/<vid>/rig
  vehicleId: string;
  descriptor: RigDescriptor;
  /** false = liveliness token dropped; held for a grace period (restarts re-advertise). */
  alive: boolean;
  state?: RigState;
}

/** `fleet/<vid>/rig` → its segment, or null for anything else. */
export function parseRigKey(key: string): { vehicleId: string } | null {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "fleet" || parts[2] !== "rig" || parts[1] === "") return null;
  return { vehicleId: parts[1] };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseRigDescriptor(bytes: Uint8Array): RigDescriptor | null {
  const d = decodeJson(bytes);
  if (!isRecord(d)) return null;
  if (typeof d.schema_version !== "number" || typeof d.service !== "string") return null;
  if (typeof d.vehicle_id !== "string" && typeof d.vehicle_id !== "number") return null;
  const job = d.job === undefined || d.job === null ? d.job : parseRigJob(d.job);
  return { ...d, vehicle_id: String(d.vehicle_id), job: job ?? null } as unknown as RigDescriptor;
}

export function parseRigStackRow(v: unknown): RigStackRow | null {
  if (!isRecord(v) || typeof v.name !== "string") return null;
  return {
    name: v.name,
    service: optStr(v.service) ?? "",
    tier: optStr(v.tier) ?? "sensor",
    order: optNum(v.order) ?? 0,
    enabled: v.enabled !== false,
    project: optStr(v.project) ?? v.name,
    state: optStr(v.state) ?? "down",
    health: optStr(v.health) ?? "n/a",
    op_state: optStr(v.op_state),
    running: optNum(v.running) ?? 0,
    total: optNum(v.total) ?? 0,
    state_verbs: v.state_verbs === true,
    self: v.self === true,
  };
}

export function parseRigState(bytes: Uint8Array): RigState | null {
  const d = decodeJson(bytes);
  if (!isRecord(d)) return null;
  if (typeof d.schema_version !== "number" || typeof d.at_unix_s !== "number") return null;
  if (typeof d.vehicle_id !== "string" && typeof d.vehicle_id !== "number") return null;
  if (!Array.isArray(d.stacks)) return null;
  const stacks = d.stacks.map(parseRigStackRow).filter((r): r is RigStackRow => r !== null);
  const run = isRecord(d.run) && typeof d.run.id === "string"
    ? {
        id: d.run.id,
        label: optStr(d.run.label),
        started: optStr(d.run.started),
        stacks: strArray(d.run.stacks),
        config: optStr(d.run.config),
        disk_kb: optNum(d.run.disk_kb),
        corrupt: d.run.corrupt === true,
      }
    : null;
  const reg = isRecord(d.registry) ? d.registry : {};
  const job = d.job === undefined || d.job === null ? null : parseRigJob(d.job);
  return {
    schema_version: d.schema_version,
    vehicle_id: String(d.vehicle_id),
    vehicle: optStr(d.vehicle) ?? "",
    at_unix_s: d.at_unix_s,
    ok: d.ok !== false,
    error: optStr(d.error),
    rig_version: optStr(d.rig_version),
    run,
    registry: { data_dir: optStr(reg.data_dir), free_kb: optNum(reg.free_kb), problem: optStr(reg.problem) },
    stacks,
    job,
  };
}

/** A job record from any carrier (event payload, list entry, embedded in the descriptor). */
export function parseRigJob(v: unknown): RigJob | null {
  if (!isRecord(v) || typeof v.job_id !== "string" || typeof v.verb !== "string") return null;
  const state = typeof v.state === "string" && (JOB_STATES as readonly string[]).includes(v.state) ? (v.state as RigJobState) : "failed";
  const kind = typeof v.error_kind === "string" ? (v.error_kind as RigErrorKind) : null;
  return {
    job_id: v.job_id,
    verb: v.verb,
    args: isRecord(v.args) ? v.args : {},
    argv: strArray(v.argv),
    client: optStr(v.client),
    self_terminating: v.self_terminating === true,
    state,
    submitted_unix_s: optNum(v.submitted_unix_s) ?? 0,
    started_unix_s: optNum(v.started_unix_s),
    ended_unix_s: optNum(v.ended_unix_s),
    deadline_unix_s: optNum(v.deadline_unix_s),
    timeout_s: optNum(v.timeout_s) ?? 0,
    exit_code: optNum(v.exit_code),
    error: optStr(v.error),
    error_kind: kind,
    guard_projects: strArray(v.guard_projects),
    log_tail: strArray(v.log_tail),
    result: isRecord(v.result) ? (v.result as RigJobResult) : {},
  };
}

export function parseJobsReply(bytes: Uint8Array): RigJob[] | null {
  const d = decodeJson(bytes);
  if (!isRecord(d) || !Array.isArray(d.jobs)) return null;
  return d.jobs.map(parseRigJob).filter((j): j is RigJob => j !== null);
}

export function parseSubmitReply(bytes: Uint8Array): RigSubmitReply | null {
  const d = decodeJson(bytes);
  if (!isRecord(d) || typeof d.ok !== "boolean") return null;
  const out: RigSubmitReply = { ok: d.ok };
  if (typeof d.job_id === "string") out.job_id = d.job_id;
  if (typeof d.error === "string") out.error = d.error;
  const job = parseRigJob(d.job);
  if (job) out.job = job;
  return out;
}

const RUN_STATES: readonly string[] = ["OPEN", "sealed", "interrupted", "corrupt", "dangling"];

export function parseRunRow(v: unknown): RigRunRow | null {
  if (!isRecord(v) || typeof v.run !== "string") return null;
  return {
    run: v.run,
    label: optStr(v.label),
    state: typeof v.state === "string" && RUN_STATES.includes(v.state) ? (v.state as RigRunState) : "corrupt",
    started: optStr(v.started),
    ended: optStr(v.ended),
    disk_kb: optNum(v.disk_kb),
    replay_of: optStr(v.replay_of),
    linked: v.linked === true,
  };
}

export function parseRunsReply(bytes: Uint8Array): RigRunsReply | null {
  const d = decodeJson(bytes);
  if (!isRecord(d) || typeof d.ok !== "boolean") return null;
  const runs = Array.isArray(d.runs) ? d.runs.map(parseRunRow).filter((r): r is RigRunRow => r !== null) : [];
  return {
    ok: d.ok,
    data_dir: optStr(d.data_dir),
    current: optStr(d.current),
    problem: optStr(d.problem),
    runs,
    error: optStr(d.error) ?? undefined,
  };
}

export function parseRunDetail(bytes: Uint8Array): RigRunDetail | null {
  const d = decodeJson(bytes);
  if (!isRecord(d) || typeof d.ok !== "boolean") return null;
  if (!d.ok) return { ok: false, error: optStr(d.error) ?? "unknown error" };
  if (typeof d.run !== "string") return null;
  return {
    ok: true,
    run: d.run,
    state: optStr(d.state) ?? undefined,
    dir: optStr(d.dir) ?? undefined,
    manifest: isRecord(d.manifest) ? d.manifest : {},
  };
}

export function isTerminalJob(job: RigJob): boolean {
  return TERMINAL_JOB_STATES.includes(job.state);
}

// ---- levels (pill colors) -------------------------------------------------------------------

export type Level = "ok" | "idle" | "warn" | "err";

export function runStateLevel(state: RigRunState): Level {
  return state === "OPEN" ? "ok" : state === "sealed" ? "idle" : state === "interrupted" ? "warn" : "err";
}

/** Compose roll-up + health, read as the pair rig prints them. */
export function stackLevel(row: RigStackRow): Level {
  if (!row.enabled) return "idle";
  if (row.state === "running") return row.health === "unhealthy" ? "err" : row.health === "starting" ? "warn" : "ok";
  if (row.state === "partial") return "warn";
  return "idle";
}

export function opStateLevel(op: string | null): Level {
  switch (op) {
    case "active":
      return "ok";
    case "standby":
    case "down":
      return "idle";
    case "transitioning":
      return "warn";
    default:
      return "warn";
  }
}

export function jobStateLevel(state: RigJobState): Level {
  switch (state) {
    case "succeeded":
      return "ok";
    case "queued":
    case "running":
      return "warn";
    case "cancelled":
      return "idle";
    default:
      return "err";
  }
}
