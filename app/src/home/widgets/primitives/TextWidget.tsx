import type { TextWidgetConfig } from "./specs";

/** Static operator notes from the config — whitespace preserved, no markup. */
export function TextWidget({ widget, compact = false }: { widget: TextWidgetConfig; compact?: boolean }) {
  if (compact) {
    return (
      <div className="panel-row" title={widget.text}>
        {widget.label && <span className="row-label">{widget.label}</span>}
        <span className="text-row">{widget.text.trim().split("\n")[0]}</span>
      </div>
    );
  }
  return (
    <div className="widget-card">
      {widget.label && <span className="widget-label">{widget.label}</span>}
      <pre className="widget-text">{widget.text.trim()}</pre>
    </div>
  );
}
