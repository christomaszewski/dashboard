// The unification rule for per-row controls. A row is driven through ONE of two mechanisms:
//   * the zenoh lifecycle (camera-service): the instance self-advertises
//     fleet/<vid>/svc/<name>/lifecycle — preferred whenever present (reply-on-completion, run label
//     folded into the recording prefix, state published by the service itself);
//   * rig's launcher trio (ouster, jetson-manager…): `rig standby|activate <name>` as agent jobs.
// Plus compose-level `up`/`down` for every enabled row. camera-service instance names equal rig
// row names, so the lifecycle lookup is by row name. Pure — the buttons are rendered elsewhere.
import type { LifecycleService } from "../lifecycle/types";
import type { Level, RigStackRow } from "./types";
import { opStateLevel, stackLevel } from "./types";

export type RowAction =
  | { kind: "lifecycle"; transition: string; service: LifecycleService; primary: boolean }
  | { kind: "rig"; verb: "standby" | "activate" | "up" | "down"; name: string; primary: boolean; disabled?: string };

export interface RowActionOptions {
  /** capabilities.actuate from the agent descriptor. */
  actuate: boolean;
  /** A job is already running (the agent runs one at a time). */
  busy: boolean;
  /** The agent's liveliness token is up. */
  agentAlive: boolean;
}

export function rowActions(row: RigStackRow, lifecycle: LifecycleService | undefined, opts: RowActionOptions): RowAction[] {
  if (!row.enabled) return [];
  const out: RowAction[] = [];
  if (lifecycle) {
    for (const t of lifecycle.descriptor.transitions) {
      out.push({ kind: "lifecycle", transition: t, service: lifecycle, primary: t === "activate" });
    }
  } else if (row.state_verbs && row.state !== "down") {
    const op = row.op_state;
    if (op === "active" || op === "unknown" || op === null) out.push(rig("standby", row, false, opts));
    if (op === "standby" || op === "unknown" || op === null) out.push(rig("activate", row, true, opts));
  }
  if (row.state !== "running") out.push(rig("up", row, out.length === 0, opts));
  if (row.state !== "down") {
    const down = rig("down", row, false, opts);
    if (row.self && !down.disabled) down.disabled = "this row hosts the dashboard — use Stop everything & seal, or a shell";
    out.push(down);
  }
  return out;
}

function rig(verb: "standby" | "activate" | "up" | "down", row: RigStackRow, primary: boolean, opts: RowActionOptions): RowAction & { kind: "rig" } {
  const action: RowAction & { kind: "rig" } = { kind: "rig", verb, name: row.name, primary };
  if (!opts.agentAlive) action.disabled = "rig agent offline";
  else if (!opts.actuate) action.disabled = "actuation disabled (rig_actuate: false)";
  else if (opts.busy) action.disabled = "a job is already running";
  return action;
}

/** The one pill a row shows: the lifecycle state when the service advertises one, else rig's
 *  operational state, else the compose roll-up. */
export function rowPill(row: RigStackRow, lifecycle: LifecycleService | undefined): { text: string; level: Level; title: string } {
  if (lifecycle) {
    const d = lifecycle.descriptor;
    const level: Level = !lifecycle.alive ? "warn" : d.last_error ? "err" : d.state === "active" ? "ok" : d.state === "inactive" ? "idle" : "warn";
    return { text: lifecycle.alive ? d.state : `${d.state} · offline`, level, title: `lifecycle ${lifecycle.key}` };
  }
  if (!row.enabled) return { text: "disabled", level: "idle", title: "enabled: false in vehicle.yaml" };
  if (row.op_state !== null && row.state !== "down") {
    return { text: row.op_state, level: opStateLevel(row.op_state), title: "rig operational state (the launcher's `state` verb)" };
  }
  return { text: row.state, level: stackLevel(row), title: "docker compose roll-up" };
}
