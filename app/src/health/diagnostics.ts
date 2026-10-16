import type { TopicEntry } from "../ros/graph";
import { parseStatus, type HealthStatus, type HealthValue } from "./types";

const NUMBER = /^(?:health\.(?:sequence|sample_age_s|publish_interval_s|stale_after_s|last_level)|temp\..+_c|supply\.(?:voltage_v|current_a|power_w)|alerts\.active|alert\.cursor)$/;
const BOOL = new Set(["alert.active", "alerts.history_gap"]);

/** Only contract fields are coerced. Generic ROS KeyValue strings retain their meaning. */
export function diagnosticStatuses(message: Record<string, unknown>): HealthStatus[] {
  if (!Array.isArray(message.status)) return [];
  return message.status.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    if (!Array.isArray(row.values)) return [];
    const values: Record<string, HealthValue> = {};
    for (const pair of row.values) {
      if (!pair || typeof pair.key !== "string" || typeof pair.value !== "string") continue;
      const { key, value } = pair;
      if (NUMBER.test(key)) {
        const number = value.trim() === "" ? NaN : Number(value);
        values[key] = Number.isFinite(number) ? number : null;
      } else if (BOOL.has(key)) values[key] = value === "true" ? true : value === "false" ? false : value;
      else values[key] = value;
    }
    const parsed = parseStatus({ ...row, values });
    return parsed ? [parsed] : [];
  });
}

export function diagnosticIdentity(topic: TopicEntry, status: HealthStatus) {
  const v = status.values;
  const instance = typeof v["health.instance"] === "string" ? v["health.instance"] : status.name;
  const vehicleId = typeof v["health.vehicle_id"] === "string" ? v["health.vehicle_id"] : "";
  const fleet = /^[^/*?#]+$/.test(instance) && /^[^/*?#]+$/.test(vehicleId);
  return {
    key: fleet ? `fleet/${vehicleId}/svc/${instance}/health` : `ros2/${topic.domainId}/${encodeURIComponent(topic.name)}/${encodeURIComponent(instance)}`,
    vehicleId: fleet ? vehicleId : `ROS domain ${topic.domainId}`,
    instance,
    service: typeof v["health.service"] === "string" ? v["health.service"] : "ROS diagnostics",
  };
}
