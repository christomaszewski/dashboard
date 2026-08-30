import { useEffect, useRef, useState } from "react";
import type { TopicValueWidgetConfig } from "../../config/schema";
import type { Subscription } from "../../transport/types";
import { useTransportContext } from "../../transport/TransportContext";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { pluckField } from "../pluck";

const FLUSH_MS = 200; // decode + render the latest sample at 5 Hz (TopicInspector's throttle)

function thresholdLevel(w: TopicValueWidgetConfig, v: number): "ok" | "warn" | "err" {
  if ((w.err_below !== undefined && v < w.err_below) || (w.err_above !== undefined && v > w.err_above)) return "err";
  if ((w.warn_below !== undefined && v < w.warn_below) || (w.warn_above !== undefined && v > w.warn_above)) return "warn";
  return "ok";
}

function formatValue(v: unknown, precision?: number): string {
  if (typeof v === "number") return precision !== undefined ? v.toFixed(precision) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "bigint" || typeof v === "boolean" || typeof v === "string") return String(v);
  if (v === undefined) return "—";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Live single-field readout: subscribe → decode (shared resolver cache) → pluck → threshold color. */
export function TopicValueWidget({ widget }: { widget: TopicValueWidgetConfig }) {
  const { transport } = useTransportContext();
  const { graph, resolver } = useRosGraphContext();
  const [value, setValue] = useState<unknown>(undefined);
  const [error, setError] = useState("");
  const latest = useRef<Uint8Array | null>(null);

  const topic = graph.topics.find((t) => t.name === widget.topic);
  const dataKeyexpr = topic?.dataKeyexpr;

  useEffect(() => {
    if (!transport || !resolver || !topic || !dataKeyexpr) return;
    let cancelled = false;
    let sub: Subscription | null = null;
    let timer: number | null = null;
    latest.current = null;
    setValue(undefined);
    setError("");

    const identity = { flavor: "ros2" as const, typeName: topic.typeName, rihsHash: topic.typeHash };
    resolver
      .resolve(identity)
      .then(async (decoder) => {
        if (cancelled) return;
        const flush = () => {
          const payload = latest.current;
          if (!payload) return;
          latest.current = null;
          try {
            setValue(pluckField(decoder.decode(payload), widget.field));
            setError("");
          } catch (e) {
            setError(`decode failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        };
        sub = await transport.subscribe(dataKeyexpr, (s) => {
          if (s.kind === "put") latest.current = s.payload;
        });
        if (cancelled) {
          void sub.close();
          sub = null;
          return;
        }
        timer = window.setInterval(flush, FLUSH_MS);
        if (topic.transientLocal) {
          const replies = await transport.get(dataKeyexpr);
          if (!cancelled && replies.length > 0 && latest.current === null) latest.current = replies[0].payload;
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`no decoder: ${e instanceof Error ? e.message : String(e)}`);
      });

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      void sub?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, resolver, dataKeyexpr, topic?.transientLocal, widget.field]);

  const num = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
  const level = error ? "err" : value === undefined ? "idle" : num !== undefined ? thresholdLevel(widget, num) : "ok";

  return (
    <div className="widget-card">
      <span className="widget-label">{widget.label}</span>
      <span className={`widget-value ${level}`}>
        {error ? "!" : formatValue(value, widget.precision)}
        {!error && value !== undefined && widget.unit ? <small> {widget.unit}</small> : null}
      </span>
      <span className="dim mono widget-sub">{error || `${widget.topic} · ${widget.field}`}</span>
    </div>
  );
}
