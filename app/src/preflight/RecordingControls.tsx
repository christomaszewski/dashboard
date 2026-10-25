import { useEffect, useRef, useState } from "react";
import { useHealthContext } from "../health/HealthContext";
import { useLifecycleContext } from "../lifecycle/LifecycleContext";
import { servicePrefixQuery, useScopedGraph } from "../ros/useLivelinessGraph";
import { useTransportContext } from "../transport/TransportContext";
import { RecordingIssues } from "./RecordingIssues";
import {
  commandRecording, recordingTargets, resolveRecordingTarget,
  type RecordingAction, type RecordingCheck, type RecordingResult, type RecordingTarget,
} from "./recording";

type Row = { id: string; target: RecordingTarget; result?: RecordingResult };
type Batch = { action: RecordingAction; rows: Row[] };
// Includes ROS type resolution, the command and verification; camera finalization has a 20 s query.
const DEADLINE_MS = 25_000;

export function RecordingControls({ checks }: { checks: RecordingCheck[] }) {
  const { services: health } = useHealthContext();
  const { services: cameras } = useLifecycleContext();
  const graph = useScopedGraph(checks.flatMap((c) => (c.type === "bag_recording" ? [servicePrefixQuery(c.recorder)] : [])), { withServerNodes: true });
  const { transport, status } = useTransportContext();
  const online = !!transport && status === "connected";
  const connection = useRef({ transport, online }); connection.current = { transport, online };
  const generation = useRef(0);
  const locked = useRef(false);
  const [batch, setBatch] = useState<Batch>();
  const targets = recordingTargets(checks, graph, cameras, health);

  useEffect(() => {
    ++generation.current;
    locked.current = false;
    setBatch(old => old && ({ ...old, rows: old.rows.map(row => row.result ? row : {
      ...row, result: { kind: "error", message: "Connection changed; recording state unknown. Retry when connected." },
    }) }));
    return () => { ++generation.current; locked.current = false; };
  }, [transport, online]);

  const run = async (action: RecordingAction, retry = false) => {
    if (!transport || !online || locked.current || !targets.length) return;
    locked.current = true;
    const version = ++generation.current;
    const current = () => generation.current === version && connection.current.transport === transport && connection.current.online;
    const rows: Row[] = retry && batch ? batch.rows.map(row => row.result?.kind === "error"
      ? { id: row.id, target: resolveRecordingTarget(row.target.check, graph, cameras, health) }
      : row) : targets.map(target => ({ id: target.id, target }));
    setBatch({ action, rows });
    const jobs = new Map<string, Promise<RecordingResult>>();
    const execute = async (target: RecordingTarget): Promise<RecordingResult> => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      let result: RecordingResult;
      try {
        result = await Promise.race([
          commandRecording(target, action, transport, () => current() && !expired),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => { expired = true; reject(new Error("Recording command timed out; state unknown. Check status before retrying.")); }, DEADLINE_MS);
          }),
        ]);
      } catch (e) { result = { kind: "error", message: e instanceof Error ? e.message : String(e) }; }
      finally { clearTimeout(deadline); }
      return result;
    };
    await Promise.allSettled(rows.filter(row => !row.result).map(async row => {
      // Previously missing aliases can resolve to one device on retry. Share that command too.
      let job = jobs.get(row.target.id);
      if (!job) { job = execute(row.target); jobs.set(row.target.id, job); }
      const result = await job;
      if (!current()) return;
      setBatch(old => old && ({ ...old, rows: old.rows.map(r => r.id === row.id ? { ...r, result } : r) }));
    }));
    if (current()) locked.current = false;
  };

  const pending = batch?.rows.filter(r => !r.result).length ?? 0;
  const issues = batch?.rows.filter(r => r.result && r.result.kind !== "ok") ?? [];
  const failed = issues.some(r => r.result?.kind === "error");
  const disabled = !online || !!pending || !targets.length;

  return <div className="preflight-recording" role="group" aria-label="Recording controls" aria-busy={!!pending}>
    <button className="preflight-recording-button" aria-label="Record all" title={pending && batch?.action === "start" ? "Starting recording…" : "Record all"}
      disabled={disabled} onClick={() => void run("start")}>
      <span aria-hidden="true" className={pending && batch?.action === "start" ? "preflight-recording-spinner" : "preflight-record-icon"} />
    </button>
    <button className="preflight-recording-button" aria-label="Stop recording" title={pending && batch?.action === "stop" ? "Stopping recording…" : "Stop recording"}
      disabled={disabled} onClick={() => void run("stop")}>
      <span aria-hidden="true" className={pending && batch?.action === "stop" ? "preflight-recording-spinner" : "preflight-stop-icon"} />
    </button>
    {issues.length > 0 && <RecordingIssues action={batch!.action} issues={issues.map(row => ({
      id: row.id, label: row.target.label, message: row.result!.message,
    }))} retry={failed ? () => void run(batch!.action, true) : undefined} disabled={disabled} />}
  </div>;
}
