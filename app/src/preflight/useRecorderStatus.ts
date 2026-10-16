import { useEffect, useRef, useState } from "react";
import { useRosGraphContext } from "../ros/RosGraphContext";
import { useTransportContext } from "../transport/TransportContext";
import { callService } from "../services/callService";
import { disconnected, problem, recorderTarget, type CheckStatus } from "./status";

const TIMEOUT_MS = 2000;
const checking: CheckStatus = { level: "warn", summary: "Checking recorder", details: ["Waiting for an is_paused response."] };

/** Sequential read-only queries. Graph churn never restarts a poll; endpoint changes do. */
export function useRecorderStatus(recorder: string, domain: number | undefined, pollS: number, active: boolean, now: number): CheckStatus {
  const { graph } = useRosGraphContext();
  const { transport, status } = useTransportContext();
  const target = recorderTarget(graph, recorder, domain);
  const currentGraph = useRef(target.graph); currentGraph.current = target.graph;
  const online = status === "connected" && !!transport;
  const key = `${recorder}|${domain ?? ""}|${target.signature}`;
  const error = target.error?.summary;
  const [sample, setSample] = useState<{ key: string; transport: typeof transport; at: number; result: CheckStatus }>();
  useEffect(() => {
    setSample(undefined);
    if (!transport || !online || !active || error) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let result: CheckStatus;
      try {
        const reply = await Promise.race([
          callService(transport, currentGraph.current, `${recorder}/is_paused`, {}, { timeoutMs: TIMEOUT_MS, domainId: domain }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("No response within 2 seconds")), TIMEOUT_MS); }),
        ]);
        if (reply.warning || typeof reply.response.paused !== "boolean") throw new Error(reply.warning ?? "Invalid is_paused response");
        result = reply.response.paused
          ? { level: "warn", summary: "Recorder paused", details: ["Recorder responds, but recording is paused."] }
          : { level: "ok", summary: "Recording", details: ["Recorder reports unpaused. This does not measure file throughput."] };
      } catch (e) { result = problem("Recorder not responding", e instanceof Error ? e.message : String(e)); }
      finally { clearTimeout(deadline!); }
      if (stopped) return;
      setSample({ key, transport, at: Date.now(), result });
      timer = setTimeout(() => void poll(), pollS * 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); };
  }, [transport, online, active, key, error, recorder, domain, pollS]);
  if (!online) return disconnected();
  if (target.error) return target.error;
  if (!sample || sample.key !== key || sample.transport !== transport) return checking;
  if (now - sample.at > pollS * 1000 + TIMEOUT_MS + 1000) return problem("Recorder status stale", "No recent is_paused response.");
  return sample.result;
}
