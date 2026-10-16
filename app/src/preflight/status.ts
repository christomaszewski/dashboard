import { componentOf, reporterCurrent, selectStatuses, statusCurrent, type HealthService } from "../health/types";
import { healthIssues, observationText } from "../health/summary";
import type { RosGraph } from "../ros/graph";
import { discoverRecorders } from "../home/widgets/BagRecordersWidget";

export interface CheckStatus { level: "ok" | "warn" | "err"; summary: string; details: string[] }
export const disconnected = (): CheckStatus => ({ level: "err", summary: "Dashboard disconnected", details: ["Live status cannot be verified until the connection returns."] });
export const problem = (summary: string, ...details: string[]): CheckStatus => ({ level: "err", summary, details });

/** Never silently choose another vehicle's similarly named service. Full health keys also work. */
export function matchingHealth(services: readonly HealthService[], ref: string): HealthService[] {
  return services.filter((s) => ref === s.key || ref === `${s.vehicleId}/${s.instance}` || ref === s.instance);
}

export function healthStatus(service: HealthService, components: string[] | undefined, now: number): CheckStatus {
  const rows = selectStatuses(service.snapshot, components);
  const details = rows.map((s) => {
    const missingMetrics = Object.entries(s.values).filter(([k, v]) => k.startsWith("health.metric.") && k.endsWith(".state") && v === "unavailable")
      .map(([k]) => `${k.slice("health.metric.".length, -".state".length)} unavailable`);
    const notes = [s.message, s.values["health.error"], ...missingMetrics].filter(Boolean).join(" · ");
    return `${componentOf(s, service.instance)}: ${notes} (${observationText(service, s, now)})`;
  });
  if (!service.alive) return problem("Service offline", ...details);
  if (!reporterCurrent(service, now)) return problem("Health reporter silent", ...details);
  const missing = components?.filter((c) => !rows.some((s) => componentOf(s, service.instance) === c));
  if (!rows.length || missing?.length) return problem("Required diagnostics missing", ...(missing ?? components ?? []), ...details);
  const stale = rows.some((s) => !statusCurrent(service, s, now) &&
    !["paused", "unsupported"].includes(String(s.values["health.availability"])));
  const issues = healthIssues(service, rows, now);
  if (stale) return problem("Diagnostics stale or unavailable", ...details);
  if (issues.some((i) => i.color === "err")) return problem("Diagnostic error", ...details);
  const incomplete = rows.some((s) => ["paused", "unsupported", "retrying"].includes(String(s.values["health.availability"])));
  if (issues.length || incomplete) return { level: "warn", summary: "Needs attention", details };
  return { level: "ok", summary: "Healthy", details };
}

/** Camera health heartbeats carry recording state AND capture progress; lifecycle tokens alone
 * can remain live while a camera hangs. Use the same fresh observations as the Health widget. */
export function cameraRecordingStatus(service: HealthService, now: number): CheckStatus {
  const selected = service.snapshot.status.filter((s) => ["camera", "stream", "recording"].includes(componentOf(s, service.instance)));
  const recording = selected.find((s) => componentOf(s, service.instance) === "recording");
  const base = healthStatus(service, [...new Set(["stream", "recording", ...selected.map((s) => componentOf(s, service.instance))])], now);
  if (base.level === "err" || !recording) return base;
  const enabled = recording.values.enabled;
  if (enabled === false || enabled === "false") return { ...base, level: "warn", summary: "Recording disabled" };
  const state = recording.values.state;
  if (state !== "active") return { ...base, level: "warn", summary: state === "inactive" ? "Camera up, not recording" : `Recording state: ${state || "unknown"}` };
  if (!(Number(recording.values.frames) > 0)) return { ...base, level: "warn", summary: "Waiting for recorded frames" };
  return { ...base, summary: base.level === "warn" ? "Recording, needs attention" : "Recording" };
}

/** Domain filtering must apply to both discovery and calls; the rest of the shared graph stays intact. */
export function scopedGraph(graph: RosGraph, domain?: number): RosGraph {
  if (domain === undefined) return graph;
  return { ...graph, services: graph.services.map((s) => ({ ...s, servers: s.servers.filter((e) => e.domainId === domain) })) };
}

export function rosServiceStatus(graph: RosGraph, name: string, domain?: number): CheckStatus {
  const servers = scopedGraph(graph, domain).services.filter((s) => s.name === name).flatMap((s) => s.servers);
  if (!servers.length) return problem("Service unavailable", "No server is advertised in the selected ROS domain.");
  if (domain === undefined && new Set(servers.map((s) => s.domainId)).size > 1)
    return problem("Ambiguous ROS domain", "Set domain_id to identify the intended service.");
  return { level: "ok", summary: "Service advertised", details: [
    `${servers.length} server(s) advertised in ROS domain ${servers[0].domainId}.`,
    "Availability only: no service call is made, so response readiness is not verified.",
  ] };
}

export function recorderTarget(graph: RosGraph, recorder: string, domain?: number): { graph: RosGraph; signature: string; error?: CheckStatus } {
  const scoped = scopedGraph(graph, domain);
  const entries = scoped.services.filter((s) => s.name === `${recorder}/is_paused` && s.servers.length);
  const servers = entries.flatMap((s) => s.servers);
  let error: CheckStatus | undefined;
  if (!servers.length) error = problem("Recorder unavailable", "No is_paused server is advertised.");
  else if (servers.length !== 1) error = problem("Ambiguous recorder", "Select one recorder and ROS domain using recorder and domain_id.");
  else if (entries[0].typeName !== "rosbag2_interfaces/srv/IsPaused") error = problem("Unexpected recorder service type", entries[0].typeName);
  else if (!discoverRecorders(scopedGraph(scoped, servers[0].domainId), [recorder]).length)
    error = problem("Recorder unavailable", "Expected rosbag2 recorder services are missing, or this is a bag player.");
  return { graph: scoped, signature: servers.map((s) => s.keyexpr).sort().join("\n"), error };
}
