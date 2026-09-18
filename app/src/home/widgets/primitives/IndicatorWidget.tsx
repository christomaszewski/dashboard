import type { IndicatorWidgetConfig } from "./specs";
import { useTopic } from "../../../ros/useTopic";
import { pluckField } from "../../pluck";
import { formatValue } from "../../value";
import { evaluateRules } from "./rules";

/** Value → colored state pill through the widget's declarative rules. */
export function IndicatorWidget({ widget, compact = false }: { widget: IndicatorWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const value = snapshot?.message !== undefined ? pluckField(snapshot.message, widget.field) : undefined;
  const error = snapshot?.error ?? "";
  const outcome = error || value === undefined ? { level: error ? ("err" as const) : ("idle" as const) } : evaluateRules(value, widget.rules, widget.default);
  const text = error ? "!" : value === undefined ? "—" : (outcome.text ?? formatValue(value));
  const detail = error || (topic ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`);

  if (compact) {
    return (
      <div className="panel-row" title={detail}>
        <span className="row-label">{widget.label}</span>
        <span className={`pill ${outcome.level}`}>{text}</span>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <span className="widget-label">{widget.label}</span>
      <span className={`pill indicator-pill ${outcome.level}`}>{text}</span>
      <span className={`dim mono widget-sub${error ? " is-err" : ""}`}>{detail}</span>
    </div>
  );
}
