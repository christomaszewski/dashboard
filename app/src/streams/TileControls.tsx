import type { LifecycleService } from "../lifecycle/types";
import { recordingFiles, sinceText } from "../lifecycle/types";
import { useLifecycleAction } from "../lifecycle/useLifecycleAction";

/**
 * Playback control seam (PLAYBACK.md, not yet advertised by any producer): when a PlaybackContext
 * lands it hands a tile this shape and the strip grows pause/resume, speed, restart and loop.
 * Until then every tile passes null and nothing playback-related renders.
 */
export type PlaybackControls = null;

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
  playback: _playback, // the seam: unused until a producer advertises PLAYBACK.md
  confirm = false,
  runId,
  showRecord = true,
}: {
  service: LifecycleService | undefined;
  playback: PlaybackControls;
  confirm?: boolean;
  runId?: string;
  showRecord?: boolean;
}) {
  if (!service || !showRecord) return null;
  return <RecordControls service={service} confirm={confirm} runId={runId} />;
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
