import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport/types";
import { RigDiscovery } from "./discovery";
import type { RigAgent, RigJob } from "./types";

/** Live rig agents + job records for a connected transport (one RigDiscovery per app). */
export function useRig(transport: Transport | null): { agents: RigAgent[]; jobs: RigJob[]; refresh: () => Promise<void> } {
  const [agents, setAgents] = useState<RigAgent[]>([]);
  const [jobs, setJobs] = useState<RigJob[]>([]);
  const discovery = useRef<RigDiscovery | null>(null);

  useEffect(() => {
    if (!transport) return;
    const d = new RigDiscovery(transport);
    discovery.current = d;
    void d.start((a, j) => {
      setAgents(a);
      setJobs(j);
    });
    return () => {
      discovery.current = null;
      void d.stop();
      setAgents([]);
      setJobs([]);
    };
  }, [transport]);

  const refresh = useCallback(async () => {
    await discovery.current?.refresh();
  }, []);

  return { agents, jobs, refresh };
}
