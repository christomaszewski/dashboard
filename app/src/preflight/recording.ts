import type { HealthService } from "../health/types";
import { changeState } from "../lifecycle/changeState";
import type { LifecycleService } from "../lifecycle/types";
import type { RosGraph } from "../ros/graph";
import { callService } from "../services/callService";
import type { Transport } from "../transport/types";
import type { PreflightCheck, PreflightGroup } from "./spec";
import { matchingHealth, recorderTarget, scopedGraph } from "./status";

export type RecordingCheck = Extract<PreflightCheck, { type: "bag_recording" | "camera_recording" }>;
export type RecordingAction = "start" | "stop";
export interface RecordingResult { kind: "ok" | "error" | "warning"; message: string }
export interface RecordingTarget {
  id: string;
  label: string;
  /** Qualified once resolved, so a retry cannot drift to another vehicle or domain. */
  check: RecordingCheck;
  camera?: LifecycleService;
  graph?: RosGraph;
  error?: string;
}

export function recordingCheckId(check: RecordingCheck): string {
  return check.type === "bag_recording" ? `bag:${check.domain_id ?? "auto"}:${check.recorder}` : `camera:${check.service}`;
}

export function recordingChecks(groups: PreflightGroup[]): RecordingCheck[] {
  const unique = new Map<string, RecordingCheck>();
  for (const check of groups.flatMap(g => g.checks)) {
    if (check.type === "bag_recording" || check.type === "camera_recording") {
      const id = recordingCheckId(check);
      if (!unique.has(id)) unique.set(id, check);
    }
  }
  return [...unique.values()];
}

export function resolveRecordingTarget(check: RecordingCheck, graph: RosGraph, cameras: LifecycleService[], health: HealthService[]): RecordingTarget {
  const target: RecordingTarget = { id: recordingCheckId(check), check, label: check.label ?? (check.type === "bag_recording" ? check.recorder : check.service) };
  if (check.type === "bag_recording") {
    const resolved = recorderTarget(graph, check.recorder, check.domain_id);
    if (resolved.error) return { ...target, error: `${resolved.error.summary}: ${resolved.error.details.join(" ")}` };
    const domain = resolved.graph.services.find(s => s.name === `${check.recorder}/is_paused` && s.servers.length)!.servers[0].domainId;
    const qualified = { ...check, domain_id: domain };
    return { ...target, id: recordingCheckId(qualified), check: qualified, graph: scopedGraph(graph, domain) };
  }
  // Check both discovery surfaces: a lifecycle-only match must not hide another vehicle's health
  // reporter with the same short name (nor may a health-only match pick a different lifecycle).
  const healthIdentities = new Set(matchingHealth(health, check.service).map(s => `${s.vehicleId}/${s.instance}`));
  const matches = cameras.filter(s => check.service === s.instance || check.service === `${s.vehicleId}/${s.instance}` ||
    check.service === `fleet/${s.vehicleId}/svc/${s.instance}/health` || healthIdentities.has(`${s.vehicleId}/${s.instance}`));
  const identities = new Set([
    ...matches.map(s => `${s.vehicleId}/${s.instance}`),
    ...healthIdentities,
  ]);
  if (identities.size > 1 || matches.length > 1)
    return { ...target, error: "Ambiguous camera. Use vehicle/instance or the full health key." };
  const camera = matches[0];
  if (!camera) {
    const identity = [...identities][0];
    const qualified = identity ? { ...check, service: identity } : check;
    return { ...target, id: recordingCheckId(qualified), check: qualified, error: "Camera recording control unavailable." };
  }
  const qualified = { ...check, service: `${camera.vehicleId}/${camera.instance}` };
  const resolved = { ...target, id: recordingCheckId(qualified), check: qualified, camera };
  if (!camera.alive) return { ...resolved, error: "Camera recording control offline." };
  if (camera.descriptor.service !== "camera-service") return { ...resolved, error: "Service does not advertise camera recording control." };
  return resolved;
}

/** Repeated checks/aliases for the same resolved recorder cause only one command. */
export function recordingTargets(checks: RecordingCheck[], graph: RosGraph, cameras: LifecycleService[], health: HealthService[]): RecordingTarget[] {
  const unique = new Map<string, RecordingTarget>();
  for (const check of checks) {
    const target = resolveRecordingTarget(check, graph, cameras, health);
    if (!unique.has(target.id)) unique.set(target.id, target);
  }
  return [...unique.values()];
}

/** Only ordinary recording gates: never bag stop/record, arbitrary lifecycle services, or rig runs. */
export async function commandRecording(target: RecordingTarget, action: RecordingAction, transport: Transport, current: () => boolean): Promise<RecordingResult> {
  const assertCurrent = () => { if (!current()) throw new Error("Connection changed; recording state unknown."); };
  assertCurrent();
  if (target.error) throw new Error(target.error);
  const check = target.check;
  if (check.type === "bag_recording") {
    const graph = target.graph!;
    const leaf = action === "start" ? "resume" : "pause";
    const entries = graph.services.filter(s => s.name === `${check.recorder}/${leaf}` && s.servers.length);
    const servers = entries.flatMap(s => s.servers);
    const expectedType = `rosbag2_interfaces/srv/${action === "start" ? "Resume" : "Pause"}`;
    const statusServer = graph.services.find(s => s.name === `${check.recorder}/is_paused` && s.servers.length)!.servers[0];
    if (servers.length !== 1 || entries[0].typeName !== expectedType ||
      servers[0].zid !== statusServer.zid || servers[0].nid !== statusServer.nid)
      throw new Error(`Expected one ${expectedType} server on the recorder's node in ROS domain ${check.domain_id}.`);
    const opts = { timeoutMs: 5000, domainId: check.domain_id };
    const reply = await callService(transport, graph, `${check.recorder}/${leaf}`, {}, opts);
    assertCurrent();
    if (reply.warning) throw new Error(reply.warning);
    const code = reply.response.return_code;
    if (code !== undefined && code !== 0)
      throw new Error(String(reply.response.error_string || `Recorder refused ${leaf}: return code ${String(code)}`));
    const observed = await callService(transport, graph, `${check.recorder}/is_paused`, {}, { ...opts, timeoutMs: 2000 });
    assertCurrent();
    if (observed.warning) throw new Error(observed.warning);
    if (observed.response.paused !== (action === "stop")) throw new Error(`Recorder did not confirm ${action === "start" ? "recording" : "paused"} state.`);
    return { kind: "ok", message: action === "start" ? "Recording (unpaused)" : "Paused" };
  }
  const camera = target.camera!;
  const transition = action === "start" ? "activate" : "deactivate";
  const desired = action === "start" ? "active" : "inactive";
  if (action === "start" && camera.descriptor.recording_enabled === false) throw new Error("Camera recording disabled by configuration.");
  if (camera.descriptor.state !== desired && !camera.descriptor.transitions.includes(transition))
    throw new Error(`Camera does not currently offer ${transition} (${camera.descriptor.state}).`);
  const reply = await changeState(transport, camera.key, transition, { expected: camera.descriptor.recording_settings });
  assertCurrent();
  if (!reply.ok) throw new Error(reply.error || `Camera refused ${transition}.`);
  if ((reply.state ?? reply.descriptor?.state) !== desired) throw new Error(`Camera did not confirm ${desired} state.`);
  const warning = [reply.error, reply.session?.error, reply.session?.truncated ? "Recording file was truncated." : undefined].filter(Boolean).join(" ");
  if (warning) return { kind: "warning", message: warning };
  return { kind: "ok", message: action === "start" ? "Recording activated" : "Stopped; files finalized" };
}
