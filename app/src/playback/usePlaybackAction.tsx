import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { playbackControl, PlaybackError, type PlaybackParams, type PlaybackResult } from "./playbackControl";
import { speedText, type PlaybackOp, type PlaybackService } from "./types";

export type PlaybackPhase =
  | { kind: "idle" }
  | { kind: "calling"; op: string }
  | { kind: "ok"; summary: string }
  | { kind: "err"; message: string };

const FLASH_MS = 4000;

export function summarizePlayback(op: PlaybackOp, params: PlaybackParams | undefined, r: PlaybackResult): string {
  const what =
    op === "set_speed" ? `speed ${speedText(params?.speed)}` : op === "set_loop" ? `loop ${params?.loop ? "on" : "off"}` : op;
  const parts = [`${what}: ${r.state ?? "ok"}${r.noop ? " (already)" : ""}${r.pending ? " (pending)" : ""}`];
  if (r.error) parts.push(`— ${r.error}`);
  return parts.join(" ");
}

/**
 * The click → call → flash machine behind a playback control, the sibling of useLifecycleAction:
 * same surface (busy / click / feedback / label / canCall), no confirm step (playback ops are
 * cheap and reversible), replies within a second.
 */
export function usePlaybackAction(service: PlaybackService) {
  const { transport } = useTransportContext();
  const [phase, setPhase] = useState<PlaybackPhase>({ kind: "idle" });
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );
  const flash = (next: PlaybackPhase) => {
    setPhase(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setPhase({ kind: "idle" }), FLASH_MS);
  };

  const click = async (op: PlaybackOp, params?: PlaybackParams) => {
    if (!transport || phase.kind === "calling") return;
    setPhase({ kind: "calling", op });
    try {
      const r = await playbackControl(transport, service.key, op, params);
      if (!r.ok) flash({ kind: "err", message: `${op} refused: ${r.error ?? "no reason given"}` });
      else flash({ kind: "ok", summary: summarizePlayback(op, params, r) });
    } catch (e) {
      flash({ kind: "err", message: e instanceof PlaybackError ? `${e.kind}: ${e.message}` : String(e) });
    }
  };

  const busy = phase.kind === "calling";
  const lastError = service.descriptor.last_error;
  const feedback: ReactNode =
    phase.kind === "ok" ? (
      <span className="dim mono lifecycle-feedback">{phase.summary}</span>
    ) : phase.kind === "err" ? (
      <span className="mono lifecycle-feedback is-err">{phase.message}</span>
    ) : lastError ? (
      <span className="mono lifecycle-feedback is-err">last error: {lastError}</span>
    ) : null;
  const label = (op: string): string => (phase.kind === "calling" && phase.op === op ? "calling…" : op);
  /** The producer lists what it accepts right now; the UI never assumes. */
  const accepts = (op: PlaybackOp): boolean => service.descriptor.controls.includes(op);

  return { phase, busy, click, feedback, label, accepts, canCall: !!transport && service.alive };
}
