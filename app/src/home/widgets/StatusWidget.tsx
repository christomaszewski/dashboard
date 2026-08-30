import { useEffect, useRef, useState } from "react";
import type { StatusWidgetConfig } from "../../config/schema";
import type { Subscription } from "../../transport/types";
import { useTransportContext } from "../../transport/TransportContext";
import { useStreamsContext } from "../../streams/StreamsContext";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { resolveStreamRef } from "../resolveStream";
import { RateMonitor } from "../rate";

type Level = "ok" | "warn" | "err" | "idle";

function StatusCard({ label, level, detail, mono }: { label: string; level: Level; detail: string; mono?: string }) {
  return (
    <div className="widget-card">
      <span className="widget-label">{label}</span>
      <span className={`pill ${level}`}>{detail}</span>
      {mono && <span className="dim mono widget-sub">{mono}</span>}
    </div>
  );
}

function StreamStatus({ widget }: { widget: StatusWidgetConfig }) {
  const { streams } = useStreamsContext();
  const s = resolveStreamRef(streams, widget.stream ?? "");
  if (!s) return <StatusCard label={widget.label} level="err" detail="not discovered" mono={widget.stream} />;
  return (
    <StatusCard
      label={widget.label}
      level={s.alive ? "ok" : "warn"}
      detail={s.alive ? "live" : "offline"}
      mono={s.descriptor.codec && s.descriptor.width ? `${s.descriptor.codec} ${s.descriptor.width}×${s.descriptor.height}` : s.key}
    />
  );
}

function NodeStatus({ widget }: { widget: StatusWidgetConfig }) {
  const { graph } = useRosGraphContext();
  const present = graph.nodes.some((n) => n.nodeFq === widget.node);
  return <StatusCard label={widget.label} level={present ? "ok" : "err"} detail={present ? "up" : "down"} mono={widget.node} />;
}

/** NB: measuring Hz means holding a live data subscription — the payload streams to the browser. */
function TopicHzStatus({ widget }: { widget: StatusWidgetConfig }) {
  const { transport } = useTransportContext();
  const { graph } = useRosGraphContext();
  const [hz, setHz] = useState<number | undefined>(undefined);
  const monitor = useRef(new RateMonitor((widget.window_s ?? 5) * 1000));

  const topic = graph.topics.find((t) => t.name === widget.topic);
  const dataKeyexpr = topic?.dataKeyexpr;

  useEffect(() => {
    if (!transport || !dataKeyexpr) return;
    let cancelled = false;
    let sub: Subscription | null = null;
    void transport
      .subscribe(dataKeyexpr, (s) => {
        if (s.kind === "put") monitor.current.record(performance.now());
      })
      .then((s) => {
        if (cancelled) void s.close();
        else sub = s;
      });
    const timer = window.setInterval(() => setHz(monitor.current.hz(performance.now())), 1000);
    return () => {
      cancelled = true;
      void sub?.close();
      clearInterval(timer);
      setHz(undefined);
    };
  }, [transport, dataKeyexpr]);

  if (!topic) return <StatusCard label={widget.label} level="idle" detail="waiting for topic" mono={widget.topic} />;
  const level: Level =
    hz === undefined ? "err" : widget.min_hz !== undefined && hz < widget.min_hz ? "warn" : "ok";
  const detail = hz === undefined ? "no data" : `${hz.toFixed(1)} Hz`;
  const target = widget.min_hz !== undefined ? `${widget.topic} ≥ ${widget.min_hz} Hz` : widget.topic;
  return <StatusCard label={widget.label} level={level} detail={detail} mono={target} />;
}

export function StatusWidget({ widget }: { widget: StatusWidgetConfig }) {
  if (widget.source === "stream") return <StreamStatus widget={widget} />;
  if (widget.source === "node") return <NodeStatus widget={widget} />;
  return <TopicHzStatus widget={widget} />;
}
