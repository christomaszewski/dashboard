import { useState } from "react";
import type { CameraWidgetConfig } from "../../config/schema";
import { useLifecycleContext } from "../../lifecycle/LifecycleContext";
import { usePlaybackContext } from "../../playback/PlaybackContext";
import { StreamPicker } from "../../streams/StreamPicker";
import { useStreamsContext } from "../../streams/StreamsContext";
import { useStreamSession } from "../../streams/pool/useStreamSession";
import { TileControls } from "../../streams/TileControls";
import { sourceChip } from "../../streams/types";
import { resolveStreamRef } from "../resolveStream";
import { loadChoice, saveChoice, widgetKey } from "./persist";

const isKey = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * A camera tile you can DRIVE: the `video` widget's chrome plus the overlaid controls (TileControls).
 * The stream and its recorder are paired by the one <instance> both contracts share (a camera's
 * media key and its lifecycle key use the same segment), so no second config key is needed.
 * Shares the pooled WebRTC session with the Cameras tab — one session/encode however many tiles.
 *
 * Which stream: the config's `stream` is a DEFAULT. The tile's picker changes it, the choice is
 * remembered per widget; with no `stream` at all the only discovered stream auto-selects and
 * several offer the picker in the tile's place. `lock` pins the configured stream, picker gone.
 */
export function CameraWidget({ widget }: { widget: CameraWidgetConfig }) {
  const { streams } = useStreamsContext();
  const { find } = useLifecycleContext();
  const { find: findPlayback } = usePlaybackContext();
  const memory = widgetKey("camera", widget.label, widget.stream ?? "default");
  const [chosenKey, setChosenKey] = useState<string | null>(() => loadChoice(memory, isKey) ?? null);

  const configured = widget.stream ? resolveStreamRef(streams, widget.stream) : undefined;
  const chosen = chosenKey && !widget.lock ? streams.find((s) => s.key === chosenKey) : undefined;
  const auto = !widget.stream && !chosenKey && streams.length === 1 ? streams[0] : undefined;
  const stream = chosen ?? configured ?? auto;
  const { snapshot, videoRef } = useStreamSession(stream?.key ?? null);

  const pick = (key: string) => {
    setChosenKey(key);
    saveChoice(memory, key);
  };
  const picker = widget.lock ? null : (
    <StreamPicker streams={streams} value={stream?.key ?? null} onChange={pick} className="tile-picker" />
  );

  if (!stream) {
    return (
      <div className="widget-card widget-video-empty">
        <span className="widget-label">{widget.label ?? widget.stream ?? "camera"}</span>
        {widget.stream || streams.length === 0 ? (
          <p className="empty">
            waiting for <span className="mono">{widget.stream ?? "a stream"}</span> to advertise…
          </p>
        ) : (
          <p className="empty">
            {streams.length} streams discovered — {picker}
          </p>
        )}
      </div>
    );
  }

  const service = widget.controls === "none" || widget.controls === "playback" ? undefined : find(stream.sensorId);
  // Playback controls appear iff the producer ADVERTISES playback (the token), never from the chip.
  const playback = widget.controls === "none" || widget.controls === "record" ? null : (findPlayback(stream.sensorId) ?? null);
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
        {picker && streams.length > 1 && <div className="tile-actions">{picker}</div>}
        {state !== "playing" && <span className="pill warn tile-status">{statusText}</span>}
        {(state === "playing" || state === "reconnecting") && (
          <TileControls service={service} playback={playback} confirm={widget.confirm} runId={widget.run_id} />
        )}
      </div>
    </div>
  );
}
