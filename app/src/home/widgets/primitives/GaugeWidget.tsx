import type { GaugeWidgetConfig } from "./specs";
import { useTopic } from "../../../ros/useTopic";
import { pluckField } from "../../pluck";
import { formatValue, valueLevel } from "../../value";

// 270° arc from -135° (bottom-left) to +135° (bottom-right) in a 100×72 box.
const CX = 50;
const CY = 50;
const R = 40;
const SWEEP = 270;
const START = -135;

function polar(deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
}

function arc(fromDeg: number, toDeg: number): string {
  const [x1, y1] = polar(fromDeg);
  const [x2, y2] = polar(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Arc gauge: fraction of [min, max] drawn as a threshold-colored arc over a track. */
export function GaugeWidget({ widget, compact = false }: { widget: GaugeWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const value = snapshot?.message !== undefined ? pluckField(snapshot.message, widget.field) : undefined;
  const num = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
  const error = snapshot?.error ?? "";
  const level = valueLevel(widget, num, error);
  const fraction = num === undefined ? 0 : Math.min(1, Math.max(0, (num - widget.min) / (widget.max - widget.min)));
  const text = error ? "!" : num === undefined ? "—" : formatValue(num, widget.precision);
  const detail = error || (topic ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`);

  if (compact) {
    return (
      <div className="panel-row" title={detail}>
        <span className="row-label">{widget.label}</span>
        <span className="gauge-bar" aria-hidden>
          <span className={`gauge-bar-fill ${level}`} style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
        </span>
        <span className={`row-value ${level}`}>
          {text}
          {widget.unit && num !== undefined ? <small> {widget.unit}</small> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="widget-card widget-gauge">
      <span className="widget-label">{widget.label}</span>
      <svg className="gauge-svg" viewBox="0 0 100 72" role="img" aria-label={`${widget.label}: ${text}`}>
        <path className="gauge-track" d={arc(START, START + SWEEP)} />
        {fraction > 0 && <path className={`gauge-value ${level}`} d={arc(START, START + SWEEP * fraction)} />}
        <text className={`gauge-text ${level}`} x="50" y="52" textAnchor="middle">
          {text}
        </text>
        {widget.unit && num !== undefined && (
          <text className="gauge-unit" x="50" y="63" textAnchor="middle">
            {widget.unit}
          </text>
        )}
        <text className="gauge-bound" x="12" y="70">
          {formatValue(widget.min)}
        </text>
        <text className="gauge-bound" x="88" y="70" textAnchor="end">
          {formatValue(widget.max)}
        </text>
      </svg>
      <span className={`dim mono widget-sub${error ? " is-err" : ""}`}>{detail}</span>
    </div>
  );
}
