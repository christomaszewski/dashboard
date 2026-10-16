import { formatValue, thresholdLevel, type Thresholds, type ValueLevel } from "../home/value";
import { seriesPath, type SeriesPoint } from "../home/widgets/primitives/series";
import { useHealthContext } from "./HealthContext";
import {
  HEALTH_LEVEL_NAMES,
  componentOf,
  healthVerdict,
  levelClass,
  selectStatuses,
  temperatureWhere,
  metricUnit,
  statusCurrent,
  reporterCurrent,
  sampleAgeMs,
  type HealthService,
  type HealthStatus,

} from "./types";

export interface Measurement {
  status: HealthStatus; component: string; key: string; where: string; value: number; unit: string;
}

const TREND_W = 90;
const TREND_H = 20;
/** A trend line autoscaled to its own data turns 0.1 °C of sensor noise into a full-height
 *  sawtooth. Never draw less than this many °C top to bottom. */
const MIN_TREND_SPAN_C = 2;

export interface HealthViewOptions {
  /** Only these components (`camera`, `stream`, `recording`, …); omit = all. */
  components?: readonly string[];
  /** false = temperatures plus whatever is not OK; true = every status with all its values. */
  details?: boolean;
  /** Colors each temperature (the shared warn/err quartet). The producer's own limits
   *  (`health.limits` in the sensor config) arrive as the status level + message instead. */
  thresholds?: Thresholds;
  /** Trend window in seconds; 0 = no trend line. */
  historyS?: number;
  precision?: number;
}

function trendRange(points: readonly SeriesPoint[], minSpan: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  const pad = Math.max(0, minSpan - (max - min)) / 2;
  return [min - pad, max + pad];
}

function hasThresholds(t: Thresholds): boolean {
  return t.warn_below !== undefined || t.warn_above !== undefined || t.err_below !== undefined || t.err_above !== undefined;
}

/** A temperature's color: the widget's thresholds when it has any, dimmed when not current. */
function temperatureLevel(celsius: number, thresholds: Thresholds, current: boolean): ValueLevel {
  if (!current) return "idle";
  return hasThresholds(thresholds) ? thresholdLevel(thresholds, celsius) : "ok";
}

/** The row label: where the reading is taken; the component too when it is not the camera's (a
 *  future host-side `temp.*_c` must not read as the camera's). */
export function temperatureLabel(t: Measurement): string {
  if (t.key.startsWith("supply.")) return `input ${t.where}`;
  if (t.component === "temperature") return `${t.where} temperature`;
  return t.component === "camera" ? t.where : `${t.component} ${t.where}`;
}

export function useTrend(service: HealthService, t: Measurement, historyS: number, nowMs: number) {
  const { series } = useHealthContext();
  if (historyS <= 0) return null;
  const cutoff = nowMs - historyS * 1000;
  const points = series(service.key, t.status.name, t.key).filter((p) => p.t >= cutoff);
  if (points.length < 2) return null;
  const [min, max] = trendRange(points, t.unit === "°C" ? MIN_TREND_SPAN_C : t.unit === "A" ? 0.1 : 1);
  const path = seriesPath(points, TREND_W, TREND_H, min, max);
  if (!path) return null;
  const values = points.map((p) => p.v);
  return { d: path.d, low: Math.min(...values), high: Math.max(...values) };
}

function MeasurementRow({
  service,
  temperature,
  label,
  options,
  current,
  nowMs,
  pill,
}: {
  service: HealthService;
  temperature: Measurement;
  label: string;
  options: HealthViewOptions;
  current: boolean;
  nowMs: number;
  pill?: { level: ValueLevel; text: string };
}) {
  const historyS = options.historyS ?? 300;
  const precision = options.precision ?? 1;
  const trend = useTrend(service, temperature, historyS, nowMs);
  const level = temperatureLevel(temperature.value, temperature.unit === "°C" ? options.thresholds ?? {} : {}, current);
  const range = trend ? ` · ${formatValue(trend.low, precision)} … ${formatValue(trend.high, precision)} ${temperature.unit} over ${historyS} s` : "";
  return (
    <div className="panel-row" title={`${temperature.status.name} · ${temperature.key}${range}`}>
      <span className="row-label">{label}</span>
      {trend && (
        <span className="sparkline-row">
          <svg className={`sparkline-svg ${level}`} viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" aria-hidden>
            <path d={trend.d} fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
      )}
      {pill && <span className={`pill ${pill.level}`}>{pill.text}</span>}
      <span className={`row-value ${level}`}>
        {formatValue(temperature.value, precision)}
        <small> {temperature.unit}</small>
      </span>
    </div>
  );
}

/** Everything a status carries besides its temperatures, as a key/value list. */
function displayValues(status: HealthStatus) {
  return Object.entries(status.values).filter(([k]) => metricUnit(k) === null && !k.startsWith("health.") && k !== "alerts.log" && k !== "alerts.epoch");
}

function StatusValues({ status }: { status: HealthStatus }) {
  const rest = displayValues(status);
  if (rest.length === 0) return null;
  return (
    <dl className="health-values mono">
      {rest.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v === null ? "—" : formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One instance's health: a verdict pill (offline / silent / the worst level in view), every
 * `temp.<where>_c` as a row with its trend, and one line per status that is not OK — or, with
 * `details`, every status with all its values. `compact` renders panel rows: one per temperature.
 */
export function HealthInstance({
  service,
  title,
  options = {},
  nowMs,
  compact = false,
  connected = true,
}: {
  service: HealthService;
  title?: string;
  options?: HealthViewOptions;
  nowMs: number;
  compact?: boolean;
  connected?: boolean;
}) {
  const statuses = selectStatuses(service.snapshot, options.components);
  const verdict = healthVerdict(service, statuses, nowMs);
  const reporting = connected && reporterCurrent(service, nowMs);
  const temps: Measurement[] = statuses.flatMap((status) => Object.entries(status.values).flatMap(([key, value]) => {
    const unit = metricUnit(key);
    return unit && typeof value === "number" ? [{ status, component: componentOf(status, service.instance), key,
      where: temperatureWhere(key) ?? key.replace("supply.", "").replace(/_[vaw]+$/, ""), value, unit }] : [];
  }));
  const unavailable = statuses.flatMap((s) => Object.entries(s.values).filter(([key, value]) => metricUnit(key) !== null && value === null)
    .map(([key]) => <div key={`${s.name}/${key}`} className="panel-row"><span className="row-label">{key}</span>
      <span className="row-value idle">{String(s.values[`health.metric.${key}.state`] ?? "unavailable")}</span></div>));
  const name = title ?? service.instance;

  if (compact) {
    const pill = verdict.level === "ok" ? undefined : verdict;
    if (temps.length === 0) {
      return (
        <div className="panel-row" title={service.key}>
          <span className="row-label">{name}</span>
          <span className={`pill ${verdict.level}`}>{verdict.text}</span>
        </div>
      );
    }
    return (
      <>
        {temps.map((t) => (
          <MeasurementRow
            key={`${t.status.name}\n${t.key}`}
            service={service}
            temperature={t}
            label={`${name} ${temperatureLabel(t)}`}
            options={options}
            current={reporting && statusCurrent(service, t.status, nowMs)}
            nowMs={nowMs}
            pill={pill}
          />
        ))}
      </>
    );
  }

  const hardware = statuses.find((s) => s.hardware_id)?.hardware_id;
  const noted = options.details ? statuses : statuses.filter((s) => s.level !== 0 || s.values["alert.active"] === true || !statusCurrent(service, s, nowMs));
  return (
    <div className="health-instance" data-instance={service.instance}>
      <div className="health-head" title={service.key}>
        <span className="health-name">{name}</span>
        <span className={`pill ${!connected && verdict.level === "ok" ? "idle" : verdict.level}`}>{!connected ? `last known ${verdict.text}` : verdict.text}</span>
      </div>
      <span className="dim mono widget-sub">{service.vehicleId} · {service.sourceLabel ?? "Zenoh JSON"}</span>
      {hardware && <span className="dim mono health-hardware">{hardware}</span>}
      {temps.length > 0 ? (
        <div className="panel-rows">
          {temps.map((t) => (
            <MeasurementRow
              key={`${t.status.name}\n${t.key}`}
              service={service}
              temperature={t}
              label={temperatureLabel(t)}
              options={options}
              current={reporting && statusCurrent(service, t.status, nowMs)}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : (
        // Said only in the temperature view: a source with no device to ask (pcap, shm, ROS, RTSP)
        // has nothing to list, and an empty block would read as a fault.
        !options.details && <span className="dim widget-sub">no temperature reported</span>
      )}
      {unavailable}
      {noted.map((s) => (
        <div key={s.name} className="health-status">
          {/* Retain the last known fault severity even when observations become stale. */}
          <span className={`health-note ${levelClass(s.level === 3 && s.values["health.last_level"] === 2 ? 2 : s.level)}`}>
            <strong>{componentOf(s, service.instance)}</strong> {HEALTH_LEVEL_NAMES[s.level]}
            {s.message && s.message !== HEALTH_LEVEL_NAMES[s.level] ? ` · ${s.message}` : ""}
          </span>
          {s.values["health.error"] && <span className="health-note warn">Observation failed: {String(s.values["health.error"])}</span>}
          {options.details && <><span className="dim mono widget-sub">sample {Math.floor(sampleAgeMs(service, s, nowMs) / 1000)}s old · {String(!statusCurrent(service, s, nowMs) && !["paused", "unsupported"].includes(String(s.values["health.availability"])) ? "stale" : s.values["health.availability"] ?? "current")}</span>{displayValues(s).length > 0 && <details><summary className="dim">Values</summary><StatusValues status={s} /></details>}</>}
        </div>
      ))}
    </div>
  );
}
