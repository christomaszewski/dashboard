import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { cancelJob, submitJob } from "./client";
import { useRig } from "./useRig";
import { isTerminalJob, type RigAgent, type RigJob, type RigJobRequest, type RigStackRow, type RigState, type RigSubmitReply } from "./types";

/** A snapshot older than this many poll periods is shown as stale. */
export const RIG_STALE_POLLS = 3;
const CLOCK_TICK_MS = 5_000;

export interface RigContextValue {
  /** The vehicle's agent (the single alive one; the first when several advertise). */
  agent: RigAgent | null;
  agents: RigAgent[];
  state: RigState | null;
  /** Job records, newest first (live events + the agent's history). */
  jobs: RigJob[];
  runningJob: RigJob | null;
  /** No state publication for > 3 poll periods (the agent may be wedged behind a slow rig). */
  stale: boolean;
  /** Milliseconds, ticking every few seconds — for "ago" displays. */
  now: number;
  submit: (req: RigJobRequest) => Promise<RigSubmitReply>;
  cancel: (jobId: string) => Promise<RigSubmitReply>;
  stack: (name: string) => RigStackRow | undefined;
  refresh: () => Promise<void>;
}

const Ctx = createContext<RigContextValue | null>(null);

function clientTag(): string {
  const host = typeof window !== "undefined" && window.location ? window.location.host : "";
  return host ? `dashboard @ ${host}` : "dashboard";
}

export function RigProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const { agents, jobs, refresh } = useRig(transport);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const value = useMemo<RigContextValue>(() => {
    const agent = agents.find((a) => a.alive) ?? agents[0] ?? null;
    const state = agent?.state ?? null;
    const runningJob = jobs.find((j) => !isTerminalJob(j)) ?? null;
    const pollS = agent?.descriptor.poll_s ?? 10;
    const stale = state !== null && now / 1000 - state.at_unix_s > RIG_STALE_POLLS * pollS;
    const noAgent = (): Promise<RigSubmitReply> => Promise.resolve({ ok: false, error: "no rig agent" });
    return {
      agent,
      agents,
      state,
      jobs,
      runningJob,
      stale,
      now,
      submit: (req) => (transport && agent ? submitJob(transport, agent.key, { ...req, client: req.client ?? clientTag() }) : noAgent()),
      cancel: (jobId) => (transport && agent ? cancelJob(transport, agent.key, jobId) : noAgent()),
      stack: (name) => state?.stacks.find((s) => s.name === name),
      refresh,
    };
  }, [agents, jobs, now, transport, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRigContext(): RigContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRigContext must be used inside <RigProvider>");
  return v;
}
