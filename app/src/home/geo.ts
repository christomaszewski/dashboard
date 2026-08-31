import { pluckField } from "./pluck";

/**
 * Extract a WGS84 position from a decoded message via dot-paths (NavSatFix defaults:
 * latitude/longitude). Returns null for anything unusable: missing/non-numeric fields, NaN
 * (NavSatFix without a fix), out-of-range values, and exact (0,0) — null island is a no-fix
 * sentinel in practice, never a real vehicle position.
 */
export function extractLatLon(msg: unknown, latField: string, lonField: string): { lat: number; lon: number } | null {
  const toNum = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : NaN;
  const lat = toNum(pluckField(msg, latField));
  const lon = toNum(pluckField(msg, lonField));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}
