// The playback control plane — camera-service docs/PLAYBACK.md is the source of truth:
//
//   fleet/<vehicle_id>/svc/<instance>/playback           liveliness token + queryable → descriptor
//   fleet/<vehicle_id>/svc/<instance>/playback/control   queryable: {op, speed?, loop?} → reply
//   fleet/<vehicle_id>/svc/<instance>/playback/state     publisher: every change + ~1 Hz while playing
//
// Playback is a CAPABILITY, not a label: only a producer with playback to control (a finite
// source) declares these keys; a live camera never does. The dashboard shows playback controls
// iff the token is live — never by inference from the media descriptor's `source`. <instance> is
// the same segment the media and lifecycle keys use, so a feed, its recorder and its playback
// line up by name.

export const PLAYBACK_PATTERN = "fleet/*/svc/*/playback";
export const PLAYBACK_STATE_PATTERN = "fleet/*/svc/*/playback/state";

export type PlaybackOp = "pause" | "resume" | "set_speed" | "set_loop" | "restart";

export interface PlaybackDescriptor {
  schema_version: number;
  service: string;
  instance: string; // MUST equal the key's <instance> segment
  source: string; // pcap | replay | …
  state: string; // playing | paused | finished
  controls: string[]; // what `control` accepts RIGHT NOW
  speed?: number; // pacing multiplier; 0 = as fast as the pipeline drains
  loop?: boolean;
  cycle?: number;
  position_s?: number; // into the current cycle, by the data's own timestamps
  duration_s?: number | null; // one cycle; null when not known up front
  frames?: number;
  since_unix_s?: number;
  last_error?: string | null;
}

export interface PlaybackService {
  key: string; // fleet/<vehicle>/svc/<instance>/playback
  vehicleId: string;
  instance: string;
  descriptor: PlaybackDescriptor;
  /** false = liveliness token dropped; held for a grace period (producer restarts re-advertise). */
  alive: boolean;
}

/** `fleet/<vehicle>/svc/<instance>/playback` → its segments, or null for anything else. */
export function parsePlaybackKey(key: string): { vehicleId: string; instance: string } | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "fleet" || parts[2] !== "svc" || parts[4] !== "playback") return null;
  if (parts[1] === "" || parts[3] === "") return null;
  return { vehicleId: parts[1], instance: parts[3] };
}

/** Parse + validate a descriptor payload (queryable reply or `state` publication). null = malformed. */
export function parsePlaybackDescriptor(bytes: Uint8Array): PlaybackDescriptor | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const d = obj as Record<string, unknown>;
    if (typeof d.schema_version !== "number") return null;
    for (const f of ["service", "instance", "source", "state"]) if (typeof d[f] !== "string") return null;
    if (!Array.isArray(d.controls) || !d.controls.every((c) => typeof c === "string")) return null;
    return d as unknown as PlaybackDescriptor;
  } catch {
    return null;
  }
}

/** The speed presets a viewer cycles through; "max" is the contract's 0 (as fast as it drains). */
export const SPEED_PRESETS: readonly number[] = [0.25, 0.5, 1, 2, 4, 0];

export function speedText(speed: number | undefined): string {
  if (speed === undefined) return "";
  return speed === 0 ? "max" : `×${speed}`;
}

/** "12.4 / 4.0 s" (or "12.4 s" when the length isn't known). */
export function positionText(d: PlaybackDescriptor): string {
  const pos = d.position_s ?? 0;
  return d.duration_s ? `${pos.toFixed(1)} / ${d.duration_s.toFixed(1)} s` : `${pos.toFixed(1)} s`;
}
