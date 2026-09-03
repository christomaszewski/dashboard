import { useEffect, useRef, useState } from "react";
import { ago, fmtDuration } from "./format";
import { useRigContext } from "./RigContext";
import { isTerminalJob, jobStateLevel, type RigJob } from "./types";

const HISTORY = 10;

function resultLine(job: RigJob): string {
  const parts: string[] = [];
  if (job.result.sealed) parts.push(`sealed ${job.result.sealed}`);
  if (job.result.opened) parts.push(`opened ${job.result.opened}`);
  return parts.join(" · ");
}

/**
 * The running job (verb, elapsed vs deadline, live log tail from the agent's progress events,
 * cancel) and the last few finished ones with rig's message verbatim. Rendered from the events the
 * agent publishes, so every open dashboard sees the same thing.
 */
export function JobPanel() {
  const { jobs, runningJob, now, cancel, agent } = useRigContext();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const tailKey = runningJob?.log_tail.join("\n");
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tailKey]);
  useEffect(() => setConfirmCancel(false), [runningJob?.job_id]);

  const history = jobs.filter(isTerminalJob).slice(0, HISTORY);
  if (!agent || (!runningJob && history.length === 0)) return null;

  const onCancel = async () => {
    if (!runningJob) return;
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    try {
      const r = await cancel(runningJob.job_id);
      setNote(r.ok ? "cancel requested" : `cancel refused: ${r.error ?? "?"}`);
    } catch (e) {
      setNote(String(e));
    }
  };

  const started = runningJob ? (runningJob.started_unix_s ?? runningJob.submitted_unix_s) : 0;
  const elapsed = runningJob ? now / 1000 - started : 0;
  const pct = runningJob && runningJob.timeout_s > 0 ? Math.min(100, (elapsed / runningJob.timeout_s) * 100) : 0;

  return (
    <section className="card rig-jobs-card">
      <div className="card-header">
        <h2>Jobs</h2>
        <span className="meta">{runningJob ? `running · ${runningJob.job_id}` : `${history.length} recent`}</span>
      </div>
      <div className="card-body">
        {runningJob && (
          <div className="rig-job rig-job-running">
            <div className="rig-job-head">
              <span className={`pill ${jobStateLevel(runningJob.state)}`}>{runningJob.state}</span>
              <span className="mono">rig {runningJob.argv.join(" ")}</span>
              {runningJob.self_terminating && (
                <span className="chip warn" title="this verb takes the dashboard's own compose project down — the runner finishes on its own; reconnect after `rig up`">
                  takes the dashboard down
                </span>
              )}
              <span className="dim mono">
                {fmtDuration(elapsed)} / {fmtDuration(runningJob.timeout_s)}
                {runningJob.client ? ` · ${runningJob.client}` : ""}
              </span>
              {!agent.alive && <span className="chip warn">agent offline — dashboard restarting? reconnect</span>}
              <span className="spacer" />
              <button className={`btn danger${confirmCancel ? " confirm" : ""}`} disabled={!agent.alive} onClick={() => void onCancel()}>
                {confirmCancel ? "cancel job?" : "cancel"}
              </button>
            </div>
            <div className="rig-progress" title={`${Math.round(pct)}% of the ${runningJob.timeout_s} s deadline`}>
              <div className="rig-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <pre className="rig-log" ref={logRef}>
              {runningJob.log_tail.length > 0 ? runningJob.log_tail.join("\n") : "waiting for output…"}
            </pre>
            {note && <span className="dim mono rig-feedback">{note}</span>}
          </div>
        )}
        {history.length > 0 && (
          <ul className="plain rig-history">
            {history.map((job) => (
              <li key={job.job_id} className="rig-job">
                <div className="rig-job-head">
                  <span className={`pill ${jobStateLevel(job.state)}`}>{job.state}</span>
                  <span className="mono">rig {job.argv.join(" ")}</span>
                  <span className="dim mono">
                    {ago(job.ended_unix_s ?? job.submitted_unix_s, now)} ago
                    {job.started_unix_s && job.ended_unix_s ? ` · ${fmtDuration(job.ended_unix_s - job.started_unix_s)}` : ""}
                    {job.client ? ` · ${job.client}` : ""}
                  </span>
                  {job.error_kind && job.error_kind !== "other" && <span className="chip warn">{job.error_kind}</span>}
                  {resultLine(job) && <span className="chip info">{resultLine(job)}</span>}
                </div>
                {job.error && <div className="mono rig-feedback is-err">{job.error}</div>}
                {job.guard_projects.length > 0 && (
                  <div className="rig-guard-projects">
                    {job.guard_projects.map((p) => (
                      <span className="chip warn" key={p}>
                        {p}
                      </span>
                    ))}
                  </div>
                )}
                <details>
                  <summary className="dim">record</summary>
                  <pre className="rig-log">{JSON.stringify(job, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
