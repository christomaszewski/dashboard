import type { LifecycleService } from "../lifecycle/types";
import { recordingFiles, sinceText } from "../lifecycle/types";
import { useLifecycleAction } from "../lifecycle/useLifecycleAction";
import { SPEED_PRESETS, positionText, speedText, type PlaybackService } from "../playback/types";
import { usePlaybackAction } from "../playback/usePlaybackAction";

/** The playback half: a PlaybackService when the producer advertises PLAYBACK.md, else null. */
export type PlaybackControls = PlaybackService | null;

/**
 * The controls a camera tile overlays on its video, shared by the Home `camera` widget and the
 * Cameras-tab StreamView so the two never drift. Bottom-left: ONE always-visible state pill —
 * recording (blinking) with elapsed + file count, standby, or offline — and, on hover, the strip
 * beside it: a record button per transition the service accepts RIGHT NOW (never an assumed state
 * machine). The reply to change_state arrives when the transition completes (a deactivate
 * finalizes files first), so the button stays busy for up to a few seconds and the result flashes
 * above the pill. No lifecycle advertised = no pill, no strip: a plain tile.
 */
export function TileControls({
  service,
  playback,
  confirm = false,
  runId,
  showRecord = true,
  showPlayback = true,
}: {
  service: LifecycleService | undefined;
  playback: PlaybackControls;
  confirm?: boolean;
  runId?: string;
  showRecord?: boolean;
  showPlayback?: boolean;
}) {
  const rec = service && showRecord;
  const pb = playback && showPlayback;
  if (!rec && !pb) return null;
  return (
    <>
      {rec && <RecordControls service={service} confirm={confirm} runId={runId} />}
      {pb && <PlaybackStrip service={playback} beside={!!rec} />}
    </>
  );
}

/**
 * The playback strip: ⏯ per what the producer accepts, ⟲ restart, a speed button that cycles the
 * presets, ⟳ loop (lit when on). Its own pill shows position while paused or a non-1× speed while
 * playing; at plain 1× playing it stays quiet — the record pill (if any) owns the corner. Sits to
 * the right of the record strip when both render.
 */
function PlaybackStrip({ service, beside }: { service: PlaybackService; beside: boolean }) {
  const { busy, click, phase, accepts, canCall } = usePlaybackAction(service);
  const d = service.descriptor;
  const dis = !canCall || busy;
  const nextSpeed = SPEED_PRESETS[(SPEED_PRESETS.indexOf(d.speed ?? 1) + 1) % SPEED_PRESETS.length];
  const pill =
    d.state === "paused"
      ? { cls: "warn", text: `⏸ ${positionText(d)}` }
      : d.state === "finished"
        ? { cls: "idle", text: "finished" }
        : d.speed !== undefined && d.speed !== 1
          ? { cls: "info", text: `▶ ${speedText(d.speed)}` }
          : null;
  const flash = phase.kind === "ok" ? { cls: "ok", text: phase.summary } : phase.kind === "err" ? { cls: "err", text: phase.message } : null;
  return (
    <>
      {flash && <span className={`tile-flash pb ${flash.cls}`}>{flash.text}</span>}
      <div className={`tile-state tile-playback${beside ? " beside" : ""}`} title={`${service.key} · ${d.source} · cycle ${d.cycle ?? "?"}`}>
        {pill && <span className={`pill ${pill.cls}`}>{pill.text}</span>}
        <div className="tile-controls">
          {accepts("pause") && (
            <button className="icon-btn" disabled={dis} title="pause playback" onClick={(e) => { e.stopPropagation(); void click("pause"); }}>⏸</button>
          )}
          {accepts("resume") && (
            <button className="icon-btn on" disabled={dis} title="resume playback" onClick={(e) => { e.stopPropagation(); void click("resume"); }}>▶</button>
          )}
          {accepts("restart") && (
            <button className="icon-btn" disabled={dis} title="restart from the beginning" onClick={(e) => { e.stopPropagation(); void click("restart"); }}>⟲</button>
          )}
          {accepts("set_speed") && (
            <button className="icon-btn speed" disabled={dis} title={`speed ${speedText(d.speed)} → ${speedText(nextSpeed)}`} onClick={(e) => { e.stopPropagation(); void click("set_speed", { speed: nextSpeed }); }}>
              {speedText(d.speed ?? 1)}
            </button>
          )}
          {accepts("set_loop") && (
            <button className={`icon-btn${d.loop ? " on" : ""}`} disabled={dis} title={d.loop ? "looping — click to play once" : "play once — click to loop"} onClick={(e) => { e.stopPropagation(); void click("set_loop", { loop: !d.loop }); }}>⟳</button>
          )}
        </div>
      </div>
    </>
  );
}

function RecordControls({ service, confirm, runId }: { service: LifecycleService; confirm: boolean; runId?: string }) {
  const { busy, click, phase, label, confirming, canCall } = useLifecycleAction(service, { confirm, runId });
  const d = service.descriptor;
  const rec = d.recording;
  const active = d.state === "active";
  const files = recordingFiles(rec);
  const pill = !service.alive
    ? { cls: "warn", text: `${d.state} · offline` }
    : d.last_error
      ? { cls: "err", text: d.state }
      : active
        ? { cls: "ok rec", text: `REC ${sinceText(rec?.started_unix_s ?? d.since_unix_s)}${files !== undefined ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}` }
        : d.state === "inactive"
          ? { cls: "idle", text: "standby" }
          : { cls: "warn", text: d.state };
  const flash =
    phase.kind === "ok" || phase.kind === "warn"
      ? { cls: phase.kind, text: phase.summary }
      : phase.kind === "err"
        ? { cls: "err", text: phase.message }
        : null;
  return (
    <>
      {flash && <span className={`tile-flash ${flash.cls}`}>{flash.text}</span>}
      <div className="tile-state" title={`${service.key}${d.last_error ? ` — ${d.last_error}` : ""}`}>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
        <div className="tile-controls">
          {d.transitions.map((t) => (
            <button
              key={t}
              className={`icon-btn rec${t === "deactivate" ? " on" : ""}${confirming(t) ? " confirm" : ""}`}
              disabled={!canCall || busy || !service.alive}
              title={`${label(t)} ${service.instance}`}
              onClick={(e) => {
                e.stopPropagation();
                click(t);
              }}
            >
              {t === "activate" ? "●" : t === "deactivate" ? "■" : t}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
