import { useEffect, useRef, useState } from "react";
import type { SparklineWidgetConfig } from "./specs";
import { useTopic } from "../../../ros/useTopic";
import { pluckField } from "../../pluck";
import { formatValue, valueLevel } from "../../value";
import { SeriesBuffer, seriesPath } from "./series";

const CARD_W = 240;
const CARD_H = 60;
const ROW_W = 90;
const ROW_H = 20;

/**
 * Recent history of one numeric field. Samples arrive at the TopicStore's flush rate (≤5 Hz per
 * topic, shared with every other consumer); each new decoded message appends one point.
 */
export function SparklineWidget({ widget, compact = false }: { widget: SparklineWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const series = useRef(new SeriesBuffer((widget.window_s ?? 60) * 1000));
  const [, bump] = useState(0);

  const message = snapshot?.message;
  useEffect(() => {
    if (message === undefined) return;
    const v = pluckField(message, widget.field);
    const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
    if (n === undefined) return;
    series.current.push(performance.now(), n);
    bump((i) => i + 1);
  }, [message, widget.field]);

  // Let the window slide even when no samples arrive (a stalled topic empties out).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const before = series.current.points.length;
      series.current.prune(performance.now());
      if (series.current.points.length !== before) bump((i) => i + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const last = series.current.last;
  const error = snapshot?.error ?? "";
  const level = valueLevel(widget, last?.v, error);
  const text = error ? "!" : last === undefined ? "—" : formatValue(last.v, widget.precision);
  const detail = error || (topic ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`);
  const w = compact ? ROW_W : CARD_W;
  const h = compact ? ROW_H : CARD_H;
  const path = seriesPath(series.current.points, w, h, widget.min, widget.max);

  const chart = (
    <svg className={`sparkline-svg ${level}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      {path && <path d={path.d} fill="none" vectorEffect="non-scaling-stroke" />}
    </svg>
  );

  if (compact) {
    return (
      <div className="panel-row" title={detail}>
        <span className="row-label">{widget.label}</span>
        <span className="sparkline-row">{chart}</span>
        <span className={`row-value ${level}`}>
          {text}
          {widget.unit && last ? <small> {widget.unit}</small> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="widget-card widget-sparkline">
      <span className="widget-label">{widget.label}</span>
      <div className="sparkline-head">
        <span className={`widget-value ${level}`}>
          {text}
          {widget.unit && last ? <small> {widget.unit}</small> : null}
        </span>
        {path && (
          <span className="dim mono sparkline-range">
            {formatValue(path.min, widget.precision)} … {formatValue(path.max, widget.precision)}
          </span>
        )}
      </div>
      <div className="sparkline-chart">{chart}</div>
      <span className={`dim mono widget-sub${error ? " is-err" : ""}`}>
        {detail} · {widget.window_s ?? 60} s
      </span>
    </div>
  );
}
