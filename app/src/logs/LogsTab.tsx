import { useCallback, useEffect, useRef, useState } from "react";
import { useRigContext } from "../rig/RigContext";
import { useTransportContext } from "../transport/TransportContext";
import { containerLabel, listContainers, plainLog, readLogs } from "./client";
import "./logs.css";

/** Completion-paced polling: no overlap, no late reply from a previous selection, no hidden work. */
function usePoll<T>(key: string, read: () => Promise<T>, enabled: boolean, interval: number, revision = 0) {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key });
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await read();
        if (!stopped) setResult({ key, data });
      } catch (e) {
        if (!stopped) setResult((old) => ({ key, data: old.key === key ? old.data : undefined, error: String(e instanceof Error ? e.message : e) }));
      }
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [key, read, enabled, interval, revision]);
  return result.key === key ? result : { key };
}

export function LogsTab({ active }: { active: boolean }) {
  const { transport, status } = useTransportContext();
  const { agents } = useRigContext();
  const [agentChoice, setAgentChoice] = useState("");
  const agent = agentChoice ? agents.find((a) => a.key === agentChoice) : agents.length === 1 ? agents[0] : undefined;
  const base = agent?.key ?? "";
  const supported = agent?.descriptor.capabilities?.docker_logs === true;
  const connected = status === "connected" && transport !== null && agent?.alive === true;
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const enabled = active && pageVisible && connected && supported;
  const [selection, setSelection] = useState({ base: "", id: "" });
  const id = selection.base === base ? selection.id : "";
  const [tail, setTail] = useState(200);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [revision, setRevision] = useState(0);
  const loadContainers = useCallback(() => listContainers(transport!, base), [transport, base]);
  const inventory = usePoll(base, loadContainers, enabled, 10_000, revision);
  const container = inventory.data?.find((c) => c.id === id);
  const loadLogs = useCallback(() => readLogs(transport!, base, id, tail), [transport, base, id, tail]);
  const logs = usePoll(`${base}/${id}/${tail}`, loadLogs, enabled && !!container && !paused, 2_000);
  const view = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (active && autoScroll && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [active, autoScroll, logs.data]);
  const text = logs.data ? plainLog(logs.data.text) : "";
  const missing = !!id && !!inventory.data && !container;
  const state = !connected ? "Disconnected" : paused ? "Paused" : logs.error || missing || inventory.error ? "Unavailable" : logs.data ? "Following" : "Ready";

  return (
    <section className="card docker-logs">
      <div className="card-header">
        <h2>Docker logs</h2>
        <span className={`pill ${state === "Following" ? "ok" : "idle"}`}>{state}</span>
        {agent && <span className="meta">{agent.descriptor.vehicle || `Vehicle ${agent.vehicleId}`}</span>}
      </div>
      <div className="card-body">
        {agents.length === 0 && <p className="empty">No vehicle agent is available. Enable <code>rig_agent: true</code> in the dashboard YAML and bring up the dashboard. Log viewing works with <code>rig_actuate: false</code>.</p>}
        {(agents.length > 1 || agentChoice) && (
          <label className="docker-log-vehicle">Vehicle
            <select value={agentChoice} onChange={(e) => setAgentChoice(e.target.value)}>
              <option value="">Choose a vehicle…</option>
              {agentChoice && !agent && <option value={agentChoice}>{agentChoice} (offline)</option>}
              {agents.map((a) => <option key={a.key} value={a.key}>{a.descriptor.vehicle || a.vehicleId} · {a.vehicleId}{a.alive ? "" : " (offline)"}</option>)}
            </select>
          </label>
        )}
        {agent && !supported && <p className="empty">This vehicle agent does not support Docker logs. Update the dashboard-rig-agent image to enable this tab.</p>}
        {supported && <>
          <div className="docker-log-controls">
            <label className="docker-log-picker">Container / Compose service
              <select value={id} disabled={!connected} onChange={(e) => setSelection({ base, id: e.target.value })}>
                <option value="">Choose a container…</option>
                {missing && <option value={id}>{id.slice(0, 12)} (removed)</option>}
                {inventory.data?.map((c) => <option key={c.id} value={c.id}>{containerLabel(c)}</option>)}
              </select>
            </label>
            <label>Tail lines
              <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
                {[100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn" disabled={!connected} onClick={() => setRevision((n) => n + 1)}>Refresh containers</button>
            <button className="btn" disabled={!id} onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
            <label className="docker-log-scroll"><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto-scroll</label>
          </div>
          {inventory.error && <div className="warn-box" role="alert">Container list: {inventory.error}</div>}
          {inventory.data?.length === 0 && !inventory.error && <p className="empty">No Docker containers on this vehicle.</p>}
          {!connected && <div className="warn-box">Vehicle disconnected. Any logs below are the last retrieved snapshot.</div>}
          {missing && <div className="warn-box">This container was removed. Choose its replacement from the container list.</div>}
          {container && <p className="meta mono">{container.name} · {container.status} · {container.image} · {container.id.slice(0, 12)}</p>}
          {logs.error && <div className="warn-box" role="alert">{logs.error} Any logs below are the last retrieved snapshot.</div>}
          {id && <>
            <p className="meta">Latest {tail} lines of stdout/stderr · refreshes every 2 seconds · capped at 64 KiB.
              {logs.data && ` Retrieved ${new Date(logs.data.at_unix_s * 1000).toLocaleTimeString()}.`}
              {paused && " Updates paused."}
            </p>
            {logs.data?.truncated && <div className="warn-box">Log tail exceeded 64 KiB; showing its last portion.</div>}
            <pre ref={view} className="docker-log-output" aria-label="Container log output" tabIndex={0}>{text || (logs.data ? "No log output yet." : paused ? "Resume to load logs." : "Waiting for logs…")}</pre>
          </>}
        </>}
      </div>
    </section>
  );
}
