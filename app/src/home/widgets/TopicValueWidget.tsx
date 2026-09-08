import type { TopicValueWidgetConfig } from "../../config/schema";
import { useTopic } from "../../ros/useTopic";
import { pluckField } from "../pluck";
import { renderTemplate } from "../template";
import { formatValue, valueLevel, type ValueLevel } from "../value";

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

/**
 * Live readout off the shared TopicStore (one sub + one decode per topic app-wide, however many
 * readouts watch it). `compact` renders the panel-row form instead of a card.
 */
export function TopicValueWidget({ widget, compact = false }: { widget: TopicValueWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const r = readout(widget, snapshot?.message, snapshot?.error ?? "", topic !== null && topic !== undefined);
  const cls = `${r.level}${r.formatted ? " formatted" : ""}`;

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
