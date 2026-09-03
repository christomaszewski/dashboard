import { useEffect, useRef, useState, type ReactNode } from "react";
import { RigError } from "./client";
import { useRigContext } from "./RigContext";
import type { RigJobRequest } from "./types";

export type SubmitPhase =
  | { kind: "idle" }
  | { kind: "confirm"; token: string }
  | { kind: "calling"; token: string }
  | { kind: "ok"; token: string; summary: string }
  | { kind: "err"; token: string; message: string };

const FLASH_MS = 6000;

/**
 * The click → (confirm) → submit → flash machine behind every rig verb button. A verb is a JOB:
 * the ack comes back in well under a second (`queued j-…`) and the progress lives in the job
 * panel, so the button itself only flashes the ack or the refusal. `token` names the button so a
 * group of buttons can share one phase (only one two-step confirm at a time).
 */
export function useRigSubmit(opts: { confirm?: boolean } = {}) {
  const { submit } = useRigContext();
  const [phase, setPhase] = useState<SubmitPhase>({ kind: "idle" });
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flash = (next: SubmitPhase) => {
    setPhase(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPhase({ kind: "idle" }), FLASH_MS);
  };

  const fire = async (token: string, req: RigJobRequest) => {
    setPhase({ kind: "calling", token });
    try {
      const r = await submit(req);
      if (r.ok) flash({ kind: "ok", token, summary: `${req.verb} queued${r.job_id ? ` (${r.job_id})` : ""}` });
      else flash({ kind: "err", token, message: `${req.verb} refused: ${r.error ?? "no reason given"}` });
    } catch (e) {
      flash({ kind: "err", token, message: e instanceof RigError ? `${e.kind}: ${e.message}` : String(e) });
    }
  };

  /** `needConfirm` overrides the hook-level default for destructive buttons. */
  const click = (token: string, req: RigJobRequest, needConfirm: boolean = opts.confirm === true) => {
    if (phase.kind === "calling") return;
    if (needConfirm && !(phase.kind === "confirm" && phase.token === token)) {
      setPhase({ kind: "confirm", token });
      return;
    }
    void fire(token, req);
  };

  const cancelConfirm = () => {
    if (phase.kind === "confirm") setPhase({ kind: "idle" });
  };

  const confirming = (token: string): boolean => phase.kind === "confirm" && phase.token === token;
  const label = (token: string, text: string): string =>
    phase.kind === "calling" && phase.token === token ? "queuing…" : confirming(token) ? `${text}?` : text;

  const feedback: ReactNode =
    phase.kind === "ok" ? (
      <span className="dim mono rig-feedback">{phase.summary}</span>
    ) : phase.kind === "err" ? (
      <span className="mono rig-feedback is-err">{phase.message}</span>
    ) : null;

  return { phase, busy: phase.kind === "calling", click, cancelConfirm, confirming, label, feedback };
}
