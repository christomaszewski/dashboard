// Time-series history + SVG path scaling for the `sparkline` widget. Pure; unit-tested.

export interface SeriesPoint {
  t: number; // ms (any monotonic clock)
  v: number;
}

/** A bounded, time-windowed sample history. */
export class SeriesBuffer {
  private pts: SeriesPoint[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly maxPoints = 600,
  ) {}

  push(t: number, v: number): void {
    if (!Number.isFinite(v)) return;
    this.pts.push({ t, v });
    if (this.pts.length > this.maxPoints) this.pts.splice(0, this.pts.length - this.maxPoints);
    this.prune(t);
  }

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.pts.length && this.pts[i].t < cutoff) i++;
    if (i > 0) this.pts.splice(0, i);
  }

  get points(): readonly SeriesPoint[] {
    return this.pts;
  }

  get last(): SeriesPoint | undefined {
    return this.pts[this.pts.length - 1];
  }
}

/**
 * A vehicle-kept history (min/max/last buckets) as points to draw: each bucket's spread as a short
 * vertical stroke, so spikes survive the bucketing, clipped to the window and carried on to `now`
 * at the last value (an unchanged value sends no new buckets).
 */
export function historyPoints(
  history: readonly { t: number; min: number; max: number; last: number }[],
  now: number,
  windowMs: number,
): SeriesPoint[] {
  if (history.length === 0) return [];
  const start = now - windowMs;
  let first = 0;
  while (first < history.length - 1 && history[first + 1].t <= start) first += 1;
  const out: SeriesPoint[] = [];
  history.slice(first).forEach((b, i) => {
    const t = i === 0 ? Math.max(b.t, start) : b.t;
    if (b.min === b.max) out.push({ t, v: b.last });
    else if (b.last === b.min) out.push({ t, v: b.max }, { t: t + 1, v: b.min });
    else out.push({ t, v: b.min }, { t: t + 1, v: b.max });
  });
  out.push({ t: now, v: history[history.length - 1].last });
  return out;
}

export interface SeriesPath {
  d: string; // SVG path data
  min: number; // y-range actually used (after overrides / padding)
  max: number;
}

/**
 * Scale points into a width×height box: x over the points' time span, y over [min, max]
 * (autoscaled with a little padding unless overridden). A flat line sits mid-height. null when
 * there is nothing to draw.
 */
export function seriesPath(
  points: readonly SeriesPoint[],
  width: number,
  height: number,
  minOverride?: number,
  maxOverride?: number,
): SeriesPath | null {
  if (points.length === 0) return null;
  let min = minOverride ?? Math.min(...points.map((p) => p.v));
  let max = maxOverride ?? Math.max(...points.map((p) => p.v));
  if (max === min) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  } else if (minOverride === undefined && maxOverride === undefined) {
    const pad = (max - min) * 0.05;
    min -= pad;
    max += pad;
  }
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0;
  const x = (t: number) => (span > 0 ? ((t - t0) / span) * width : width);
  const y = (v: number) => height - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * height;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  return { d, min, max };
}
