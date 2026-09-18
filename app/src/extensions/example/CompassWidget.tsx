// Worked example of a project widget: a compass rose showing a heading field from any topic.
//
//   - type: example_compass
//     label: Heading
//     topic: /imu/heading           # any topic with a numeric heading field
//     field: data                   # dot-path into the decoded message
//     # units: deg                  # deg (default) | rad
//
// Everything comes from the SDK: `registerWidget` for the spec+component, `useTopic` for the
// shared decoded data, `pluckField`/`formatValue` for the value. It honors `compact` (so it can be
// a panel row) and renders a waiting state — the containment rules every widget follows.
import { formatValue, optStr, pluckField, registerWidget, reqStr, useTopic, type BaseWidgetConfig, type Obj } from "../../widgets/sdk";

interface CompassWidgetConfig extends BaseWidgetConfig {
  type: "example_compass";
  label: string;
  topic: string;
  field: string;
  units: "deg" | "rad";
}

function CompassWidget({ widget, compact = false }: { widget: CompassWidgetConfig; compact?: boolean }) {
  const { topic, snapshot } = useTopic(widget.topic);
  const raw = snapshot?.message !== undefined ? pluckField(snapshot.message, widget.field) : undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "bigint" ? Number(raw) : undefined;
  const deg = n === undefined ? undefined : (((widget.units === "rad" ? (n * 180) / Math.PI : n) % 360) + 360) % 360;
  const text = deg === undefined ? "—" : `${formatValue(deg, 0)}°`;
  const detail = snapshot?.error ?? (topic ? `${widget.topic} · ${widget.field}` : `${widget.topic} — waiting for topic`);

  if (compact) {
    return (
      <div className="panel-row" title={detail}>
        <span className="row-label">{widget.label}</span>
        <span className="row-value">{text}</span>
      </div>
    );
  }

  return (
    <div className="widget-card" style={{ alignItems: "center" }}>
      <span className="widget-label" style={{ alignSelf: "flex-start" }}>
        {widget.label}
      </span>
      <svg viewBox="0 0 100 100" width="140" height="140" role="img" aria-label={`${widget.label}: ${text}`}>
        <circle cx="50" cy="50" r="44" fill="none" stroke="var(--border)" strokeWidth="2" />
        {["N", "E", "S", "W"].map((c, i) => (
          <text
            key={c}
            x={50 + 36 * Math.sin((i * Math.PI) / 2)}
            y={50 - 36 * Math.cos((i * Math.PI) / 2) + 3}
            textAnchor="middle"
            fontSize="9"
            fill={c === "N" ? "var(--accent)" : "var(--text-faint)"}
          >
            {c}
          </text>
        ))}
        {deg !== undefined && (
          <polygon
            points="50,14 45,50 50,46 55,50"
            fill="var(--accent)"
            transform={`rotate(${deg.toFixed(1)} 50 50)`}
          />
        )}
        <text x="50" y="72" textAnchor="middle" fontSize="12" fontFamily="var(--mono)" fill="var(--text)">
          {text}
        </text>
      </svg>
      <span className="dim mono widget-sub">{detail}</span>
    </div>
  );
}

registerWidget<CompassWidgetConfig>({
  type: "example_compass",
  description: "example extension: compass rose from a heading field",
  panelCapable: true,
  parse: (raw: Obj) => {
    const units = optStr(raw, "units") ?? "deg";
    if (units !== "deg" && units !== "rad") throw new Error("'units' must be deg or rad");
    return { label: reqStr(raw, "label"), topic: reqStr(raw, "topic"), field: reqStr(raw, "field"), units };
  },
  component: CompassWidget,
});
