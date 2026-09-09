import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { changeState, LifecycleError, type ChangeStateResult } from "./changeState";
import type { LifecycleService } from "./types";

export type LifecyclePhase =
  | { kind: "idle" }
  | { kind: "confirm"; transition: string }
  | { kind: "calling"; transition: string }
  | { kind: "ok"; summary: string }
  | { kind: "warn"; summary: string } // ok:true but a finalize reported trouble
  | { kind: "err"; message: string };

const FLASH_MS = 6000;

/** One line for the result flash: state, idempotency, and the closed-session summary on deactivate. */
export function summarizeTransition(transition: string, r: ChangeStateResult): string {
  const parts = [`${transition}: ${r.state ?? "ok"}${r.noop ? " (already)" : ""}`];
  const s = r.session;
  if (s) {
    const files = Array.isArray(s.files) ? s.files.length : undefined;
    if (files !== undefined) parts.push(`${files} file${files === 1 ? "" : "s"} finalized`);
    if (typeof s.frames === "number") parts.push(`${s.frames.toLocaleString()} frames`);
    if (s.truncated) parts.push("TRUNCATED");
  }
  if (r.error) parts.push(`— ${r.error}`);
  return parts.join(" · ");
}

/**
 * The click → confirm → call → flash state machine behind a lifecycle transition button, shared
 * by the LifecycleCard and the Rig tab's per-row controls. `click(t)` handles the optional
 * two-step confirm; the reply arrives when the transition COMPLETES (a deactivate finalizes files
 * first), so `busy` stays true for up to a few seconds.
 */
export function useLifecycleAction(service: LifecycleService, opts: { confirm?: boolean; runId?: string } = {}) {
  const { transport, status } = useTransportContext();
  const online = !!transport && status === "connected";
  const [phase, setPhase] = useState<LifecyclePhase>({ kind: "idle" });
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const flash = (next: LifecyclePhase) => {
    setPhase(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setPhase({ kind: "idle" }), FLASH_MS);
  };

  const fire = async (transition: string) => {
    if (!transport) return;
    setPhase({ kind: "calling", transition });
    try {
      const r = await changeState(transport, service.key, transition, { runId: opts.runId });
      if (!r.ok) flash({ kind: "err", message: `${transition} refused: ${r.error ?? "no reason given"}` });
      else if (r.error || r.session?.truncated) flash({ kind: "warn", summary: summarizeTransition(transition, r) });
      else flash({ kind: "ok", summary: summarizeTransition(transition, r) });
    } catch (e) {
      const message = e instanceof LifecycleError ? `${e.kind}: ${e.message}` : String(e);
      flash({ kind: "err", message });
    }
  };

  const click = (transition: string) => {
    if (phase.kind === "calling") return;
    if (opts.confirm && !(phase.kind === "confirm" && phase.transition === transition)) {
      setPhase({ kind: "confirm", transition });
      return;
    }
    void fire(transition);
  };

  const busy = phase.kind === "calling";
  const lastError = service.descriptor.last_error;
  const feedback: ReactNode =
    phase.kind === "ok" ? (
      <span className="dim mono lifecycle-feedback">{phase.summary}</span>
    ) : phase.kind === "warn" ? (
      <span className="mono lifecycle-feedback is-warn">⚠ {phase.summary}</span>
    ) : phase.kind === "err" ? (
      <span className="mono lifecycle-feedback is-err">{phase.message}</span>
    ) : lastError ? (
      <span className="mono lifecycle-feedback is-err">last error: {lastError}</span>
    ) : null;

  /** Label for the button of `transition` given the current phase. */
  const label = (transition: string): string =>
    phase.kind === "calling" && phase.transition === transition
      ? "calling…"
      : phase.kind === "confirm" && phase.transition === transition
        ? `${transition}?`
        : transition;

  const confirming = (transition: string): boolean => phase.kind === "confirm" && phase.transition === transition;

  return { phase, busy, click, feedback, label, confirming, canCall: online };
}
