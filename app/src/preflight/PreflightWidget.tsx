import { HealthTooltip } from "../health/HealthTooltip";
import { useHealthContext } from "../health/HealthContext";
import { useNow } from "../health/useHealth";
import { serviceQuery, useScopedGraph } from "../ros/useLivelinessGraph";
import { useTransportContext } from "../transport/TransportContext";
import { useTabActive } from "../shell/TabActivity";
import type { HealthService } from "../health/types";
import type { PreflightCheck, PreflightWidgetConfig } from "./spec";
import { cameraRecordingStatus, disconnected, healthStatus, matchingHealth, problem, rosServiceStatus, type CheckStatus } from "./status";
import { useRecorderStatus } from "./useRecorderStatus";
import { recordingChecks } from "./recording";
import { RecordingControls } from "./RecordingControls";
import "./preflight.css";

function Dot({ label, source, result }: { label: string; source: string; result: CheckStatus }) {
  return <span role="listitem" className="preflight-item" data-level={result.level}>
    <HealthTooltip className={`preflight-check ${result.level}`} label={`${label}: ${result.summary}`} detail={<>
      <strong>{label} · {result.summary}</strong>
      <span className="health-tooltip-source">{source}</span>
      <ul className="preflight-details">{result.details.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </>}>
      <span className="preflight-dot" aria-hidden="true" />
      <span className="preflight-name">{label}</span>
    </HealthTooltip>
  </span>;
}

function BagCheck({ check, pollS, now }: { check: Extract<PreflightCheck, { type: "bag_recording" }>; pollS: number; now: number }) {
  const active = useTabActive();
  const result = useRecorderStatus(check.recorder, check.domain_id, pollS, active, now);
  return <Dot label={check.label ?? check.recorder} source={`${check.recorder}${check.domain_id === undefined ? "" : ` · ROS domain ${check.domain_id}`}`} result={result} />;
}

function HealthCheck({ check, services, now, connected }: {
  check: Extract<PreflightCheck, { type: "health" | "camera_recording" }>;
  services: HealthService[]; now: number; connected: boolean;
}) {
  const matches = check.service ? matchingHealth(services, check.service) : services;
  if (check.service && matches.length > 1) return <Dot label={check.label ?? check.service} source={check.service}
    result={connected ? problem("Ambiguous health service", "Use vehicle/instance or the full health key to select one reporter.") : disconnected()} />;
  if (!matches.length) return <Dot label={check.label ?? check.service ?? "Health"} source={check.service ?? "Health discovery"}
    result={connected ? problem("No health report", check.service
      ? "No health reporter matches this reference. Check the instance name and whether the service is publishing diagnostics."
      : "No health reporters discovered. Configure expected service names to keep required services visible before their first report.") : disconnected()} />;
  return <>{matches.map((s) => <Dot key={s.key}
    label={check.label ?? (check.service ? s.instance : `${s.vehicleId}/${s.instance}`)} source={`${s.sourceLabel ?? "Health"} · ${s.key}`}
    result={!connected ? disconnected() : check.type === "camera_recording" ? cameraRecordingStatus(s, now) : healthStatus(s, check.components, now)} />)}</>;
}

/** Opt-in, full-width by default. Group order and check order are exactly the YAML order. */
export function PreflightWidget({ widget }: { widget: PreflightWidgetConfig }) {
  const { services } = useHealthContext();
  const graph = useScopedGraph(widget.groups.flatMap((g) => g.checks).flatMap((c) => (c.type === "ros_service" ? [serviceQuery(c.service)] : [])));
  const { status } = useTransportContext();
  const connected = status === "connected";
  const now = useNow();
  const checks = recordingChecks(widget.groups);
  return <div className={`preflight-strip preflight-${widget.display}`} role="region" aria-label={widget.label ?? "Preflight"}>
    {widget.label && <span className="preflight-title">{widget.label}</span>}
    {widget.groups.map((group, i) => <div className="preflight-group" role="group" aria-label={group.label} key={i}>
      <span className="preflight-group-label">{group.label}</span>
      <div className="preflight-checks" role="list" aria-label={`${group.label} checks`}>
        {group.checks.map((check, j) => check.type === "bag_recording"
          ? <BagCheck key={j} check={check} pollS={widget.poll_s} now={now} />
          : check.type === "ros_service"
            ? <Dot key={j} label={check.label ?? check.service} source={`${check.service}${check.domain_id === undefined ? "" : ` · ROS domain ${check.domain_id}`}`}
              result={connected ? rosServiceStatus(graph, check.service, check.domain_id) : disconnected()} />
            : <HealthCheck key={j} check={check} services={services} now={now} connected={connected} />)}
      </div>
    </div>)}
    {widget.recording_controls && <RecordingControls key={JSON.stringify(checks)} checks={checks} />}
  </div>;
}
