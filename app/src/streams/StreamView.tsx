import type { DiscoveredStream } from "./types";
import { sourceChip } from "./types";
import { useStreamSession } from "./pool/useStreamSession";

export type ViewMode = "grid" | "focused" | "thumb";

/**
 * One rendered stream tile. The WebRTC session, retries, stall watchdog, and liveliness handling all
 * live in the shared StreamSessionPool — this component just acquires the stream for its lifetime
 * and attaches its <video>. Several tiles of the same stream (Home widget + Cameras tab) share ONE
 * session. `mode` only changes the chrome/CSS — layout switches never touch the session.
 */
export function StreamView({
  stream,
  mode,
  onFocus,
  onRestore,
  onClose,
}: {
  stream: DiscoveredStream;
  mode: ViewMode;
  onFocus: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { snapshot, videoRef } = useStreamSession(stream.key);
  const state = snapshot?.state ?? "opening";
  const err = snapshot?.error ?? "";

  const { descriptor } = stream;
  const label = descriptor.role || descriptor.id;
  const chip = sourceChip(descriptor.source);
  const dims = descriptor.width && descriptor.height ? `${descriptor.width}×${descriptor.height}` : "";
  const statusText =
    state === "offline" ? "offline — will resume" : state === "reconnecting" ? "reconnecting…" : state;
  const pillClass = state === "playing" ? "ok" : "warn";

  return (
    <div
      className={`stream-view ${mode}${stream.alive ? "" : " is-offline"}`}
      onClick={mode === "thumb" ? onFocus : undefined}
      title={mode === "thumb" ? `${label} — click to focus` : state === "reconnecting" ? err : undefined}
    >
      <div className="tile-media">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="tile-overlay">
          <strong>{label}</strong>
          {mode !== "thumb" && (
            <span className="meta">
              {chip && <span className={`chip ${chip.playback ? "info" : "ok"} source-chip`}>{chip.text}</span>}
              {descriptor.codec ?? "?"} {dims}
            </span>
          )}
        </div>
        {mode !== "thumb" && (
          <div className="tile-actions">
            <button
              className="icon-btn"
              title={mode === "focused" ? "back to grid (Esc)" : "maximize"}
              onClick={mode === "focused" ? onRestore : onFocus}
            >
              {mode === "focused" ? "⤡" : "⤢"}
            </button>
            <button className="icon-btn" title="unsubscribe" onClick={onClose}>
              ✕
            </button>
          </div>
        )}
        {mode !== "thumb" && state !== "playing" && <span className={`pill ${pillClass} tile-status`}>{statusText}</span>}
      </div>
    </div>
  );
}
