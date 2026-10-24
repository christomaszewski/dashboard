import type { TopicValueWidgetConfig } from "../../config/schema";
import { useTopic } from "../../ros/useTopic";
import type { FieldSpec } from "../../vstate/protocol";
import { pluckField } from "../pluck";
import { renderTemplate } from "../template";
import { displayQuantum, formatValue, valueLevel, type ValueLevel } from "../value";

interface Readout {
  text: string;
  level: ValueLevel;
  unit?: string;
  detail: string;
  formatted: boolean;
}

/** One field (unit, precision, thresholds) or one format line (several placeholders, `?` + a warn
 *  level for a placeholder the message lacks) — from the same snapshot. */
function readout(widget: TopicValueWidgetConfig, message: unknown, error: string, seen: boolean): Readout {
  if (widget.template) {
    const r = message !== undefined ? renderTemplate(widget.template, message) : undefined;
    const missing = r?.missing ?? [];
    return {
      text: error ? "!" : r ? r.text : "—",
      level: error ? "err" : !r ? "idle" : missing.length ? "warn" : "ok",
      detail:
        error ||
        (missing.length
          ? `${widget.topic} — the message has no ${missing.join(", ")}`
          : seen
            ? `${widget.topic} · ${widget.template.paths.join(", ")}`
            : `${widget.topic} — waiting for topic`),
      formatted: true,
    };
  }
  const value = message !== undefined ? pluckField(message, widget.field ?? "") : undefined;
  return {
    text: error ? "!" : formatValue(value, widget.precision),
    level: valueLevel(widget, value, error),
    unit: !error && value !== undefined ? widget.unit : undefined,
    detail: error || (seen ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`),
    formatted: false,
  };
}

/** What the readout renders: its field at its precision, or each format placeholder at its own
 *  (a path used twice keeps the finer quantum). */
export function readoutFields(widget: TopicValueWidgetConfig): FieldSpec[] {
  if (!widget.template) return [{ p: widget.field ?? "", q: displayQuantum(widget.precision) }];
  const quanta = new Map<string, number>();
  for (const part of widget.template.parts) {
    if (!("path" in part)) continue;
    const q = displayQuantum(part.precision);
    quanta.set(part.path, Math.min(quanta.get(part.path) ?? q, q));
  }
  return [...quanta].map(([p, q]) => ({ p, q }));
}

/**
 * Live readout off the shared TopicStore (one sub + one decode per topic app-wide, however many
 * readouts watch it). `compact` renders the panel-row form instead of a card.
 */
export function TopicValueWidget({ widget, compact = false }: { widget: TopicValueWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic, { fields: readoutFields(widget) });
  const r = readout(widget, snapshot?.message, snapshot?.error ?? "", topic !== null && topic !== undefined);
  if (snapshot?.stale && !snapshot.error) r.detail += " · stale";
  const cls = `${r.level}${r.formatted ? " formatted" : ""}${snapshot?.stale ? " stale" : ""}`;

  if (compact) {
    return (
      <div className="panel-row" title={r.detail}>
        <span className="row-label">{widget.label}</span>
        <span className={`row-value ${cls}`}>
          {r.text}
          {r.unit ? <small> {r.unit}</small> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <span className="widget-label">{widget.label}</span>
      <span className={`widget-value ${cls}`}>
        {r.text}
        {r.unit ? <small> {r.unit}</small> : null}
      </span>
      <span className={`dim mono widget-sub${snapshot?.error ? " is-err" : ""}`}>{r.detail}</span>
    </div>
  );
}
