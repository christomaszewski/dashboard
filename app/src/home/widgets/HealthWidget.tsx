import { useState } from "react";
import type { HealthWidgetConfig } from "../../config/schema";
import { useHealthContext } from "../../health/HealthContext";
import type { HealthViewOptions } from "../../health/HealthInstance";
import { HealthSummary } from "../../health/HealthSummary";
import { HEALTH_PATTERN, type HealthService } from "../../health/types";
import { useNow } from "../../health/useHealth";
import { useTransportContext } from "../../transport/TransportContext";
import { loadChoice, saveChoice, widgetKey } from "./persist";

type Choice = { refs: string[] | null }; // null follows discovery, including future reporters
const isChoice = (v: unknown): v is Choice => typeof v === "object" && v !== null && "refs" in v &&
  (v.refs === null || (Array.isArray(v.refs) && v.refs.every((r) => typeof r === "string" && r.length > 0)));
const serviceRef = (s: HealthService) => s.key.startsWith("ros2/") ? s.key : `${s.vehicleId}/${s.instance}`;

/** Uses the shared health store; selection only changes this view, never subscriptions/producers. */
export function HealthWidget({ widget, compact = false }: { widget: HealthWidgetConfig; compact?: boolean }) {
  // A changed YAML selection starts a fresh preference scope. Labels distinguish identical widgets.
  const memoryKey = `${widgetKey("health", widget.label, "default")}.${JSON.stringify(widget.services ?? null)}`;
  return <HealthWidgetView key={memoryKey} widget={widget} compact={compact} memoryKey={memoryKey} />;
}

function HealthWidgetView({ widget, compact, memoryKey }: { widget: HealthWidgetConfig; compact: boolean; memoryKey: string }) {
  const { services, find, errors = [] } = useHealthContext();
  const { status } = useTransportContext();
  const nowMs = useNow();
  const [choice, setChoice] = useState<Choice | undefined>(() => loadChoice(memoryKey, isChoice));
  const refs = (!widget.lock && choice ? choice.refs : widget.services) ?? null;
  const resolve = (ref: string) => services.find((s) => s.key === ref) ?? find(ref);
  const candidatesInOrder = refs ? refs.map((ref) => ({ ref, service: resolve(ref) })) : services.map((service) => ({ ref: serviceRef(service), service }));
  const rows = [...new Map(candidatesInOrder.map((r) => [r.service?.key ?? r.ref, r])).values()];
  const selected = rows.map(({ ref, service }) => service ? serviceRef(service) : ref);
  const candidates = [...new Map([...rows, ...services.map((service) => ({ ref: serviceRef(service), service }))]
    .map(({ ref, service }) => [service ? serviceRef(service) : ref, { ref: service ? serviceRef(service) : ref, service }])).values()];
  const remember = (next: string[] | null) => { const value = { refs: next }; setChoice(value); saveChoice(memoryKey, value); };
  const options: HealthViewOptions = { components: widget.components, details: widget.details, thresholds: widget,
    historyS: widget.history_s, precision: widget.precision };
  const names = services.map((s) => s.instance);
  const connected = status === "connected";
  return <div className={compact ? "widget-health health-panel" : "widget-card widget-health"}>
    <div className="widget-head health-widget-head">
      <span className="widget-label">{widget.label ?? "Health"}</span>
      {!widget.lock ? <details className="health-picker">
        <summary aria-label="Choose health services">{refs === null ? "All reporters" : `${rows.length} selected`} <span aria-hidden>⌄</span></summary>
        <div className="health-picker-body">
          <label><input type="checkbox" checked={refs === null} onChange={(e) => remember(e.target.checked ? null : selected)} /> Auto-discover all reporters</label>
          <span className="dim widget-sub">Select services to watch. Choices are saved in this browser.</span>
          <div className="health-picker-list">{candidates.map(({ ref, service }) => <label key={ref}>
            <input type="checkbox" checked={selected.includes(ref)} onChange={(e) => remember(e.target.checked ? [...selected, ref] : selected.filter((r) => r !== ref))} />
            <span>{service ? `${service.vehicleId}/${service.instance}` : ref}</span>
          </label>)}{!candidates.length && <span className="dim">No reporters discovered yet.</span>}</div>
          {widget.services && <button className="btn small" onClick={() => remember(widget.services!)}>Use configured services</button>}
        </div>
      </details> : <span className="dim widget-sub">{refs === null ? "All reporters" : `${rows.length} configured`}</span>}
    </div>
    {!connected && <p className="health-connection" role="status">Updates {status} · showing last known health</p>}
    {errors.length > 0 && <details className="health-input-errors"><summary>Health input errors ({errors.length})</summary>
      {errors.map((error) => <p key={error}>{error}</p>)}</details>}
    {rows.length === 0 ? <span className="dim widget-sub">
      {refs ? "No services selected. Choose services above." : <>Waiting for service health or ROS 2 diagnostics…<br /><span className="mono">{HEALTH_PATTERN}</span></>}
    </span> : <div className="health-overview-list">{rows.map(({ ref, service }) => service ?
      <HealthSummary key={service.key} service={service} options={options} nowMs={nowMs} connected={connected}
        qualified={names.indexOf(service.instance) !== names.lastIndexOf(service.instance)} /> :
      <div key={ref} className="health-instance health-summary" data-instance={ref}>
        <div className="health-head"><span className="health-name">{ref}</span><span className="pill idle">not reported</span></div>
        <span className="dim widget-sub">Waiting for this service to publish health.</span>
      </div>)}</div>}
  </div>;
}
