import type { RigWidgetConfig } from "../../config/schema";
import { agoIso, runStamp } from "../../rig/format";
import { OpenRunBanner } from "../../rig/OpenRunBanner";
import { useRigContext } from "../../rig/RigContext";
import { RowActions, RowPill } from "../../rig/RowActions";

/**
 * Config-driven rig summary for the Home tab: the open run (+ run verbs), and one line per
 * deployment row with its state pill and standby/activate/up/down. `compact` (panel item) is a
 * single row: run label · age · "n/m running".
 */
export function RigWidget({ widget, compact = false }: { widget: RigWidgetConfig; compact?: boolean }) {
  const { agent, state, now } = useRigContext();
  const label = widget.label ?? "rig";
  if (!agent || !state) {
    return compact ? (
      <div className="panel-row">
        <span className="row-label">{label}</span>
        <span className="pill idle">no rig agent</span>
      </div>
    ) : (
      <div className="widget-card widget-rig">
        <span className="widget-label">{label}</span>
        <span className="pill idle">no rig agent</span>
        <span className="dim mono widget-sub">waiting for fleet/*/rig… (rig_agent: true in the instance YAML)</span>
      </div>
    );
  }
  const rows = state.stacks.filter((r) => r.enabled && (widget.stacks === undefined || widget.stacks.includes(r.name)));
  const running = rows.filter((r) => r.state === "running").length;
  const run = state.run;

  if (compact) {
    return (
      <div className="panel-row rig-widget-row" title={agent.key}>
        <span className="row-label">{label}</span>
        <span className={`pill ${run ? "ok" : "idle"}`}>{run ? `${run.label ?? runStamp(run.id)} · ${agoIso(run.started, now)}` : "no run"}</span>
        <span className={`pill ${running === rows.length ? "ok" : running === 0 ? "idle" : "warn"}`}>
          {running}/{rows.length} running
        </span>
      </div>
    );
  }

  return (
    <div className="widget-card widget-rig">
      <span className="widget-label">
        <span className={`dot ${agent.alive ? "ok" : ""}`} /> {label}
        <span className="dim mono lifecycle-vehicle">{agent.vehicleId}</span>
      </span>
      {widget.runs !== false && <OpenRunBanner compact confirm={widget.confirm} />}
      <div className="rig-widget-rows">
        {rows.map((row) => (
          <div className="panel-row rig-widget-row" key={row.name} title={row.project}>
            <span className="row-label mono">{row.name}</span>
            <RowPill row={row} />
            {widget.actions !== false && <RowActions row={row} confirm={widget.confirm} runLabel={widget.use_run_label === false ? null : run?.label} />}
          </div>
        ))}
        {rows.length === 0 && <span className="dim">no matching rows</span>}
      </div>
      {!state.ok && <span className="mono rig-feedback is-warn">rig status: {state.error}</span>}
    </div>
  );
}
