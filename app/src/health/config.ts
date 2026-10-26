import type { RadioOptions } from "./radioLink";

export interface HealthOptions { ros_topics?: string[]; ros_domains?: number[]; ros_stale_after_s?: number; radio?: RadioOptions; }

const RADIO_LISTS: Record<string, number> = { snr_db: 4, signal_dbm: 4, quality_pct: 4, noise_dbm: 2, busy_pct: 2 };

/** `health.radio`: which reporters the header indicator shows, the operator's peer, and thresholds. */
function parseRadioOptions(raw: unknown): RadioOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("health.radio must be a mapping");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!["services", "peer", "header", ...Object.keys(RADIO_LISTS)].includes(key)) throw new Error(`unknown health.radio.${key}`);
  }
  if (value.services !== undefined && (!Array.isArray(value.services) || !value.services.every((s) => typeof s === "string" && s.length > 0))) {
    throw new Error("health.radio.services must be a list of instance or vehicle/instance references");
  }
  if (value.peer !== undefined && (typeof value.peer !== "string" || !value.peer.trim())) throw new Error("health.radio.peer must be a peer address");
  if (value.header !== undefined && typeof value.header !== "boolean") throw new Error("health.radio.header must be true or false");
  for (const [key, n] of Object.entries(RADIO_LISTS)) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length !== n || !list.every((x) => typeof x === "number" && Number.isFinite(x)) ||
      list.some((x, i) => i > 0 && x < list[i - 1])) {
      throw new Error(`health.radio.${key} must be ${n} ascending numbers`);
    }
  }
  return value as RadioOptions;
}

export function parseHealthOptions(raw: unknown): HealthOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("health must be a mapping");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!["ros_topics", "ros_domains", "ros_stale_after_s", "radio"].includes(key)) throw new Error(`unknown health.${key}`);
  if (value.ros_topics !== undefined && (!Array.isArray(value.ros_topics) || !value.ros_topics.every((s) => typeof s === "string" && s.startsWith("/")))) throw new Error("health.ros_topics must be absolute topic names");
  if (value.ros_domains !== undefined && (!Array.isArray(value.ros_domains) || !value.ros_domains.every((n) => Number.isSafeInteger(n) && n >= 0))) throw new Error("health.ros_domains must be nonnegative integers");
  if (value.ros_stale_after_s !== undefined && (typeof value.ros_stale_after_s !== "number" || !Number.isFinite(value.ros_stale_after_s) || value.ros_stale_after_s <= 0)) throw new Error("health.ros_stale_after_s must be positive and finite");
  return { ...(value as HealthOptions), radio: parseRadioOptions(value.radio) };
}
