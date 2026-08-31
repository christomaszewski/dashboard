import type { TopicValueWidgetConfig } from "../../config/schema";
import { useTopic } from "../../ros/useTopic";
import { pluckField } from "../pluck";
import { formatValue, valueLevel } from "../value";

/**
 * Live single-field readout off the shared TopicStore (one sub + one decode per topic app-wide,
 * however many readouts watch it). `compact` renders the panel-row form instead of a card.
 */
export function TopicValueWidget({ widget, compact = false }: { widget: TopicValueWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const value = snapshot?.message !== undefined ? pluckField(snapshot.message, widget.field) : undefined;
  const error = snapshot?.error ?? "";
  const level = valueLevel(widget, value, error);
  const text = error ? "!" : formatValue(value, widget.precision);
  const showUnit = !error && value !== undefined && widget.unit;
  const detail = error || (topic ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`);

  if (compact) {
    return (
      <div className="panel-row" title={detail}>
        <span className="row-label">{widget.label}</span>
        <span className={`row-value ${level}`}>
          {text}
          {showUnit ? <small> {widget.unit}</small> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <span className="widget-label">{widget.label}</span>
      <span className={`widget-value ${level}`}>
        {text}
        {showUnit ? <small> {widget.unit}</small> : null}
      </span>
      <span className={`dim mono widget-sub${error ? " is-err" : ""}`}>{detail}</span>
    </div>
  );
}
