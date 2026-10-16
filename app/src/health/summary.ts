import { componentOf, levelClass, sampleAgeMs, reporterCurrent, statusCurrent, type HealthService, type HealthStatus } from "./types";

export interface HealthIssue {
  status: HealthStatus;
  label: string;
  severity: string;
  color: "ok" | "warn" | "err" | "idle" | "info";
}

/** Keep fault severity separate from observation quality; stale ERROR must stay red. */
export function healthIssues(service: HealthService, statuses: readonly HealthStatus[], nowMs: number): HealthIssue[] {
  const reporting = reporterCurrent(service, nowMs);
  const activeAlerts = statuses.filter((s) => s.values["alert.active"] === true);
  return statuses.flatMap((s): HealthIssue[] => {
    const v = s.values;
    const intentional = ["paused", "unsupported"].includes(String(v["health.availability"]));
    const stale = !intentional && !statusCurrent(service, s, nowMs);
    const last = s.level === 3 ? v["health.last_level"] : s.level;
    const fault = last === 1 || last === 2;
    const unavailable = Object.entries(v).some(([k, val]) => k.startsWith("health.metric.") && k.endsWith(".state") && val === "unavailable");
    const failed = Boolean(v["health.error"]) || unavailable;
    const active = v["alert.active"] === true;
    const historyGap = v["alerts.history_gap"] === true;
    if (!fault && !active && !failed && !historyGap && !(reporting && stale)) return [];
    // The alert summary repeats the per-code faults. Keep it if there is an additional problem,
    // incomplete history, stale data, or an active count not explained by the detailed alerts.
    if (!stale && !failed && !v["alerts.history_gap"] && typeof v["alerts.active"] === "number" &&
      v["alerts.active"] > 0 && v["alerts.active"] === activeAlerts.length &&
      activeAlerts.some((a) => a.level >= s.level)) return [];
    const severity = last === 2 ? "ERROR" : last === 1 || failed ? "WARN" : stale ? "STALE" : active || historyGap ? "INFO" : "STALE";
    return [{ status: s, label: historyGap && !fault && !failed ? "alert history gap" : String(v["alert.code"] ?? componentOf(s, service.instance)), severity,
      color: severity === "INFO" ? "info" : severity === "WARN" ? "warn" : fault ? levelClass(last) : "idle" }];
  });
}

export function observationText(service: HealthService, status: HealthStatus, nowMs: number, connected = true): string {
  const age = Math.floor(sampleAgeMs(service, status, nowMs) / 1000);
  const quality = !connected ? "Updates disconnected · last known" : !service.alive ? "Offline · last known" :
    !reporterCurrent(service, nowMs) ? "Reporter silent · last known" :
    statusCurrent(service, status, nowMs) ? String(status.values["health.availability"] ?? "current") :
    ["paused", "unsupported", "unavailable"].includes(String(status.values["health.availability"]))
      ? String(status.values["health.availability"]) : "Stale · last known";
  return `${quality} · sample ${age}s old`;
}
