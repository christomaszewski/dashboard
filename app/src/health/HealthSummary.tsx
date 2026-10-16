import { formatValue, thresholdLevel } from "../home/value";
import { HealthInstance, temperatureLabel, useTrend, type HealthViewOptions, type Measurement } from "./HealthInstance";
import { HealthTooltip } from "./HealthTooltip";
import { healthIssues, observationText } from "./summary";
import { componentOf, healthVerdict, metricUnit, reporterCurrent, selectStatuses, statusCurrent, temperatureWhere,
  type HealthService, type HealthStatus } from "./types";

function SourceDetail({ service }: { service: HealthService }) {
  return <span className="health-tooltip-source">{service.vehicleId} · {service.sourceLabel ?? "Zenoh JSON"}<br />{service.key}</span>;
}

function StatusDetail({ service, status, nowMs, connected }: {
  service: HealthService; status: HealthStatus; nowMs: number; connected: boolean;
}) {
  const values = Object.entries(status.values).filter(([k]) => !k.startsWith("health.") && !["alerts.log", "alerts.epoch", "alert.detail"].includes(k));
  const labels: Record<string, string> = { "alert.code": "Code", "alert.category": "Category", "alert.severity": "Severity", "alert.active": "Active" };
  return <>
    <strong>{status.name}</strong>
    <p>{status.message}</p>
    {status.values["alerts.history_gap"] === true && <p>Alert history is incomplete; some earlier events may be missing.</p>}
    {status.values["alert.detail"] && status.values["alert.detail"] !== status.message && <p>{String(status.values["alert.detail"])}</p>}
    {status.values["health.error"] && <p className="health-note warn">Observation failed: {String(status.values["health.error"])}</p>}
    <span className="health-tooltip-source">{observationText(service, status, nowMs, connected)}</span>
    {status.hardware_id && <span className="health-tooltip-source">{status.hardware_id}</span>}
    {values.length > 0 && <dl className="health-values mono">{values.map(([k, v]) => <div key={k}>
      <dt>{labels[k] ?? k}</dt><dd>{v === null ? "unavailable" : formatValue(v)}{typeof v === "number" && metricUnit(k) ? ` ${metricUnit(k)}` : ""}</dd>
    </div>)}</dl>}
    <SourceDetail service={service} />
  </>;
}

function SummaryMetric({ service, reading, options, nowMs, connected, missing }: {
  service: HealthService; reading: Measurement; options: HealthViewOptions; nowMs: number; connected: boolean; missing: boolean;
}) {
  const historyS = options.historyS ?? 300;
  const precision = options.precision ?? 1;
  const trend = useTrend(service, reading, historyS, nowMs);
  const state = reading.status.values[`health.metric.${reading.key}.state`];
  const current = connected && reporterCurrent(service, nowMs) && !missing && (!state || state === "current") && statusCurrent(service, reading.status, nowMs);
  const color = !current ? "idle" : reading.unit === "°C" ? thresholdLevel(options.thresholds ?? {}, reading.value) : "ok";
  const text = `${missing ? "—" : formatValue(reading.value, precision)} ${reading.unit}`;
  const label = temperatureLabel(reading);
  return <HealthTooltip className={`health-summary-metric ${color}`} label={`${label}: ${text}${!current ? ", unavailable or last known" : ""}`}
    detail={<>
      <strong>{label} · {text}</strong>
      <p>{reading.key}{state && state !== "current" ? ` · ${state}` : ""}</p>
      {trend && <><svg className={`sparkline-svg health-tooltip-trend ${color}`} viewBox="0 0 90 20" preserveAspectRatio="none" aria-hidden>
        <path d={trend.d} fill="none" vectorEffect="non-scaling-stroke" /></svg>
        <p>{formatValue(trend.low, precision)} … {formatValue(trend.high, precision)} {reading.unit} over {historyS} s</p></>}
      <StatusDetail service={service} status={reading.status} nowMs={nowMs} connected={connected} />
    </>}>
    <span className="health-metric-label">{reading.key === "supply.power_w" ? "power" : reading.component === "temperature" || reading.component.startsWith("temperature/") ? reading.where : label}</span>
    <span className={`row-value ${color}`}>{missing ? "—" : formatValue(reading.value, precision)}<small> {reading.unit}</small></span>
    {trend && <svg className={`sparkline-svg ${color}`} viewBox="0 0 90 20" preserveAspectRatio="none" aria-hidden>
      <path d={trend.d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>}
    {!current && <span className="health-metric-quality">{missing ? "unavailable" : "last known"}</span>}
  </HealthTooltip>;
}

function RadioSummary({ service, statuses, nowMs, connected }: {
  service: HealthService; statuses: readonly HealthStatus[]; nowMs: number; connected: boolean;
}) {
  const control = statuses.find((s) => componentOf(s, service.instance) === "service");
  const radio = statuses.find((s) => componentOf(s, service.instance) === "radio");
  if (![control, radio].some((s) => s && (service.snapshot.service === "doodle" ||
    ["rf.tx_power_dbm", "rf.target", "rf.target_dbm", "rf.state"].some((key) => key in s.values)))) return null;

  // The radio poll owns observed RF state/power. Never replace an off, missing or stale
  // radio observation with the supervisor's independently sampled copy.
  const observed = radio ?? control;
  const rf = observed?.values["rf.state"];
  const dbm = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${formatValue(value)} dBm` : null;
  const power = dbm(observed?.values["rf.tx_power_dbm"]);
  const target = control?.values["rf.target"];
  const targetName = typeof target === "string" && target.trim() && target !== "null" ? target : null;
  const targetPower = dbm(control?.values["rf.target_dbm"]);
  const targetText = targetName && targetPower && targetName !== targetPower
    ? `${targetName} (${targetPower})` : targetName ?? targetPower;
  const fields = [
    ...(observed ? [
      { label: "TX power", key: "rf.tx_power_dbm", text: rf === "off" ? "—" : power,
        status: observed, note: rf === "off" ? "RF off" : "" },
    ] : []),
    ...(control ? [{ label: "Target", key: "rf.target", text: targetText, status: control, note: "" }] : []),
    ...(observed ? [{ label: "RF state", key: "rf.state", text: rf === "on" ? "On" : rf === "off" ? "Off" : null,
      status: observed, note: "" }] : []),
  ];
  return <div className="health-summary-metrics health-radio-metrics">{fields.map(({ label, key, text, status, note }) => {
    const state = status.values[`health.metric.${key}.state`];
    const current = text !== null && connected && reporterCurrent(service, nowMs) && statusCurrent(service, status, nowMs) &&
      status.values["health.availability"] !== "retrying" && (!state || state === "current");
    const quality = text === null ? "unavailable" : !current ? "last known" : note;
    const color = current ? "ok" : "idle";
    return <HealthTooltip key={key} className={`health-summary-metric ${color}`}
      label={`${label}: ${text ?? "—"}${quality ? `, ${quality}` : ""}`}
      detail={<><strong>{label} · {text ?? "—"}</strong>
        {quality && <p>{quality}</p>}
        <StatusDetail service={service} status={status} nowMs={nowMs} connected={connected} />
      </>}>
      <span className="health-metric-label">{label}</span>
      <span className={`row-value ${color}`}>{text ?? "—"}</span>
      {quality && <span className="health-metric-quality">{quality}</span>}
    </HealthTooltip>;
  })}</div>;
}

function PowerModeSummary({ service, statuses, nowMs, connected }: {
  service: HealthService; statuses: readonly HealthStatus[]; nowMs: number; connected: boolean;
}) {
  const status = statuses.find((s) => "power.mode_name" in s.values);
  if (!status) return null;
  const raw = status.values["power.mode_name"], id = status.values["power.mode_id"];
  const name = typeof raw === "string" && raw.trim() && raw !== "null" ? raw : null;
  const text = name ? `${name}${typeof id === "number" && Number.isInteger(id) && id >= 0 ? ` (id ${id})` : ""}` : "—";
  const state = status.values["health.metric.power.mode_name.state"];
  const current = name !== null && connected && reporterCurrent(service, nowMs) && statusCurrent(service, status, nowMs) &&
    status.values["health.availability"] !== "retrying" && (!state || state === "current");
  const note = name === null ? "unavailable" : !current ? "last known" : status.values["power.switching"] === true ? "switching" : "";
  return <div className="health-summary-metrics"><HealthTooltip className={`health-summary-metric ${current ? "ok" : "idle"}`}
    label={`Power profile: ${text}${note ? `, ${note}` : ""}`}
    detail={<><strong>Active power profile · {text}</strong><p>{note || "Observed nvpmodel setting"}</p>
      <StatusDetail service={service} status={status} nowMs={nowMs} connected={connected} /></>}>
    <span className="health-metric-label">Power profile</span>
    <span className={`row-value ${current ? "ok" : "idle"}`}>{text}</span>
    {note && <span className="health-metric-quality">{note}</span>}
  </HealthTooltip></div>;
}

/** Shared scannable summary: per-component freshness, named readings, and one pill per issue. */
export function HealthSummary({ service, options = {}, nowMs, qualified = false, connected = true, expandable = false }: {
  service: HealthService; options?: HealthViewOptions; nowMs: number; qualified?: boolean; connected?: boolean; expandable?: boolean;
}) {
  const statuses = selectStatuses(service.snapshot, options.components);
  const verdict = healthVerdict(service, statuses, nowMs);
  const issues = healthIssues(service, statuses, nowMs);
  const readings = statuses.flatMap((status) => Object.entries(status.values).flatMap(([key, value]) => {
    const where = temperatureWhere(key);
    if (where === null && key !== "supply.power_w") return [];
    if (status.values[`health.metric.${key}.state`] === "unsupported") return [];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return [];
    return [{ reading: { status, component: componentOf(status, service.instance), key, where: where ?? "power",
      value: typeof value === "number" ? value : 0, unit: where === null ? "W" : "°C" }, missing: value === null }];
  }));
  const hardware = [...new Set(statuses.map((s) => s.hardware_id).filter(Boolean))];
  return <div className="health-instance health-summary" data-instance={service.instance} data-service-key={service.key}>
    <div className="health-head">
      <span className="health-name" title={service.key}>{qualified ? `${service.vehicleId}/${service.instance}` : service.instance}</span>
      <HealthTooltip className={`pill health-verdict ${!connected && verdict.level === "ok" ? "idle" : verdict.level}`}
        label={`${service.instance}: ${verdict.text}${!connected ? ", updates disconnected" : ""}`}
        detail={<><strong>{service.instance} · {verdict.text}</strong>
          {!connected && <p>Dashboard disconnected. These are the last received observations.</p>}
          <p>{statuses.length} components{options.components ? " in configured view" : ""} · {issues.length} active issues</p>
          {hardware.map((h) => <span className="health-tooltip-source" key={h}>{h}</span>)}
          <SourceDetail service={service} /></>}>
        {!connected && verdict.level === "ok" ? "last known OK" : verdict.text}
      </HealthTooltip>
    </div>
    {readings.length > 0 && <div className="health-summary-metrics">{readings.map(({ reading, missing }) =>
      <SummaryMetric key={`${reading.status.name}/${reading.key}`} service={service} reading={reading} missing={missing}
        options={options} nowMs={nowMs} connected={connected} />)}</div>}
    <RadioSummary service={service} statuses={statuses} nowMs={nowMs} connected={connected} />
    <PowerModeSummary service={service} statuses={statuses} nowMs={nowMs} connected={connected} />
    {issues.length > 0 && <div className="health-issues" aria-label={`${service.instance} issues`}>
      {issues.map((issue) => <HealthTooltip key={issue.status.name} className={`pill health-issue ${issue.color}`}
        label={`${issue.severity} ${issue.label}`}
        detail={<StatusDetail service={service} status={issue.status} nowMs={nowMs} connected={connected} />}>
        <span className="health-issue-severity">{issue.severity}</span><span className="health-issue-label">{issue.label}</span>
      </HealthTooltip>)}
    </div>}
    {(expandable || options.details) && <details className="health-component-details" open={options.details || undefined}>
      <summary>Component details <span className="dim">({statuses.length})</span></summary>
      <HealthInstance service={service} options={{ ...options, details: true }} nowMs={nowMs} connected={connected} />
    </details>}
  </div>;
}
