import { pluckField } from "./pluck";
import type { MapPositionOptions } from "./mapConfig";

export type MapPosition = { lat: number; lon: number };

/**
 * Extract a WGS84 position from a decoded message via dot-paths (NavSatFix defaults:
 * latitude/longitude). Returns null for anything unusable: missing/non-numeric fields, NaN
 * (NavSatFix without a fix), out-of-range values, and exact (0,0) — null island is a no-fix
 * sentinel in practice, never a real vehicle position.
 */
export function extractLatLon(msg: unknown, latField: string, lonField: string): MapPosition | null {
  const toNum = (v: unknown): number =>
    typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : NaN;
  const lat = toNum(pluckField(msg, latField));
  const lon = toNum(pluckField(msg, lonField));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Compass degrees (north=0, clockwise) from the quaternion's projected forward/X axis.
 * ROS ENU yaw=0 points east; NED yaw=0 points north. No TF lookup or IMU integration is implied.
 */
export function extractHeading(msg: unknown, options: MapPositionOptions = {}): number | null {
  const field = options.orientation_field ?? "orientation";
  if (field === "orientation" && pluckField(msg, "orientation_covariance.0") === -1) return null;
  const q = pluckField(msg, field);
  if (!q || typeof q !== "object") return null;
  const components = ["x", "y", "z", "w"].map(k => (q as Record<string, unknown>)[k]);
  if (!components.every(v => typeof v === "number" && Number.isFinite(v))) return null;
  const norm = Math.hypot(...components as number[]);
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  const [x, y, z, w] = (components as number[]).map(v => v / norm);
  const forwardX = 1 - 2 * (y * y + z * z);
  const forwardY = 2 * (x * y + w * z);
  if (Math.hypot(forwardX, forwardY) < 1e-8) return null; // forward axis vertical: no bearing
  const yaw = Math.atan2(forwardY, forwardX) * 180 / Math.PI;
  const bearing = (options.orientation_frame === "ned" ? yaw : 90 - yaw) + (options.heading_offset_deg ?? 0);
  return ((bearing % 360) + 360) % 360;
}
