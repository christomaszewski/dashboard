import type { CameraWidgetConfig } from "../../config/schema";
import { useLifecycleContext } from "../../lifecycle/LifecycleContext";
import { useStreamsContext } from "../../streams/StreamsContext";
import { useStreamSession } from "../../streams/pool/useStreamSession";
import { TileControls } from "../../streams/TileControls";
import { sourceChip } from "../../streams/types";
import { resolveStreamRef } from "../resolveStream";

/**
 * A camera tile you can DRIVE: the `video` widget's chrome plus the overlaid controls (TileControls).
 * The stream and its recorder are paired by the one <instance> both contracts share (a camera's
 * media key and its lifecycle key use the same segment), so no second config key is needed.
 * Shares the pooled WebRTC session with the Cameras tab — one session/encode however many tiles.
 */
export function CameraWidget({ widget }: { widget: CameraWidgetConfig }) {
  const { streams } = useStreamsContext();
  const { find } = useLifecycleContext();
  const stream = resolveStreamRef(streams, widget.stream);
  const { snapshot, videoRef } = useStreamSession(stream?.key ?? null);

  if (!stream) {
    return (
      <div className="widget-card widget-video-empty">
        <span className="widget-label">{widget.label ?? widget.stream}</span>
        <p className="empty">
          waiting for <span className="mono">{widget.stream}</span> to advertise…
        </p>
      </div>
    );
  }

  const service = widget.controls === "none" || widget.controls === "playback" ? undefined : find(stream.sensorId);
  const state = snapshot?.state ?? "opening";
  const chip = sourceChip(stream.descriptor.source);
  const label = widget.label ?? stream.descriptor.role ?? stream.descriptor.id;
  const dims =
    stream.descriptor.width && stream.descriptor.height ? `${stream.descriptor.width}×${stream.descriptor.height}` : "";
  const statusText = state === "offline" ? "offline — will resume" : state === "reconnecting" ? "reconnecting…" : state;

  return (
    <div className={`stream-view grid widget-video widget-camera${stream.alive ? "" : " is-offline"}`}>
      <div className="tile-media">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="tile-overlay">
          <strong>{label}</strong>
          <span className="meta">
            {chip && <span className={`chip ${chip.playback ? "info" : "ok"} source-chip`}>{chip.text}</span>}
            {stream.descriptor.codec ?? "?"} {dims}
          </span>
        </div>
        {state !== "playing" && <span className="pill warn tile-status">{statusText}</span>}
        {state === "playing" && (
          <TileControls service={service} playback={null} confirm={widget.confirm} runId={widget.run_id} />
        )}
      </div>
    </div>
  );
}
