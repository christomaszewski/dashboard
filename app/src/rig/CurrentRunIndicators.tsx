import { HealthTooltip } from "../health/HealthTooltip";
import { useNow } from "../health/useHealth";
import { useTransportContext } from "../transport/TransportContext";
import { useVehicleState } from "../vstate/VehicleStateContext";
import { useCurrentRun } from "./useCurrentRun";

/** A silent poll stream is stale on this page's clock; unchanged successful polls stay fresh. */
export const CURRENT_RUN_STALE_MS = 90_000;

interface RunView {
  id?: string;
  label?: string | null;
  started?: string | null;
  path?: string;
  text: string;
  detail?: string | null;
  level: "warn" | "ok" | "idle";
}
function RunPill({ vehicle, run }: { vehicle: string; run: RunView }) {
  return <HealthTooltip className={`current-run ${run.level}`} label={`${vehicle} Run: ${run.text}`}
    detail={<>
      <strong>{vehicle} · Run: {run.text}</strong>
      {run.detail && <p>{run.detail}</p>}
      <dl className="health-values mono">
        {run.id && <div><dt>Run ID</dt><dd>{run.id}</dd></div>}
        {run.label && <div><dt>Label</dt><dd>{run.label}</dd></div>}
        {run.started && <div><dt>Started</dt><dd>{run.started}</dd></div>}
        {run.path && <div><dt>Directory</dt><dd>{run.path}</dd></div>}
      </dl>
    </>}>
    <span className="current-run-vehicle">{vehicle}</span>
    <span>Run:</span><span className="current-run-id">{run.text}</span>
  </HealthTooltip>;
}

/** Local dashboard-state supplies the header on every tab, even with the Rig agent disabled. */
export function CurrentRunIndicators() {
  const { currentRun: source } = useVehicleState();
  const snapshot = useCurrentRun(source?.client);
  const { status } = useTransportContext();
  useNow(); // Age a stalled poll stream even when no new data causes a render.
  if (source) {
    const run = snapshot?.currentRun;
    const lastResponse = source.client?.lastResponseMonoMs();
    const stale = lastResponse !== undefined && performance.now() - lastResponse > CURRENT_RUN_STALE_MS;
    const offline = status !== "connected";
    const error = source.error || snapshot?.error || (!run?.ok ? run?.error : undefined);
    const available = !offline && !stale && !error && run?.ok === true;
    const text = offline ? "offline" : !available ? "unavailable" : run.run_id ?? "no open run";
    const detail = offline ? "Dashboard disconnected. Run details are last known."
      : error || (stale ? "No current run report has arrived recently. Run details are last known."
        : !run ? "Waiting for a current run report." : undefined);
    const view: RunView = { id: run?.run_id ?? undefined, label: run?.label, started: run?.started, path: run?.run_dir ?? undefined,
      text, detail, level: offline || !available ? "warn" : run?.run_id ? "ok" : "idle" };
    return <span className="current-runs" role="group" aria-label="Current runs">
      <RunPill vehicle={run?.vehicle_id ?? source.vehicleId ?? "Local"} run={view} />
    </span>;
  }
  return null;
}
