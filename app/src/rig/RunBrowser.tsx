import { useCallback, useEffect, useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { getRun, listRuns, RigError } from "./client";
import { DirTree } from "./DirTree";
import { agoIso, fmtIso, fmtKb } from "./format";
import { useRigContext } from "./RigContext";
import { dirUrl, probeRigData } from "./runsData";
import { isTerminalJob, runStateLevel, type RigRunDetail, type RigRunsReply } from "./types";

function errText(e: unknown): string {
  return e instanceof RigError ? `${e.kind}: ${e.message}` : String(e);
}

/**
 * The run registry: rows from the agent (rig's `list_runs` semantics), refreshed after every
 * finished job; a selected run shows its manifest and — when dash-up mounted data_dir — its files.
 */
export function RunBrowser() {
  const { transport } = useTransportContext();
  const { agent, jobs, now } = useRigContext();
  const [reply, setReply] = useState<RigRunsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filesServed, setFilesServed] = useState<boolean | null>(null);
  const agentKey = agent?.key;
  const lastFinished = jobs.find(isTerminalJob)?.job_id;

  const load = useCallback(async () => {
    if (!transport || !agentKey) return;
    setLoading(true);
    try {
      setReply(await listRuns(transport, agentKey));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [transport, agentKey]);

  useEffect(() => {
    void load();
  }, [load, lastFinished]);
  useEffect(() => {
    void probeRigData().then(setFilesServed);
  }, []);

  if (!agent) return null;
  const runs = reply ? [...reply.runs].reverse() : [];
  return (
    <section className="card rig-runs">
      <div className="card-header">
        <h2>Runs</h2>
        <span className="meta mono">
          {reply?.data_dir ?? agent.descriptor.data_dir ?? "registry inert"}
          {reply ? ` · ${reply.runs.length} run${reply.runs.length === 1 ? "" : "s"}` : ""}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={loading} onClick={() => void load()}>
          {loading ? "loading…" : "refresh"}
        </button>
      </div>
      <div className="card-body">
        {error && <div className="error-box">{error}</div>}
        {reply?.problem && <div className="warn-box">{reply.problem}</div>}
        {reply && reply.runs.length === 0 && !error && <p className="empty">no runs in the registry yet — `rig up` opens the first one</p>}
        {runs.length > 0 && (
          <table className="data-table rig-runs-table">
            <thead>
              <tr>
                <th>run</th>
                <th>label</th>
                <th>state</th>
                <th>started</th>
                <th>ended</th>
                <th>size</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run} className={`rig-run-tr${selected === r.run ? " selected" : ""}`} onClick={() => setSelected(selected === r.run ? null : r.run)}>
                  <td className="mono">
                    {r.run}
                    {r.linked && <span className="chip"> linked</span>}
                    {r.replay_of && (
                      <span className="chip info" title={`SIL replay of ${r.replay_of}`}>
                        replay
                      </span>
                    )}
                  </td>
                  <td>{r.label ?? <span className="dim">—</span>}</td>
                  <td>
                    <span className={`pill ${runStateLevel(r.state)}`}>{r.state}</span>
                  </td>
                  <td className="dim mono" title={r.started ?? ""}>
                    {r.started ? `${agoIso(r.started, now)} ago` : "?"}
                  </td>
                  <td className="dim mono">{r.ended ? fmtIso(r.ended) : "—"}</td>
                  <td className="dim mono">{fmtKb(r.disk_kb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selected && <RunDetail runId={selected} filesServed={filesServed === true} />}
      </div>
    </section>
  );
}

const MANIFEST_KEYS = ["run", "label", "vehicle", "vehicle_id", "rig_version", "started", "ended", "stacks", "config", "deployment", "artifact", "disk_kb", "status_at_end", "replay"] as const;

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return JSON.stringify(v);
}

function RunDetail({ runId, filesServed }: { runId: string; filesServed: boolean }) {
  const { transport } = useTransportContext();
  const { agent } = useRigContext();
  const [detail, setDetail] = useState<RigRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentKey = agent?.key;
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    if (!transport || !agentKey) return;
    getRun(transport, agentKey, runId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [transport, agentKey, runId]);

  const m = detail?.manifest ?? {};
  const ups = Array.isArray(m.ups) ? (m.ups as Record<string, unknown>[]) : [];
  const dockerLogs = m.docker_logs as Record<string, unknown> | undefined;
  const capture = m.capture as Record<string, unknown> | string | undefined;
  return (
    <div className="rig-run-detail">
      <div className="rig-run-detail-head">
        <span className="mono">{runId}</span>
        {detail?.state && <span className={`pill ${runStateLevel(detail.state as "OPEN")}`}>{detail.state}</span>}
        {m.config_dirty_at_seal === true && (
          <span className="chip warn" title="the config changed after this run's last `up` — those edits never applied to the recorded data">
            config dirty at seal
          </span>
        )}
        {m.corrupt === true && <span className="chip warn">manifest corrupt</span>}
        {filesServed && (
          <a className="btn-link" href={dirUrl(["runs", runId])} target="_blank" rel="noreferrer">
            browse ↗
          </a>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      {detail && !detail.ok && <div className="error-box">{detail.error}</div>}
      {detail?.ok && (
        <>
          <dl className="lifecycle-detail mono rig-manifest">
            {MANIFEST_KEYS.filter((k) => m[k] !== undefined).map((k) => (
              <div key={k} className="rig-manifest-row">
                <dt>{k}</dt>
                <dd>{show(m[k])}</dd>
              </div>
            ))}
            {dockerLogs && (
              <div className="rig-manifest-row">
                <dt>docker logs</dt>
                <dd>
                  {show(dockerLogs.containers)} container(s) at {show(dockerLogs.at)}
                </dd>
              </div>
            )}
            {capture !== undefined && (
              <div className="rig-manifest-row">
                <dt>capture</dt>
                <dd>{show(capture)}</dd>
              </div>
            )}
            {detail.dir && (
              <div className="rig-manifest-row">
                <dt>dir</dt>
                <dd>{detail.dir}</dd>
              </div>
            )}
          </dl>
          {ups.length > 0 && (
            <div className="rig-ups">
              <span className="dim">ups</span>
              <ul className="plain mono">
                {ups.map((u, i) => (
                  <li key={i}>
                    {show(u.at)} · {show(u.stacks)}
                    {u.config ? ` · config ${show(u.config)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary className="dim">full manifest</summary>
            <pre className="rig-log">{JSON.stringify(m, null, 2)}</pre>
          </details>
          <div className="rig-files">
            <span className="dim">files</span>
            {filesServed ? <DirTree segments={["runs", runId]} open /> : <p className="dim rig-tree-note">not served — set rig_data_dir (or let rig's RIG_DATA_DIR through) so dash-up mounts the registry at /rig-data/</p>}
          </div>
        </>
      )}
    </div>
  );
}
