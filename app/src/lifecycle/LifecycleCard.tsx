import { useEffect, useRef, useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { changeState, LifecycleError } from "./changeState";
import type { LifecycleService } from "./types";

type Phase =
  | { kind: "idle" }
  | { kind: "confirm"; transition: string }
  | { kind: "calling"; transition: string }
  | { kind: "ok"; summary: string }
  | { kind: "err"; message: string };

const FLASH_MS = 5000;

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

function since(unixS: number | undefined): string {
  if (unixS === undefined) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixS));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

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
  const { transport } = useTransportContext();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const d = service.descriptor;
  const flash = (next: Phase) => {
    setPhase(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setPhase({ kind: "idle" }), FLASH_MS);
  };

  const fire = async (transition: string) => {
    if (!transport) return;
    setPhase({ kind: "calling", transition });
    try {
      const r = await changeState(transport, service.key, transition, { runId });
      if (r.ok) flash({ kind: "ok", summary: `${transition}: ${r.state ?? "ok"}${r.noop ? " (already)" : ""}` });
      else flash({ kind: "err", message: `${transition} refused: ${r.error ?? "no reason given"}` });
    } catch (e) {
      const message = e instanceof LifecycleError ? `${e.kind}: ${e.message}` : String(e);
      flash({ kind: "err", message });
    }
  };

  const onClick = (transition: string) => {
    if (phase.kind === "calling") return;
    if (confirm && !(phase.kind === "confirm" && phase.transition === transition)) {
      setPhase({ kind: "confirm", transition });
      return;
    }
    void fire(transition);
  };

  const busy = phase.kind === "calling";
  const level = stateLevel(d.state, d.last_error, service.alive);
  const pillText = service.alive ? d.state : `${d.state} · offline`;
  const buttons = d.transitions.map((t) => (
    <button
      key={t}
      className={`btn${t === "activate" ? " primary" : ""}${phase.kind === "confirm" && phase.transition === t ? " confirm" : ""}`}
      disabled={!transport || busy || !service.alive}
      title={`${t} ${service.instance}`}
      onClick={() => onClick(t)}
    >
      {phase.kind === "calling" && phase.transition === t
        ? "calling…"
        : phase.kind === "confirm" && phase.transition === t
          ? `${t}?`
          : t}
    </button>
  ));
  const feedback =
    phase.kind === "ok" ? (
      <span className="dim mono lifecycle-feedback">{phase.summary}</span>
    ) : phase.kind === "err" ? (
      <span className="mono lifecycle-feedback is-err">{phase.message}</span>
    ) : d.last_error ? (
      <span className="mono lifecycle-feedback is-err">last error: {d.last_error}</span>
    ) : null;

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
  const health = d.health;
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
      </div>
      {rec && (
        <dl className="lifecycle-detail mono">
          {rec.prefix && (
            <>
              <dt>run</dt>
              <dd>{rec.prefix}</dd>
            </>
          )}
          {rec.frames !== undefined && (
            <>
              <dt>frames</dt>
              <dd>{rec.frames.toLocaleString()}</dd>
            </>
          )}
          {rec.encoder && (
            <>
              <dt>encoder</dt>
              <dd>{rec.encoder}</dd>
            </>
          )}
          {rec.segment_seconds !== undefined && (
            <>
              <dt>segment</dt>
              <dd>{rec.segment_seconds} s</dd>
            </>
          )}
        </dl>
      )}
      {health && (
        <span className="dim mono lifecycle-health">
          {health.stalled ? <span className="chip warn">stalled</span> : null}
          {Object.entries(health)
            .filter(([k, v]) => k !== "stalled" && typeof v === "number")
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(" · ")}
        </span>
      )}
      <div className="lifecycle-actions">{buttons}</div>
      {feedback}
    </div>
  );
}
