import type { LifecycleWidgetConfig } from "../../config/schema";
import { useLifecycleContext } from "../../lifecycle/LifecycleContext";
import { LifecycleCard } from "../../lifecycle/LifecycleCard";

/** Config-driven lifecycle control for one service instance (`service: cam0` or `veh1/cam0`). */
export function LifecycleWidget({ widget, compact = false }: { widget: LifecycleWidgetConfig; compact?: boolean }) {
  const { find } = useLifecycleContext();
  const service = find(widget.service);
  if (!service) {
    if (compact) {
      return (
        <div className="panel-row" title={widget.service}>
          <span className="row-label">{widget.label ?? widget.service}</span>
          <span className="pill idle">not advertised</span>
        </div>
      );
    }
    return (
      <div className="widget-card">
        <span className="widget-label">{widget.label ?? widget.service}</span>
        <span className="pill idle">not advertised</span>
        <span className="dim mono widget-sub">waiting for fleet/*/svc/{widget.service}/lifecycle…</span>
      </div>
    );
  }
  return <LifecycleCard service={service} title={widget.label} confirm={widget.confirm} runId={widget.run_id} compact={compact} />;
}
