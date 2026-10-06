import type { HealthWidgetConfig } from "../../config/schema";
import { useHealthContext } from "../../health/HealthContext";
import { HealthInstance, type HealthViewOptions } from "../../health/HealthInstance";
import { HEALTH_PATTERN, type HealthService } from "../../health/types";
import { useNow } from "../../health/useHealth";

type Row = { ref: string; service: HealthService | undefined };

/**
 * Config-driven service health (camera-service docs/HEALTH.md): per instance a verdict pill, every
 * temperature it reports with a trend line, and whatever is not OK. `services:` names the instances
 * (`cam0` or `veh1/cam0`); omitted, every instance publishing health appears on its own.
 */
export function HealthWidget({ widget, compact = false }: { widget: HealthWidgetConfig; compact?: boolean }) {
  const { services, find } = useHealthContext();
  const nowMs = useNow();
  const rows: Row[] = widget.services
    ? widget.services.map((ref) => ({ ref, service: find(ref) }))
    : services.map((service) => ({ ref: service.instance, service }));
  const options: HealthViewOptions = {
    components: widget.components,
    details: widget.details,
    thresholds: widget,
    historyS: widget.history_s,
    precision: widget.precision,
  };
  // A label names the widget; it only stands in for the instance name when there is exactly one.
  const single = rows.length === 1 ? widget.label : undefined;

  if (compact) {
    if (rows.length === 0) {
      return (
        <div className="panel-row" title={HEALTH_PATTERN}>
          <span className="row-label">{widget.label ?? "health"}</span>
          <span className="pill idle">not advertised</span>
        </div>
      );
    }
    return (
      <>
        {rows.map(({ ref, service }) =>
          service ? (
            <HealthInstance key={service.key} service={service} title={single} options={options} nowMs={nowMs} compact />
          ) : (
            <div key={ref} className="panel-row" title={`fleet/*/svc/${ref}/health`}>
              <span className="row-label">{single ?? ref}</span>
              <span className="pill idle">not advertised</span>
            </div>
          ),
        )}
      </>
    );
  }

  return (
    <div className="widget-card widget-health">
      <span className="widget-label">{widget.label ?? "Health"}</span>
      {rows.length === 0 ? (
        <>
          <span className="pill idle">not advertised</span>
          <span className="dim mono widget-sub">waiting for {HEALTH_PATTERN}…</span>
        </>
      ) : (
        <div className="health-instances">
          {rows.map(({ ref, service }) =>
            service ? (
              <HealthInstance key={service.key} service={service} options={options} nowMs={nowMs} />
            ) : (
              <div key={ref} className="health-instance" data-instance={ref}>
                <div className="health-head">
                  <span className="health-name">{ref}</span>
                  <span className="pill idle">not advertised</span>
                </div>
                <span className="dim mono widget-sub">waiting for fleet/*/svc/{ref}/health…</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
