import { DeploymentTable } from "./DeploymentTable";
import { ago } from "./format";
import { JobPanel } from "./JobPanel";
import { OpenRunBanner } from "./OpenRunBanner";
import { useRigContext } from "./RigContext";
import { RunBrowser } from "./RunBrowser";

/**
 * The Rig tab: the deployment as rig sees it (every vehicle.yaml row with compose state, health
 * and operational state), the open run with the run verbs, running/recent jobs, and the run
 * registry browser. Everything comes from the vehicle-side rig agent (docs/RIG_AGENT.md); with no
 * agent advertising the tab explains how to enable one.
 */
export function RigTab() {
  const { agent, agents, state, stale, now, refresh } = useRigContext();
  const d = agent?.descriptor;
  const agentPill = !agent ? (
    <span className="pill idle">no rig agent</span>
  ) : !agent.alive ? (
    <span className="pill warn">offline · grace</span>
  ) : stale ? (
    <span className="pill warn" title="no state publication for several poll periods">
      advertising · stale
    </span>
  ) : (
    <span className="pill ok">advertising</span>
  );

  return (
    <>
      <section className="card rig-header">
        <div className="card-header">
          <h2>Rig</h2>
          <span className="meta">{agentPill}</span>
          {d && (
            <span className="meta mono rig-meta">
              {d.vehicle ?? ""} · vehicle {agent?.vehicleId} · rig {d.rig_version ?? "?"} · agent {d.agent_version ?? "?"}
              {d.root ? ` · ${d.root}` : ""}
              {state ? ` · polled ${ago(state.at_unix_s, now)} ago` : ""}
              {d.capabilities?.actuate === false ? " · read-only" : ""}
            </span>
          )}
          <span className="spacer" />
          {agent && (
            <button className="btn" onClick={() => void refresh()} title="re-read the state snapshot and job history">
              refresh
            </button>
          )}
        </div>
        {!agent && (
          <div className="card-body">
            <p className="empty">
              No rig agent is advertising on <code className="mono">fleet/*/rig</code>. Enable it with <code className="mono">rig_agent: true</code> in the
              dashboard instance YAML and re-run <code className="mono">rig up dashboard</code> — see docs/RIG_AGENT.md.
            </p>
          </div>
        )}
        {agents.length > 1 && (
          <div className="card-body">
            <div className="warn-box">
              {agents.length} rig agents advertise ({agents.map((a) => a.key).join(", ")}); showing {agent?.key}.
            </div>
          </div>
        )}
        {state && !state.ok && (
          <div className="card-body">
            <div className="warn-box">rig status failed on the vehicle: {state.error ?? "unknown error"} — rows show the last good roll-up.</div>
          </div>
        )}
      </section>
      {agent && (
        <>
          <OpenRunBanner />
          <section className="card rig-deployment">
            <div className="card-header">
              <h2>Deployment</h2>
              <span className="meta">
                {state ? `${state.stacks.filter((s) => s.state === "running").length}/${state.stacks.filter((s) => s.enabled).length} running` : "no snapshot yet"}
              </span>
            </div>
            <div className="card-body">
              {state ? <DeploymentTable rows={state.stacks} runLabel={state.run?.label} /> : <p className="empty">waiting for the first state snapshot…</p>}
            </div>
          </section>
          <JobPanel />
          <RunBrowser />
        </>
      )}
    </>
  );
}
