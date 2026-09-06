import { recordingFiles, sinceText, type LifecycleService } from "./types";
import { useLifecycleAction } from "./useLifecycleAction";

const STATE_LEVEL: Record<string, string> = {
  active: "ok",
  inactive: "idle",
  activating: "warn",
  deactivating: "warn",
};

function stateLevel(state: string, lastError: string | null | undefined, alive: boolean): string {
  if (!alive) return "warn";
  if (lastError) return "err";
  return STATE_LEVEL[state] ?? "warn";
}

const since = sinceText;

/**
 * One lifecycle-controlled service: state pill, what it is doing (recording run, health), and a
 * button per transition the service accepts RIGHT NOW (from its descriptor — the dashboard never
 * assumes a state machine). The reply to change_state arrives when the transition completes (a
 * deactivate finalizes files first), so the button stays "calling…" for up to a few seconds.
 * `compact` renders a panel row instead of a card.
 */
export function LifecycleCard({
  service,
  title,
  confirm = false,
  runId,
  compact = false,
}: {
  service: LifecycleService;
  title?: string;
  confirm?: boolean;
  runId?: string;
  compact?: boolean;
}) {
  const { busy, click, feedback, label, confirming, canCall } = useLifecycleAction(service, { confirm, runId });
  const d = service.descriptor;
  const level = stateLevel(d.state, d.last_error, service.alive);
  const pillText = service.alive ? d.state : `${d.state} · offline`;
  const buttons = d.transitions.map((t) => (
    <button
      key={t}
      className={`btn${t === "activate" ? " primary" : ""}${confirming(t) ? " confirm" : ""}`}
      disabled={!canCall || busy || !service.alive}
      title={`${t} ${service.instance}`}
      onClick={() => click(t)}
    >
      {label(t)}
    </button>
  ));

  if (compact) {
    return (
      <div className="panel-row lifecycle-row" title={service.key}>
        <span className="row-label">{title ?? service.instance}</span>
        <span className={`pill ${level}`}>{pillText}</span>
        <span className="lifecycle-actions">{buttons}</span>
        {feedback}
      </div>
    );
  }

  const rec = d.recording;
  const health = d.health ?? undefined;
  const healthCounters = health
    ? Object.entries(health)
        .filter(([k, v]) => typeof v === "number" && k !== "frames")
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ")
    : "";
  return (
    <div className="widget-card lifecycle-card">
      <span className="widget-label">
        <span className={`dot ${service.alive ? "ok" : ""}`} /> {title ?? `${d.service} · ${service.instance}`}
        <span className="dim mono lifecycle-vehicle">{service.vehicleId}</span>
      </span>
      <div className="lifecycle-state">
        <span className={`pill ${level}`}>{pillText}</span>
        {d.since_unix_s !== undefined && <span className="dim mono">for {since(d.since_unix_s)}</span>}
        {d.boot_reason && <span className="chip info">{d.boot_reason}</span>}
        {d.recording_enabled === false && (
          <span className="chip warn" title="recording.enabled: false in the sensor config — activate will be refused">
            recording disabled
          </span>
        )}
      </div>
      {rec && (
        <dl className="lifecycle-detail mono">
          {rec.prefix && (
            <>
              <dt>run</dt>
              <dd>{rec.prefix}</dd>
            </>
          )}
          {rec.started_unix_s !== undefined && (
            <>
              <dt>recording</dt>
              <dd>
                for {since(rec.started_unix_s)}
                {recordingFiles(rec) !== undefined ? ` · ${recordingFiles(rec)} file${recordingFiles(rec) === 1 ? "" : "s"}` : ""}
              </dd>
            </>
          )}
          {rec.frames !== undefined && (
            <>
              <dt>frames</dt>
              <dd>
                {rec.frames.toLocaleString()}
                {rec.skipped_awaiting_keyframe ? ` · ${rec.skipped_awaiting_keyframe} skipped (keyframe wait)` : ""}
              </dd>
            </>
          )}
          {rec.encoder && (
            <>
              <dt>encoder</dt>
              <dd>
                {rec.encoder}
                {rec.segment_seconds !== undefined ? ` · ${rec.segment_seconds} s segments` : ""}
              </dd>
            </>
          )}
          {rec.error && (
            <>
              <dt className="is-err">error</dt>
              <dd className="is-err">{rec.error}</dd>
            </>
          )}
        </dl>
      )}
      {health && (
        <span className="dim mono lifecycle-health">
          {health.stalled ? <span className="chip warn">stalled</span> : null}
          {health.reconnecting ? <span className="chip warn">reconnecting</span> : null}
          {typeof health.frames === "number" ? `${health.frames.toLocaleString()} frames` : ""}
          {healthCounters ? ` · ${healthCounters}` : ""}
        </span>
      )}
      <div className="lifecycle-actions">{buttons}</div>
      {feedback}
    </div>
  );
}
