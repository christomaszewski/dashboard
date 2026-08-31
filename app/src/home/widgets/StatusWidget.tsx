import type { StatusWidgetConfig } from "../../config/schema";
import { useStreamsContext } from "../../streams/StreamsContext";
import { useRosGraphContext } from "../../ros/RosGraphContext";
import { useTopic } from "../../ros/useTopic";
import { resolveStreamRef } from "../resolveStream";

type Level = "ok" | "warn" | "err" | "idle";

function StatusCard({
  label,
  level,
  detail,
  mono,
  compact,
}: {
  label: string;
  level: Level;
  detail: string;
  mono?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="panel-row" title={mono}>
        <span className="row-label">{label}</span>
        <span className={`pill ${level}`}>{detail}</span>
      </div>
    );
  }
  return (
    <div className="widget-card">
      <span className="widget-label">{label}</span>
      <span className={`pill ${level}`}>{detail}</span>
      {mono && <span className="dim mono widget-sub">{mono}</span>}
    </div>
  );
}

function StreamStatus({ widget, compact }: { widget: StatusWidgetConfig; compact?: boolean }) {
  const { streams } = useStreamsContext();
  const s = resolveStreamRef(streams, widget.stream ?? "");
  if (!s) return <StatusCard label={widget.label} level="err" detail="not discovered" mono={widget.stream} compact={compact} />;
  return (
    <StatusCard
      label={widget.label}
      level={s.alive ? "ok" : "warn"}
      detail={s.alive ? "live" : "offline"}
      mono={s.descriptor.codec && s.descriptor.width ? `${s.descriptor.codec} ${s.descriptor.width}×${s.descriptor.height}` : s.key}
      compact={compact}
    />
  );
}

function NodeStatus({ widget, compact }: { widget: StatusWidgetConfig; compact?: boolean }) {
  const { graph } = useRosGraphContext();
  const present = graph.nodes.some((n) => n.nodeFq === widget.node);
  return (
    <StatusCard label={widget.label} level={present ? "ok" : "err"} detail={present ? "up" : "down"} mono={widget.node} compact={compact} />
  );
}

/** Rate-only watch off the shared TopicStore — never resolves/decodes the type (decode: false). */
function TopicHzStatus({ widget, compact }: { widget: StatusWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic, {
    windowMs: (widget.window_s ?? 5) * 1000,
    decode: false,
  });
  if (!topic)
    return <StatusCard label={widget.label} level="idle" detail="waiting for topic" mono={widget.topic} compact={compact} />;
  const hz = snapshot?.hz;
  const level: Level =
    hz === undefined ? "err" : widget.min_hz !== undefined && hz < widget.min_hz ? "warn" : "ok";
  const detail = hz === undefined ? "no data" : `${hz.toFixed(1)} Hz`;
  const target = widget.min_hz !== undefined ? `${widget.topic} ≥ ${widget.min_hz} Hz` : widget.topic;
  return <StatusCard label={widget.label} level={level} detail={detail} mono={target} compact={compact} />;
}

export function StatusWidget({ widget, compact = false }: { widget: StatusWidgetConfig; compact?: boolean }) {
  if (widget.source === "stream") return <StreamStatus widget={widget} compact={compact} />;
  if (widget.source === "node") return <NodeStatus widget={widget} compact={compact} />;
  return <TopicHzStatus widget={widget} compact={compact} />;
}
