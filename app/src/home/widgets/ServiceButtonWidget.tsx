import { useEffect, useRef, useState } from "react";
import type { ServiceButtonWidgetConfig } from "../../config/schema";
import { useTransportContext } from "../../transport/TransportContext";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { callService, ServiceCallError } from "../../services/callService";

type Phase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "calling" }
  | { kind: "ok"; summary: string }
  | { kind: "err"; message: string };

const FLASH_MS = 4000;

function summarize(response: Record<string, unknown>): string {
  // Stock srv convention (Trigger/SetBool): success + message. Fall back to a compact dump.
  if (typeof response.success === "boolean")
    return `${response.success ? "success" : "FAILED"}${response.message ? ` — ${String(response.message)}` : ""}`;
  const keys = Object.keys(response);
  if (keys.length === 0) return "done";
  try {
    const json = JSON.stringify(response, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "done";
  }
}

export function ServiceButtonWidget({ widget, compact = false }: { widget: ServiceButtonWidgetConfig; compact?: boolean }) {
  const { transport } = useTransportContext();
  const { graph } = useRosGraphContext();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const flashTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const entry = graph.services.find((s) => s.name === widget.service && s.servers.length > 0);
  const typeMismatch =
    widget.srv_type !== undefined && entry !== undefined && entry.typeName !== widget.srv_type
      ? `graph advertises ${entry.typeName}, config says ${widget.srv_type}`
      : undefined;

  const flash = (next: Phase) => {
    setPhase(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setPhase({ kind: "idle" }), FLASH_MS);
  };

  const fire = async () => {
    if (!transport) return;
    setPhase({ kind: "calling" });
    try {
      const result = await callService(transport, graph, widget.service, widget.request ?? {}, {
        timeoutMs: widget.timeout_s !== undefined ? widget.timeout_s * 1000 : undefined,
      });
      flash({ kind: "ok", summary: summarize(result.response) });
    } catch (e) {
      const message = e instanceof ServiceCallError ? `${e.kind}: ${e.message}` : String(e);
      flash({ kind: "err", message });
    }
  };

  const onClick = () => {
    if (phase.kind === "calling") return;
    if (widget.confirm && phase.kind !== "confirm") {
      setPhase({ kind: "confirm" });
      return;
    }
    void fire();
  };

  const disabled = !transport || !entry || phase.kind === "calling";
  const buttonLabel =
    phase.kind === "confirm" ? "confirm?" : phase.kind === "calling" ? "calling…" : widget.label;
  const subText =
    phase.kind === "ok"
      ? phase.summary
      : phase.kind === "err"
        ? phase.message
        : typeMismatch
          ? `⚠ ${typeMismatch}`
          : entry
            ? entry.typeName
            : "no server advertised";
  const subClass = `dim mono widget-sub${phase.kind === "err" ? " is-err" : ""}`;
  const button = (
    <button className={`btn primary${phase.kind === "confirm" ? " confirm" : ""}`} disabled={disabled} onClick={onClick}>
      {buttonLabel}
    </button>
  );

  if (compact) {
    return (
      <div className="panel-row" title={widget.service}>
        {button}
        <span className={subClass}>{subText}</span>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <span className="widget-label">
        <span className={`dot ${entry ? "ok" : ""}`} /> {widget.service}
      </span>
      {button}
      <span className={subClass}>{subText}</span>
    </div>
  );
}
