export interface HealthOptions { ros_topics?: string[]; ros_domains?: number[]; ros_stale_after_s?: number; }

export function parseHealthOptions(raw: unknown): HealthOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("health must be a mapping");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!["ros_topics", "ros_domains", "ros_stale_after_s"].includes(key)) throw new Error(`unknown health.${key}`);
  if (value.ros_topics !== undefined && (!Array.isArray(value.ros_topics) || !value.ros_topics.every((s) => typeof s === "string" && s.startsWith("/")))) throw new Error("health.ros_topics must be absolute topic names");
  if (value.ros_domains !== undefined && (!Array.isArray(value.ros_domains) || !value.ros_domains.every((n) => Number.isSafeInteger(n) && n >= 0))) throw new Error("health.ros_domains must be nonnegative integers");
  if (value.ros_stale_after_s !== undefined && (typeof value.ros_stale_after_s !== "number" || !Number.isFinite(value.ros_stale_after_s) || value.ros_stale_after_s <= 0)) throw new Error("health.ros_stale_after_s must be positive and finite");
  return value as HealthOptions;
}
