// The service-lifecycle control plane — camera-service docs/LIFECYCLE.md is the source of truth:
//
//   fleet/<vehicle_id>/svc/<instance>/lifecycle               liveliness token + queryable → descriptor
//   fleet/<vehicle_id>/svc/<instance>/lifecycle/change_state  queryable: {transition, run_id?} → reply
//   fleet/<vehicle_id>/svc/<instance>/lifecycle/state         publisher: the descriptor on every transition
//
// Generic by design: any service (ROS 2 or not) may implement these keys; state/transition names
// mirror ROS 2 lifecycle (inactive/active, activate/deactivate). <instance> is the same segment the
// media key uses (CAM_INSTANCE), so a camera's stream and its recorder control line up by name.
// Only schema_version/service/instance/state/transitions are REQUIRED; the rest is per-service
// (the camera-service fields are typed below, everything else passes through).

export const LIFECYCLE_PATTERN = "fleet/*/svc/*/lifecycle";
export const LIFECYCLE_STATE_PATTERN = "fleet/*/svc/*/lifecycle/state";

/** camera-service: the open recording session (present while active). */
export interface LifecycleRecording {
  index?: number;
  prefix?: string;
  output_dir?: string;
  started_unix_s?: number;
  frames?: number;
  segments?: number; // CLOSED files
  /** The file being written right now (null once finalized): files on disk = segments + (open_fragment ? 1 : 0). */
  open_fragment?: string | null;
  skipped_awaiting_keyframe?: number;
  encoder?: string;
  segment_seconds?: number;
  error?: string | null;
}

/** camera-service: process-lifetime link/drop counters + flags. */
export interface LifecycleHealth {
  frames?: number;
  source_gaps?: number;
  frames_missing?: number;
  enqueue_failures?: number;
  publish_drops?: number;
  pts_rebases?: number;
  stalled?: boolean;
  reconnecting?: boolean;
  [key: string]: unknown;
}

export interface LifecycleDescriptor {
  schema_version: number;
  service: string; // e.g. "camera-service"
  instance: string; // MUST equal the key's <instance> segment
  state: string; // inactive | activating | active | deactivating
  transitions: string[]; // what change_state accepts RIGHT NOW
  since_unix_s?: number;
  boot_reason?: string; // config | derived | resumed
  recording_enabled?: boolean; // camera-service: can it ever be activated
  health?: LifecycleHealth | null;
  recording?: LifecycleRecording;
  last_error?: string | null; // the last refusal / session error, until the next clean transition
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

/** Files a recording session has on disk right now: the closed ones plus the one being written. */
export function recordingFiles(rec: LifecycleRecording | undefined): number | undefined {
  if (!rec || rec.segments === undefined) return undefined;
  return rec.segments + (rec.open_fragment ? 1 : 0);
}
