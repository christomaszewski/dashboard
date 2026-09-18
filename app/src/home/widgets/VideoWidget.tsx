import type { VideoWidgetConfig } from "../../config/schema";
import { useStreamsContext } from "../../streams/StreamsContext";
import { sourceChip } from "../../streams/types";
import { useStreamSession } from "../../streams/pool/useStreamSession";
import { resolveStreamRef } from "../resolveStream";

/**
 * Embedded live stream. Shares the pooled WebRTC session with the Cameras tab — showing the same
 * camera in both places costs ONE session/encode. Same tile chrome as StreamView minus the
 * focus/unsubscribe actions (a home widget is a fixture, not a console tile).
 */
export function VideoWidget({ widget }: { widget: VideoWidgetConfig }) {
  const { streams } = useStreamsContext();
  const stream = resolveStreamRef(streams, widget.stream);
  // No acquire until discovered — render a placeholder instead of dialing a phantom.
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

  const state = snapshot?.state ?? "opening";
  const chip = sourceChip(stream.descriptor.source);
  const label = widget.label ?? stream.descriptor.role ?? stream.descriptor.id;
  const dims =
    stream.descriptor.width && stream.descriptor.height ? `${stream.descriptor.width}×${stream.descriptor.height}` : "";
  const statusText = state === "offline" ? "offline — will resume" : state === "reconnecting" ? "reconnecting…" : state;

  return (
    <div className={`stream-view grid widget-video${stream.alive ? "" : " is-offline"}`}>
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
      </div>
    </div>
  );
}
