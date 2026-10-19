import { defineWidget, type BaseWidgetConfig } from "../widgets/registry";
import { isObj, type Obj } from "../widgets/parse";

interface CheckBase { label?: string }
export type PreflightCheck =
  | (CheckBase & { type: "health"; service?: string; components?: string[] })
  | (CheckBase & { type: "camera_recording"; service: string })
  | (CheckBase & { type: "bag_recording"; recorder: string; domain_id?: number })
  | (CheckBase & { type: "ros_service"; service: string; domain_id?: number });
export interface PreflightGroup { label: string; checks: PreflightCheck[] }
export interface PreflightWidgetConfig extends BaseWidgetConfig {
  type: "preflight";
  display: "pills" | "dots";
  poll_s: number;
  recording_controls?: boolean;
  groups: PreflightGroup[];
}

function string(raw: Obj, key: string, required = false): string | undefined {
  const value = raw[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`'${key}' must be a non-empty string`);
  return value.trim();
}

function domain(raw: Obj): number | undefined {
  const value = raw.domain_id;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error("'domain_id' must be a non-negative integer");
  return value;
}

function rosName(raw: Obj, key: string): string {
  const value = string(raw, key, true)!;
  if (!/^\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(`'${key}' must be an absolute ROS name, e.g. /bag_logger/rosbag2_recorder`);
  return value;
}

function parseCheck(raw: unknown): PreflightCheck {
  if (!isObj(raw)) throw new Error("check must be a mapping");
  const fields: Record<string, string[]> = {
    health: ["service", "components"], camera_recording: ["service"],
    bag_recording: ["recorder", "domain_id"], ros_service: ["service", "domain_id"],
  };
  const allowed = fields[String(raw.type)];
  if (allowed) {
    const unknown = Object.keys(raw).filter((k) => !["type", "label", ...allowed].includes(k));
    if (unknown.length) throw new Error(`unknown check option(s): ${unknown.join(", ")}`);
  }
  const label = string(raw, "label");
  switch (raw.type) {
    case "health": {
      const components = raw.components;
      if (components !== undefined && (!Array.isArray(components) || !components.length ||
        !components.every((v) => typeof v === "string" && v.trim())))
        throw new Error("'components' must be a non-empty list of component names");
      return { type: raw.type, label, service: string(raw, "service"), components: components as string[] | undefined };
    }
    case "camera_recording": return { type: raw.type, label, service: string(raw, "service", true)! };
    case "bag_recording": return { type: raw.type, label, recorder: rosName(raw, "recorder"), domain_id: domain(raw) };
    case "ros_service": return { type: raw.type, label, service: rosName(raw, "service"), domain_id: domain(raw) };
    default: throw new Error("'type' must be health, camera_recording, bag_recording, or ros_service");
  }
}

defineWidget<PreflightWidgetConfig>({
  type: "preflight", defaultSpan: "full",
  description: "compact grouped readiness checks from health, recording state and ROS service availability",
  label: (w) => w.label ?? "Preflight",
  parse: (raw) => {
    const display = raw.display ?? "pills";
    if (display !== "pills" && display !== "dots") throw new Error("'display' must be pills or dots");
    const poll = raw.poll_s ?? 3;
    if (typeof poll !== "number" || !Number.isFinite(poll) || poll < 0.5)
      throw new Error("'poll_s' must be a finite number of seconds, at least 0.5");
    if (raw.recording_controls !== undefined && typeof raw.recording_controls !== "boolean")
      throw new Error("'recording_controls' must be a boolean");
    const groups = raw.groups ?? [{ label: "Services", checks: [{ type: "health" }] }];
    if (!Array.isArray(groups) || !groups.length) throw new Error("'groups' must be a non-empty list");
    return { label: string(raw, "label"), display, poll_s: poll, recording_controls: raw.recording_controls ?? false,
      groups: groups.map((g, i) => {
        if (!isObj(g)) throw new Error(`groups[${i}] must be a mapping`);
        const label = string(g, "label", true)!;
        if (!Array.isArray(g.checks) || !g.checks.length) throw new Error(`groups[${i}].checks must be a non-empty list`);
        return { label, checks: g.checks.map((c, j) => {
          try { return parseCheck(c); }
          catch (e) { throw new Error(`groups[${i}].checks[${j}]: ${e instanceof Error ? e.message : String(e)}`); }
        }) };
      }),
    };
  },
});
