// The service-lifecycle control plane (camera-service docs/LIFECYCLE.md is the source of truth —
// the contract agreed for the zenoh control plane, §2.1 of its implementation plan):
//
//   fleet/<vehicle_id>/svc/<instance>/lifecycle               liveliness token + queryable → descriptor
//   fleet/<vehicle_id>/svc/<instance>/lifecycle/change_state  queryable: {transition, run_id?} → reply
//   fleet/<vehicle_id>/svc/<instance>/lifecycle/state         publisher: the descriptor on every transition
//
// Generic by design: any service (ROS 2 or not) may implement these keys; state/transition names
// mirror ROS 2 lifecycle (inactive/active, activate/deactivate). <instance> is the same segment the
// media key uses (CAM_INSTANCE), so a camera's stream and its recorder control line up by name.

export const LIFECYCLE_PATTERN = "fleet/*/svc/*/lifecycle";
export const LIFECYCLE_STATE_PATTERN = "fleet/*/svc/*/lifecycle/state";

export interface LifecycleRecording {
  prefix?: string;
  output_dir?: string;
  encoder?: string;
  segment_seconds?: number;
  frames?: number;
  started_unix_s?: number;
}

export interface LifecycleDescriptor {
  schema_version: number;
  service: string; // e.g. "camera-service"
  instance: string;
  state: string; // inactive | active | activating | deactivating (mirrors ROS 2 lifecycle)
  transitions: string[]; // accepted NOW (e.g. ["activate"] while inactive)
  since_unix_s?: number;
  boot_reason?: string; // config | derived | resumed
  recording?: LifecycleRecording; // present while active
  health?: Record<string, unknown> & { stalled?: boolean };
  last_error?: string | null;
}

export interface LifecycleService {
  key: string; // fleet/<vehicle>/svc/<instance>/lifecycle
  vehicleId: string;
  instance: string;
  descriptor: LifecycleDescriptor;
  /** false = liveliness token dropped; held for a grace period (crash restarts re-advertise). */
  alive: boolean;
}

/** `fleet/<vehicle>/svc/<instance>/lifecycle` → its segments, or null for anything else. */
export function parseLifecycleKey(key: string): { vehicleId: string; instance: string } | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "fleet" || parts[2] !== "svc" || parts[4] !== "lifecycle") return null;
  if (parts[1] === "" || parts[3] === "") return null;
  return { vehicleId: parts[1], instance: parts[3] };
}

/** Parse + validate a descriptor payload (queryable reply or `state` publication). null = malformed. */
export function parseLifecycleDescriptor(bytes: Uint8Array): LifecycleDescriptor | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const d = obj as Record<string, unknown>;
    if (typeof d.schema_version !== "number") return null;
    if (typeof d.service !== "string" || typeof d.instance !== "string" || typeof d.state !== "string") return null;
    if (!Array.isArray(d.transitions) || !d.transitions.every((t) => typeof t === "string")) return null;
    return d as unknown as LifecycleDescriptor;
  } catch {
    return null;
  }
}
