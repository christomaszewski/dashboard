import { usePlaybackAction } from "./usePlaybackAction";
import { SPEED_PRESETS, positionText, sessionText, speedText, type PlaybackService } from "./types";

const STATE_LEVEL: Record<string, string> = { playing: "ok", paused: "warn", finished: "idle" };

/**
 * One playback-controllable source, in full: state, what is playing (source, cycle, position
 * with a progress bar when the length is known), and every control the producer accepts RIGHT
 * NOW (from its descriptor — the dashboard never assumes a state machine): pause/resume, speed
 * presets, loop, restart. Lives on the Cameras tab beside the recorder card; the tile's overlay
 * is the compact form of the same controls.
 */
export function PlaybackCard({ service, title }: { service: PlaybackService; title?: string }) {
  const { busy, click, feedback, label, accepts, canCall } = usePlaybackAction(service);
  const d = service.descriptor;
  const level = !service.alive ? "warn" : d.last_error ? "err" : (STATE_LEVEL[d.state] ?? "warn");
  const pct = d.duration_s && d.position_s !== undefined ? Math.min(100, (100 * d.position_s) / d.duration_s) : null;
  const dis = !canCall || busy;
  return (
    <div className="widget-card playback-card">
      <span className="widget-label">
        <span className={`dot ${service.alive ? "ok" : ""}`} /> {title ?? `playback · ${service.instance}`}
        <span className="dim mono lifecycle-vehicle">{service.vehicleId}</span>
      </span>
      <div className="lifecycle-state">
        <span className={`pill ${level}`}>{service.alive ? d.state : `${d.state} · offline`}</span>
        <span className="chip info">{d.source.toUpperCase()}</span>
        {d.loop && <span className="chip">loop</span>}
        <span className="dim mono">{speedText(d.speed)}</span>
      </div>
      <div className="playback-position mono">
        <span>{positionText(d)}</span>
        {d.cycle !== undefined && <span className="dim">cycle {d.cycle}</span>}
        {d.frames !== undefined && <span className="dim">{d.frames.toLocaleString()} frames</span>}
      </div>
      {sessionText(d) && <div className="dim mono playback-session" title={d.source_path ?? undefined}>{sessionText(d)}</div>}
      {pct !== null && (
        <div className="playback-bar" aria-hidden="true">
          <div className="playback-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="lifecycle-actions playback-actions">
        {accepts("pause") && (
          <button className="btn" disabled={dis} onClick={() => void click("pause")}>{label("pause")}</button>
        )}
        {accepts("resume") && (
          <button className="btn primary" disabled={dis} onClick={() => void click("resume")}>{label("resume")}</button>
        )}
        {accepts("restart") && (
          <button className="btn" disabled={dis} onClick={() => void click("restart")}>{label("restart")}</button>
        )}
        {accepts("set_loop") && (
          <button className="btn" disabled={dis} onClick={() => void click("set_loop", { loop: !d.loop })}>
            loop {d.loop ? "off" : "on"}
          </button>
        )}
        {accepts("set_speed") && (
          <label className="playback-speed">
            speed
            <select
              value={String(d.speed ?? 1)}
              disabled={dis}
              onChange={(e) => void click("set_speed", { speed: Number(e.target.value) })}
            >
              {SPEED_PRESETS.map((s) => (
                <option key={s} value={String(s)}>{speedText(s)}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {feedback}
    </div>
  );
}
