// Shared readout formatting: threshold coloring + value rendering for topic_value cards and
// panel readout rows.
export interface Thresholds {
  warn_below?: number;
  warn_above?: number;
  err_below?: number;
  err_above?: number;
}

export type ValueLevel = "ok" | "warn" | "err" | "idle";

export function thresholdLevel(t: Thresholds, v: number): ValueLevel {
  if ((t.err_below !== undefined && v < t.err_below) || (t.err_above !== undefined && v > t.err_above)) return "err";
  if ((t.warn_below !== undefined && v < t.warn_below) || (t.warn_above !== undefined && v > t.warn_above)) return "warn";
  return "ok";
}

export function formatValue(v: unknown, precision?: number): string {
  if (typeof v === "number") return precision !== undefined ? v.toFixed(precision) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "bigint" || typeof v === "boolean" || typeof v === "string") return String(v);
  if (v === undefined) return "—";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Level for a plucked value against thresholds: errors dominate, non-numerics can't threshold. */
export function valueLevel(t: Thresholds, value: unknown, error: string): ValueLevel {
  if (error) return "err";
  if (value === undefined) return "idle";
  const num = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
  return num !== undefined ? thresholdLevel(t, num) : "ok";
}
