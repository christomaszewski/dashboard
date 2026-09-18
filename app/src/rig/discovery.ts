import type { Subscription, Transport } from "../transport/types";
import {
  RIG_EVENTS_PATTERN,
  RIG_PATTERN,
  RIG_STATE_PATTERN,
  decodeJson,
  parseJobsReply,
  parseRigDescriptor,
  parseRigJob,
  parseRigKey,
  parseRigState,
  type RigAgent,
  type RigJob,
} from "./types";

/** Same grace as the lifecycle services: a restart re-declares within seconds. */
export const RIG_OFFLINE_GRACE_MS = 15_000;
/** Job records kept client-side (the agent keeps 50 too). */
export const RIG_JOBS_KEPT = 50;

export type RigChange = (agents: RigAgent[], jobs: RigJob[]) => void;

/**
 * Discovers rig agents (one per vehicle). Presence = liveliness on `fleet/*\/rig` (history-backed);
 * on PUT we `get` the descriptor, the state snapshot and the recent jobs. Live updates arrive on
 * the `…/state` and `…/jobs/events` publications, so a stack flipping, a run opening from a shell,
 * or a job's log tail reach every viewer without polling.
 */
export class RigDiscovery {
  private tokenSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private eventsSub: Subscription | null = null;
  private readonly agents = new Map<string, RigAgent>();
  private readonly jobs = new Map<string, RigJob>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();
  private onChange: RigChange = () => undefined;

  constructor(
    private readonly transport: Transport,
    private readonly graceMs: number = RIG_OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: RigChange): Promise<void> {
    this.onChange = onChange;
    this.tokenSub = await this.transport.liveliness.subscribe(RIG_PATTERN, (e) => {
      if (!parseRigKey(e.keyexpr)) return;
      if (!e.alive) {
        const entry = this.agents.get(e.keyexpr);
        if (!entry) return;
        this.agents.set(e.keyexpr, { ...entry, alive: false });
        this.cancelRemoval(e.keyexpr);
        this.removals.set(
          e.keyexpr,
          setTimeout(() => {
            this.removals.delete(e.keyexpr);
            if (this.agents.get(e.keyexpr)?.alive === false) {
              this.agents.delete(e.keyexpr);
              this.emit();
            }
          }, this.graceMs),
        );
        this.emit();
        return;
      }
      this.cancelRemoval(e.keyexpr);
      void this.fetchAll(e.keyexpr);
    });

    this.stateSub = await this.transport.subscribe(RIG_STATE_PATTERN, (s) => {
      if (s.kind !== "put") return;
      this.applyState(s.keyexpr.replace(/\/state$/, ""), s.payload);
    });

    this.eventsSub = await this.transport.subscribe(RIG_EVENTS_PATTERN, (s) => {
      if (s.kind !== "put") return;
      const key = s.keyexpr.replace(/\/jobs\/events$/, "");
      if (!parseRigKey(key)) return;
      const job = parseRigJob(decodeJson(s.payload));
      if (!job) return;
      this.upsertJob(job);
      this.emit();
    });
  }

  /** Re-read the state + jobs of every known agent (after a reconnect, or on demand). */
  async refresh(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((key) => Promise.all([this.fetchState(key), this.fetchJobs(key)])));
  }

  private emit(): void {
    const agents = [...this.agents.values()].sort((a, b) => a.key.localeCompare(b.key));
    const jobs = [...this.jobs.values()].sort((a, b) => b.submitted_unix_s - a.submitted_unix_s).slice(0, RIG_JOBS_KEPT);
    this.onChange(agents, jobs);
  }

  private cancelRemoval(key: string): void {
    const t = this.removals.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.removals.delete(key);
    }
  }

  private applyDescriptor(key: string, payload: Uint8Array): boolean {
    const parsed = parseRigKey(key);
    const descriptor = parseRigDescriptor(payload);
    if (!parsed || !descriptor) return false;
    if (descriptor.vehicle_id !== parsed.vehicleId) return false; // contract: must equal the key segment
    const existing = this.agents.get(key);
    this.agents.set(key, { key, vehicleId: parsed.vehicleId, descriptor, alive: true, state: existing?.state });
    if (descriptor.job) this.upsertJob(descriptor.job);
    this.emit();
    return true;
  }

  private applyState(key: string, payload: Uint8Array): void {
    const parsed = parseRigKey(key);
    const state = parseRigState(payload);
    if (!parsed || !state || state.vehicle_id !== parsed.vehicleId) return;
    const existing = this.agents.get(key);
    if (existing) {
      this.agents.set(key, { ...existing, alive: true, state });
    } else {
      // A publication before the token (or a missed one): stand the entry up on a minimal
      // descriptor and fetch the real one.
      this.agents.set(key, {
        key,
        vehicleId: parsed.vehicleId,
        descriptor: { schema_version: state.schema_version, service: "rig-agent", vehicle_id: state.vehicle_id, vehicle: state.vehicle },
        alive: true,
        state,
      });
      void this.fetchDescriptor(key);
    }
    if (state.job) this.upsertJob(state.job);
    this.emit();
  }

  private upsertJob(job: RigJob): void {
    this.jobs.set(job.job_id, job);
    if (this.jobs.size > RIG_JOBS_KEPT * 2) {
      const keep = [...this.jobs.values()].sort((a, b) => b.submitted_unix_s - a.submitted_unix_s).slice(0, RIG_JOBS_KEPT);
      this.jobs.clear();
      for (const j of keep) this.jobs.set(j.job_id, j);
    }
  }

  private async fetchAll(key: string): Promise<void> {
    await this.fetchDescriptor(key);
    await Promise.all([this.fetchState(key), this.fetchJobs(key)]);
  }

  private async fetchDescriptor(key: string): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (reply) this.applyDescriptor(key, reply.payload);
    } catch {
      // best-effort; the next publication or token re-PUT retries
    }
  }

  private async fetchState(key: string): Promise<void> {
    try {
      const [reply] = await this.transport.get(`${key}/state`);
      if (reply) this.applyState(key, reply.payload);
    } catch {
      // best-effort
    }
  }

  private async fetchJobs(key: string): Promise<void> {
    try {
      const [reply] = await this.transport.get(`${key}/jobs`);
      if (!reply) return;
      const jobs = parseJobsReply(reply.payload);
      if (!jobs) return;
      for (const job of jobs) this.upsertJob(job);
      this.emit();
    } catch {
      // best-effort
    }
  }

  async stop(): Promise<void> {
    await this.tokenSub?.close();
    await this.stateSub?.close();
    await this.eventsSub?.close();
    this.tokenSub = this.stateSub = this.eventsSub = null;
    for (const key of this.removals.keys()) this.cancelRemoval(key);
    this.agents.clear();
    this.jobs.clear();
  }
}
