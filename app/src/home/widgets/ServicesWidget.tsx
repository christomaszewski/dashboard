import { useEffect, useRef, useState } from "react";
import type { ServiceCallSpec, ServicesWidgetConfig } from "../../config/schema";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { callService, describeService, ServiceCallError } from "../../services/callService";
import { EMPTY_STRUCT_PLACEHOLDER, fieldSpecs, initialTexts, parseFieldText, stringify, type FieldSpec } from "../../services/fields";
import { useTransportContext } from "../../transport/TransportContext";

type Phase = "idle" | "confirm" | "calling";
type Outcome =
  | { kind: "ok"; response: Record<string, unknown>; rttMs: number; at: Date; warning?: string }
  | { kind: "err"; message: string; at: Date };
interface Shape {
  typeName: string;
  fields: FieldSpec[];
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour12: false });

/** The response as `key: value` lines (nested values as JSON, bigints as digits). */
export function responseLines(response: Record<string, unknown>): string[] {
  const keys = Object.keys(response).filter((k) => k !== EMPTY_STRUCT_PLACEHOLDER);
  if (keys.length === 0) return ["(empty response)"];
  return keys.map((k) => {
    const v = response[k];
    const text = typeof v === "string" ? v : typeof v === "bigint" ? v.toString() : typeof v === "object" && v !== null ? stringify(v) : String(v);
    return `${k}: ${text}`;
  });
}

function ServiceRow({ spec }: { spec: ServiceCallSpec }) {
  const { transport } = useTransportContext();
  const { graph } = useRosGraphContext();
  const entry = graph.services.find((s) => s.name === spec.service && s.servers.length > 0);
  const typeKey = entry ? `${entry.typeName}@${entry.servers[0]?.topic?.typeHash ?? ""}` : "";
  const [shape, setShape] = useState<Shape | null>(null);
  const [shapeError, setShapeError] = useState("");
  const [texts, setTexts] = useState<Record<string, string> | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The form comes from the live type: resolve when a server is up (and again if its type changes).
  useEffect(() => {
    if (!transport || !entry) return;
    let stale = false;
    setShapeError("");
    describeService(transport, graph, spec.service, { timeoutMs: (spec.timeout_s ?? 5) * 1000 })
      .then((s) => {
        if (stale || !alive.current) return;
        const fields = fieldSpecs(s.requestDefs);
        setShape({ typeName: s.typeName, fields });
        setTexts((prev) => prev ?? initialTexts(fields, spec.request));
      })
      .catch((e: unknown) => {
        if (stale || !alive.current) return;
        setShapeError(e instanceof ServiceCallError ? `${e.kind}: ${e.message}` : String(e));
      });
    return () => {
      stale = true;
    };
    // graph changes constantly; re-resolve only when the server / its type changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, typeKey, spec.service]);

  const typeMismatch =
    spec.srv_type !== undefined && entry !== undefined && entry.typeName !== spec.srv_type
      ? `graph advertises ${entry.typeName}, config says ${spec.srv_type}`
      : undefined;

  const buildRequest = (): Record<string, unknown> => {
    const request: Record<string, unknown> = {};
    for (const f of shape?.fields ?? []) request[f.name] = parseFieldText(f, texts?.[f.name] ?? "");
    return request;
  };

  const fire = async () => {
    if (!transport) return;
    let request: Record<string, unknown>;
    try {
      request = buildRequest();
    } catch (e) {
      setOutcome({ kind: "err", message: `request: ${e instanceof Error ? e.message : String(e)}`, at: new Date() });
      setPhase("idle");
      return;
    }
    setPhase("calling");
    try {
      const r = await callService(transport, graph, spec.service, request, {
        timeoutMs: spec.timeout_s !== undefined ? spec.timeout_s * 1000 : undefined,
      });
      if (alive.current) setOutcome({ kind: "ok", response: r.response, rttMs: r.rttMs, at: new Date(), warning: r.warning });
    } catch (e) {
      if (alive.current) setOutcome({ kind: "err", message: e instanceof ServiceCallError ? `${e.kind}: ${e.message}` : String(e), at: new Date() });
    }
    if (alive.current) setPhase("idle");
  };
  const onCall = () => {
    if (phase === "calling") return;
    if (spec.confirm && phase !== "confirm") {
      setPhase("confirm");
      return;
    }
    void fire();
  };
  const reset = () => shape && setTexts(initialTexts(shape.fields, spec.request));

  const label = spec.label ?? spec.service;
  const disabled = !transport || !entry || phase === "calling";
  const sub = shapeError ? `⚠ ${shapeError}` : typeMismatch ? `⚠ ${typeMismatch}` : entry ? (shape?.typeName ?? entry.typeName) : "no server advertised";
  return (
    <div className="service-row" data-service={spec.service}>
      <div className="service-head">
        <span className={`dot ${entry ? "ok" : ""}`} />
        <span className="service-name" title={spec.service}>
          <strong>{label}</strong>
          {label !== spec.service && <span className="dim mono"> {spec.service}</span>}
        </span>
        <span className={`pill ${entry ? "ok" : "idle"}`}>{entry ? "ready" : "no server"}</span>
        <button className={`btn primary small${phase === "confirm" ? " confirm" : ""}`} disabled={disabled} onClick={onCall} title={`call ${spec.service}`}>
          {phase === "confirm" ? "confirm?" : phase === "calling" ? "calling…" : "call"}
        </button>
      </div>
      <span className={`dim mono widget-sub${shapeError || typeMismatch ? " is-err" : ""}`}>{sub}</span>
      {shape && shape.fields.length > 0 && texts && (
        <div className="service-fields">
          {shape.fields.map((f) => (
            <FieldInput key={f.name} field={f} text={texts[f.name] ?? ""} onChange={(t) => setTexts({ ...texts, [f.name]: t })} />
          ))}
          <span />
          <button className="btn-link dim" onClick={reset} type="button">
            reset fields
          </button>
        </div>
      )}
      {outcome && (
        <div className={`service-response${outcome.kind === "err" ? " is-err" : ""}`} data-outcome={outcome.kind}>
          <span className="dim">
            {outcome.kind === "ok" ? `reply · ${Math.round(outcome.rttMs)} ms · ${clock(outcome.at)}` : `error · ${clock(outcome.at)}`}
            {outcome.kind === "ok" && outcome.warning ? ` · ⚠ ${outcome.warning}` : ""}
          </span>
          {"\n"}
          {outcome.kind === "ok" ? responseLines(outcome.response).join("\n") : outcome.message}
        </div>
      )}
    </div>
  );
}

function FieldInput({ field, text, onChange }: { field: FieldSpec; text: string; onChange: (t: string) => void }) {
  const id = `svc-${field.name}-${Math.random().toString(36).slice(2, 6)}`;
  const title = field.type;
  if (field.kind === "bool") {
    const on = text === "true" || text === "1";
    return (
      <>
        <label htmlFor={id} title={title}>
          {field.name}
        </label>
        <input id={id} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? "true" : "false")} aria-label={field.name} />
      </>
    );
  }
  return (
    <>
      <label htmlFor={id} title={title}>
        {field.name}
      </label>
      <input
        id={id}
        className="field mono"
        type="text"
        inputMode={field.kind === "int" || field.kind === "float" ? "decimal" : undefined}
        value={text}
        placeholder={field.kind === "json" ? field.type : field.type}
        onChange={(e) => onChange(e.target.value)}
        aria-label={field.name}
      />
    </>
  );
}

/**
 * Several services in one card: each row shows whether a server is up, a request form built from
 * the live type (bools, numbers, strings as inputs; arrays and nested messages as JSON; `request:`
 * pre-fills it), a call button, and the last response — kept until the next call.
 */
export function ServicesWidget({ widget }: { widget: ServicesWidgetConfig }) {
  return (
    <div className="widget-card widget-services">
      <span className="widget-label">{widget.label ?? "Services"}</span>
      {widget.services.map((s) => (
        <ServiceRow key={s.service} spec={s} />
      ))}
    </div>
  );
}
