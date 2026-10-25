import { useEffect, useRef, useState } from "react";
import type { SparklineWidgetConfig } from "./specs";
import { useTopic } from "../../../ros/useTopic";
import { pluckField } from "../../pluck";
import { displayQuantum, formatValue, valueLevel } from "../../value";
import { SeriesBuffer, historyPoints, seriesPath } from "./series";

const CARD_W = 240;
const CARD_H = 60;
const ROW_W = 90;
const ROW_H = 20;

/**
 * Recent history of one numeric field. Samples arrive at the TopicStore's flush rate (≤5 Hz per
 * topic, shared with every other consumer); each new decoded message appends one point.
 */
export function SparklineWidget({ widget, compact = false }: { widget: SparklineWidgetConfig; compact?: boolean }) {
  const windowMs = (widget.window_s ?? 60) * 1000;
  // With vehicle state the vehicle keeps the history (min/max/last per bucket): a reload or a
  // reconnect shows the whole window at once instead of starting empty.
  const { topic, snapshot } = useTopic(widget.topic, {
    fields: [{ p: widget.field, q: displayQuantum(widget.precision) }],
    series: { window_ms: windowMs, bucket_ms: Math.max(100, Math.ceil(windowMs / 240)) },
  });
  const series = useRef(new SeriesBuffer(windowMs));
  const [, bump] = useState(0);
  const history = snapshot?.history;
  const onVehicle = useRef(false);
  onVehicle.current = history !== undefined;

  const message = snapshot?.message;
  useEffect(() => {
    if (message === undefined || history) return;
    const v = pluckField(message, widget.field);
    const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
    if (n === undefined) return;
    series.current.push(performance.now(), n);
    bump((i) => i + 1);
  }, [message, widget.field, history]);

  // Let the window slide even when no samples arrive (a stalled topic empties out).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const before = series.current.points.length;
      series.current.prune(performance.now());
      // A vehicle history is drawn on to now: slide it every second even without new buckets.
      if (onVehicle.current || series.current.points.length !== before) bump((i) => i + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const points = history ? historyPoints(history, performance.now(), windowMs) : series.current.points;
  const last = history ? points[points.length - 1] : series.current.last;
  const error = snapshot?.error ?? "";
  const level = valueLevel(widget, last?.v, error);
  const text = error ? "!" : last === undefined ? "—" : formatValue(last.v, widget.precision);
  const stale = snapshot?.stale && !error ? " stale" : "";
  const detail = error || (topic ? `${widget.topic} · ${widget.field}${stale ? " · stale" : ""}` : `${widget.topic} — waiting for topic`);
  const w = compact ? ROW_W : CARD_W;
  const h = compact ? ROW_H : CARD_H;
  const path = seriesPath(points, w, h, widget.min, widget.max);

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
        <span className={`row-value ${level}${stale}`}>
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
        <span className={`widget-value ${level}${stale}`}>
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
