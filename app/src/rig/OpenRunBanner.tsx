import { useState } from "react";
import { agoIso, fmtIso, fmtKb, runStamp } from "./format";
import { useRigContext } from "./RigContext";
import { isTerminalJob, type RigJob, type RigVerb } from "./types";
import { useRigSubmit } from "./useRigSubmit";

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // rig's _LABEL_RE — it becomes a directory name

/** The most recent terminal job, if it was a run verb that hit rig's seal guard. */
function guardRefusal(jobs: RigJob[]): RigJob | undefined {
  const latest = jobs.find(isTerminalJob);
  if (!latest) return undefined;
  const runVerb = latest.verb === "new-run" || latest.verb === "end-run";
  const guarded = latest.error_kind === "guard-running" || latest.error_kind === "guard-cannot-tell";
  return runVerb && guarded ? latest : undefined;
}

/**
 * The open run (registry `current`) with the run verbs. rig refuses `new-run` / `end-run` while ANY
 * enabled row's compose project runs — the dashboard's own included — so from here the honest
 * choices after a refusal are `--force` (seal now; still-running services keep writing into the
 * sealed directory) or `down --end-run` (stop everything, seal, and lose this dashboard until
 * `rig up`). Both are offered explicitly, never silently. `compact` = a panel row.
 */
export function OpenRunBanner({ compact = false, confirm = false, controls = true }: { compact?: boolean; confirm?: boolean; controls?: boolean }) {
  const { agent, state, jobs, runningJob, now } = useRigContext();
  const s = useRigSubmit({ confirm });
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!agent || !state) return null;

  const run = state.run;
  const reg = state.registry;
  const disabledReason = !agent.alive
    ? "rig agent offline"
    : agent.descriptor.capabilities?.actuate === false
      ? "actuation disabled (rig_actuate: false)"
      : runningJob
        ? "a job is already running"
        : reg.data_dir === null
          ? "no data_dir in vehicle.yaml — the run registry is inert"
          : undefined;
  const canAct = controls && disabledReason === undefined && !s.busy;
  const labelValid = label === "" || LABEL_RE.test(label);
  const guard = guardRefusal(jobs);
  const showGuard = guard !== undefined && dismissed !== guard.job_id && !runningJob;

  const openRun = () => {
    if (!labelValid) return;
    s.click("new-run", { verb: "new-run", label: label || undefined }, false);
    setLabelOpen(false);
    setLabel("");
  };
  const endRun = () => s.click("end-run", { verb: "end-run" });
  const force = () => guard && s.click(`force:${guard.verb}`, { verb: guard.verb as RigVerb, label: typeof guard.args.label === "string" ? guard.args.label : undefined, force: true }, true);
  const stopAndSeal = () => s.click("stop-seal", { verb: "down", end_run: true }, true);

  if (compact) {
    return (
      <div className="panel-row rig-run-row" title={reg.data_dir ?? "registry inert"}>
        <span className="row-label">run</span>
        <span className={`pill ${run ? "ok" : "idle"}`}>{run ? (run.label ?? runStamp(run.id)) : "none"}</span>
        {run && <span className="dim mono">{agoIso(run.started, now)}</span>}
        {controls && (
          <span className="rig-actions">
            <button className={`btn${s.confirming("new-run") ? " confirm" : ""}`} disabled={!canAct} title={disabledReason ?? "rig new-run (auto label)"} onClick={() => s.click("new-run", { verb: "new-run" })}>
              {s.label("new-run", "new run")}
            </button>
            {run && (
              <button className={`btn${s.confirming("end-run") ? " confirm" : ""}`} disabled={!canAct} title={disabledReason ?? "rig end-run"} onClick={endRun}>
                {s.label("end-run", "end run")}
              </button>
            )}
          </span>
        )}
        {s.feedback}
      </div>
    );
  }

  return (
    <section className="card rig-run">
      <div className="card-header">
        <h2>Run</h2>
        <span className="meta mono">
          {reg.data_dir ?? "registry inert (no data_dir)"}
          {reg.free_kb !== null && ` · ${fmtKb(reg.free_kb)} free`}
        </span>
      </div>
      <div className="card-body">
        <div className="rig-run-line">
          {run ? (
            <>
              <span className="pill ok">OPEN</span>
              <span className="mono rig-run-id">
                <strong>{run.label ?? "—"}</strong> <span className="dim">{run.id}</span>
              </span>
              <span className="dim mono">
                started {fmtIso(run.started)} · {agoIso(run.started, now)} ago
              </span>
              {run.disk_kb !== null && run.disk_kb !== undefined && <span className="chip">{fmtKb(run.disk_kb)}</span>}
              {run.corrupt && <span className="chip warn">manifest corrupt</span>}
              {run.stacks.map((n) => (
                <span className="chip info" key={n}>
                  {n}
                </span>
              ))}
            </>
          ) : (
            <>
              <span className="pill idle">no open run</span>
              <span className="dim">`rig up` opens one (auto label); New run… opens a labelled one.</span>
            </>
          )}
          {reg.problem && (
            <span className="chip warn" title={reg.problem}>
              registry problem
            </span>
          )}
        </div>
        {controls && (
          <div className="rig-run-controls">
            {labelOpen ? (
              <>
                <input
                  className="rig-label-input mono"
                  placeholder="label (optional) — [A-Za-z0-9][A-Za-z0-9_-]*"
                  value={label}
                  autoFocus
                  onChange={(e) => setLabel(e.target.value.trim())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") openRun();
                    if (e.key === "Escape") setLabelOpen(false);
                  }}
                />
                <button className="btn primary" disabled={!canAct || !labelValid} onClick={openRun}>
                  open run
                </button>
                <button className="btn" onClick={() => setLabelOpen(false)}>
                  cancel
                </button>
                {!labelValid && <span className="mono rig-feedback is-err">label must match [A-Za-z0-9][A-Za-z0-9_-]*</span>}
              </>
            ) : (
              <button className="btn" disabled={!canAct} title={disabledReason ?? "rig new-run <label>: seal the open run (if any), open a new one"} onClick={() => setLabelOpen(true)}>
                new run…
              </button>
            )}
            {run && (
              <button className={`btn${s.confirming("end-run") ? " confirm" : ""}`} disabled={!canAct} title={disabledReason ?? "rig end-run: seal the open run"} onClick={endRun}>
                {s.label("end-run", "end run (seal)")}
              </button>
            )}
            <button className={`btn danger${s.confirming("stop-seal") ? " confirm" : ""}`} disabled={!canAct} title={disabledReason ?? "rig down --end-run: stop every stack, then seal"} onClick={stopAndSeal}>
              {s.label("stop-seal", "stop everything & seal")}
            </button>
            {s.confirming("stop-seal") && (
              <span className="mono rig-feedback is-warn">
                Tears down every stack — this dashboard included; the agent finishes and seals from a detached runner. Reconnect after `rig up`; the job record is kept. Click again to confirm.
              </span>
            )}
            {disabledReason && <span className="dim mono rig-feedback">{disabledReason}</span>}
          </div>
        )}
        {showGuard && guard && (
          <div className="warn-box rig-guard">
            <div className="rig-guard-text">
              <strong>{guard.verb} refused:</strong> {guard.error}
              {guard.guard_projects.length > 0 && (
                <span className="rig-guard-projects">
                  {guard.guard_projects.map((p) => (
                    <span className="chip warn" key={p}>
                      {p}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="rig-actions">
              {guard.error_kind === "guard-cannot-tell" && (
                <button className="btn" disabled={!canAct} onClick={() => s.click(`retry:${guard.verb}`, { verb: guard.verb as RigVerb, label: typeof guard.args.label === "string" ? guard.args.label : undefined }, false)}>
                  retry
                </button>
              )}
              <button className={`btn danger${s.confirming("stop-seal") ? " confirm" : ""}`} disabled={!canAct} onClick={stopAndSeal}>
                {s.label("stop-seal", "stop everything & seal")}
              </button>
              <button className={`btn${s.confirming(`force:${guard.verb}`) ? " confirm" : ""}`} disabled={!canAct} title="--force: seal now; services still running keep writing into the sealed run's directory" onClick={force}>
                {s.label(`force:${guard.verb}`, `force ${guard.verb}`)}
              </button>
              <button className="btn-link" onClick={() => setDismissed(guard.job_id)}>
                dismiss
              </button>
            </div>
          </div>
        )}
        {s.feedback}
      </div>
    </section>
  );
}
