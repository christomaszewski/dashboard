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
  temperatures,
  type HealthService,
  type HealthStatus,
  type HealthTemperature,
} from "./types";

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

function trendRange(points: readonly SeriesPoint[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  const pad = Math.max(0, MIN_TREND_SPAN_C - (max - min)) / 2;
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
function temperatureLabel(t: HealthTemperature): string {
  return t.component === "camera" ? t.where : `${t.component} ${t.where}`;
}

function useTrend(service: HealthService, t: HealthTemperature, historyS: number, nowMs: number) {
  const { series } = useHealthContext();
  if (historyS <= 0) return null;
  const cutoff = nowMs - historyS * 1000;
  const points = series(service.key, t.status.name, t.key).filter((p) => p.t >= cutoff);
  if (points.length < 2) return null;
  const [min, max] = trendRange(points);
  const path = seriesPath(points, TREND_W, TREND_H, min, max);
  if (!path) return null;
  const values = points.map((p) => p.v);
  return { d: path.d, low: Math.min(...values), high: Math.max(...values) };
}

function TemperatureRow({
  service,
  temperature,
  label,
  options,
  current,
  nowMs,
  pill,
}: {
  service: HealthService;
  temperature: HealthTemperature;
  label: string;
  options: HealthViewOptions;
  current: boolean;
  nowMs: number;
  pill?: { level: ValueLevel; text: string };
}) {
  const historyS = options.historyS ?? 300;
  const precision = options.precision ?? 1;
  const trend = useTrend(service, temperature, historyS, nowMs);
  const level = temperatureLevel(temperature.celsius, options.thresholds ?? {}, current);
  const range = trend ? ` · ${formatValue(trend.low, precision)} … ${formatValue(trend.high, precision)} °C over ${historyS} s` : "";
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
        {formatValue(temperature.celsius, precision)}
        <small> °C</small>
      </span>
    </div>
  );
}

/** Everything a status carries besides its temperatures, as a key/value list. */
function StatusValues({ status }: { status: HealthStatus }) {
  const rest = Object.entries(status.values).filter(([k]) => temperatureWhere(k) === null);
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
}: {
  service: HealthService;
  title?: string;
  options?: HealthViewOptions;
  nowMs: number;
  compact?: boolean;
}) {
  const statuses = selectStatuses(service.snapshot, options.components);
  const verdict = healthVerdict(service, statuses, nowMs);
  const temps = temperatures(statuses, service.instance);
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
          <TemperatureRow
            key={`${t.status.name}\n${t.key}`}
            service={service}
            temperature={t}
            label={`${name} ${temperatureLabel(t)}`}
            options={options}
            current={verdict.current}
            nowMs={nowMs}
            pill={pill}
          />
        ))}
      </>
    );
  }

  const hardware = statuses.find((s) => s.hardware_id)?.hardware_id;
  const noted = options.details ? statuses : statuses.filter((s) => s.level !== 0);
  return (
    <div className="health-instance" data-instance={service.instance}>
      <div className="health-head" title={service.key}>
        <span className="health-name">{name}</span>
        <span className={`pill ${verdict.level}`}>{verdict.text}</span>
      </div>
      {hardware && <span className="dim mono health-hardware">{hardware}</span>}
      {temps.length > 0 ? (
        <div className="panel-rows">
          {temps.map((t) => (
            <TemperatureRow
              key={`${t.status.name}\n${t.key}`}
              service={service}
              temperature={t}
              label={temperatureLabel(t)}
              options={options}
              current={verdict.current}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : (
        // Said only in the temperature view: a source with no device to ask (pcap, shm, ROS, RTSP)
        // has nothing to list, and an empty block would read as a fault.
        !options.details && <span className="dim widget-sub">no temperature reported</span>
      )}
      {noted.map((s) => (
        <div key={s.name} className="health-status">
          {/* Last-known words lose their alarm color with the readings: nothing here is current. */}
          <span className={`health-note ${verdict.current ? levelClass(s.level) : "idle"}`}>
            <strong>{componentOf(s, service.instance)}</strong> {HEALTH_LEVEL_NAMES[s.level]}
            {s.message && s.message !== HEALTH_LEVEL_NAMES[s.level] ? ` · ${s.message}` : ""}
          </span>
          {options.details && <StatusValues status={s} />}
        </div>
      ))}
    </div>
  );
}
