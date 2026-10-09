import { useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useRigContext } from "../rig/RigContext";
import { useHealthContext } from "./HealthContext";
import { HealthSummary } from "./HealthSummary";
import { healthVerdict } from "./types";
import { useNow } from "./useHealth";

export function HealthTab() {
  const { services, events = [], errors = [] } = useHealthContext();
  const { agents } = useRigContext();
  const { status } = useTransportContext();
  const [query, setQuery] = useState("");
  const [problems, setProblems] = useState(false);
  const [sort, setSort] = useState("attention");
  const now = useNow();
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const rows = services.map((service) => ({ service, verdict: healthVerdict(service, service.snapshot.status, now) }));
  const attention = rows.filter((r) => r.verdict.level !== "ok").length;
  const rank = { err: 0, warn: 1, idle: 2, ok: 3 };
  const shown = rows.filter(({ service: s, verdict }) => matches([
    s.vehicleId, s.instance, s.snapshot.service, s.sourceLabel, ...s.snapshot.status.flatMap((c) => [c.name, c.message, c.hardware_id,
      ...Object.entries(c.values).filter(([k]) => k.startsWith("alert.") || k === "health.error").map(([, v]) => String(v))]),
  ].join(" ")) && (!problems || verdict.level !== "ok"))
    .sort((a, b) => (sort === "attention" ? rank[a.verdict.level] - rank[b.verdict.level] : 0) ||
      `${a.service.vehicleId}/${a.service.instance}`.localeCompare(`${b.service.vehicleId}/${b.service.instance}`));
  const missing = agents.flatMap((a) => (a.state?.stacks ?? []).filter((s) =>
    !services.some((h) => h.vehicleId === a.vehicleId && h.instance === s.name))
    .map((s) => ({ ...s, vehicle: a.vehicleId, inventoryAlive: a.alive })));
  const shownEvents = events.filter((e) => matches(`${e.key} ${e.name} ${e.message}`));
  return <>
    <section className="card">
      <div className="card-header"><h2>Sensor & service health</h2><span className="meta">{services.length} reporters · {attention} need attention</span></div>
      <div className="card-body">
        {status !== "connected" && <p className="error-box" role="status">Dashboard connection {status}. Health updates are unavailable; displayed observations may be old.</p>}
        {errors.map((error) => <p className="error-box" key={error}>Health input: {error}</p>)}
        <div className="panel-row health-filters">
          <input className="field" type="search" aria-label="Filter health services" placeholder="Search services, hardware or issues" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label><input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> Needs attention</label>
          <select className="field" aria-label="Sort health services" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="attention">Attention first</option><option value="name">Vehicle / name</option>
          </select>
        </div>
        <div className="health-grid">{shown.map(({ service: s }) => <div key={s.key} className="widget-card">
          <HealthSummary service={s} nowMs={now} qualified connected={status === "connected"} expandable />
        </div>)}</div>
        {!shown.length && <p className="empty">{services.length ? "No matching health reports." : "Waiting for service health or ROS 2 diagnostics…"}</p>}
        {missing.filter((s) => matches(`${s.vehicle} ${s.name}`)).length > 0 && <div className="health-missing">
          <h3>Health not reported</h3><p className="dim widget-sub">Known to Rig; these services may not support health reporting.</p>
          {missing.filter((s) => matches(`${s.vehicle} ${s.name}`)).map((s) => <div className="panel-row" key={`${s.vehicle}/${s.name}`}>
            <span className="row-label">{s.vehicle}/{s.name}</span><span className="pill idle">{!s.inventoryAlive ? "inventory offline" : !s.enabled ? "disabled" : s.op_state ?? s.state} · health not reported</span>
          </div>)}
        </div>}
      </div>
    </section>
    <section className="card"><div className="card-header"><h2>Recent health events</h2><span className="meta">This browser session · up to 200 events · local receipt time</span></div>
      <div className="card-body health-events">{shownEvents.map((e, i) => <div className="health-event" key={`${e.atMs}/${i}`}>
        <time className="dim mono" dateTime={new Date(e.atMs).toISOString()}>{new Date(e.atMs).toLocaleTimeString()}</time>
        <span className={`pill ${e.level === 2 ? "err" : e.level === 1 ? "warn" : "idle"}`}>{["OK", "WARN", "ERROR", "STALE"][e.level] ?? "INFO"}</span>
        <div><strong>{e.name}</strong><p>{e.message}</p><span className="dim mono widget-sub">{e.key}</span></div>
      </div>)}{!shownEvents.length && <p className="empty">{events.length ? "No events match this search." : "No health changes observed yet."}</p>}</div></section>
  </>;
}
