// Pure parse/validate for the instance config YAML's `home:` block (and the flat instance keys the
// browser cares about). No I/O, no React — this is the unit-test surface. Validation is
// per-widget: one malformed widget yields an { ok: false } entry with a positioned message and the
// REST of the home page still renders. Only a structurally unusable block (wrong version, widgets
// not a list) is fatal — and fatal still means "banner + built-in default Home", never a blank page.
import { parse as parseYaml } from "yaml";

export const HOME_SCHEMA_VERSION = 1;

export type WidgetSpan = 1 | 2 | "full";

export interface StatusWidgetConfig {
  type: "status";
  label: string;
  source: "stream" | "node" | "topic_hz";
  stream?: string; // source: stream — sensor id, descriptor id, or full keyexpr
  node?: string; // source: node — fully-qualified node name
  topic?: string; // source: topic_hz
  min_hz?: number;
  window_s?: number;
  span?: WidgetSpan;
}

export interface ServiceButtonWidgetConfig {
  type: "service_button";
  label: string;
  service: string;
  /** Optional cross-check only — the actual type comes from the live graph's SS token. */
  srv_type?: string;
  request?: Record<string, unknown>;
  confirm?: boolean;
  timeout_s?: number;
  span?: WidgetSpan;
}

export interface VideoWidgetConfig {
  type: "video";
  stream: string;
  label?: string;
  span?: WidgetSpan;
}

export interface TopicValueWidgetConfig {
  type: "topic_value";
  label: string;
  topic: string;
  field: string; // dot-path into the decoded message, numeric segments index arrays
  precision?: number;
  unit?: string;
  warn_below?: number;
  warn_above?: number;
  err_below?: number;
  err_above?: number;
  span?: WidgetSpan;
}

export type WidgetConfig =
  | StatusWidgetConfig
  | ServiceButtonWidgetConfig
  | VideoWidgetConfig
  | TopicValueWidgetConfig;

export type ParsedWidget =
  | { ok: true; widget: WidgetConfig }
  | { ok: false; index: number; message: string };

export interface ParsedHome {
  title?: string;
  widgets: ParsedWidget[];
  /** Unusable block (bad version / widgets not a list): show a banner + the default Home. */
  fatal?: string;
}

export interface DashboardConfig {
  name?: string;
  web_port?: number;
  ws_port?: number;
  home?: ParsedHome;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optStr(o: Obj, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function optNum(o: Obj, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === "boolean" ? v : undefined;
}

function optSpan(o: Obj): WidgetSpan | undefined {
  const v = o["span"];
  return v === 1 || v === 2 || v === "full" ? v : undefined;
}

/** Required string field or a thrown message naming it (caught into the widget's error entry). */
function reqStr(o: Obj, key: string): string {
  const v = optStr(o, key);
  if (v === undefined) throw new Error(`'${key}' is required and must be a non-empty string`);
  return v;
}

function parseWidget(raw: unknown): WidgetConfig {
  if (!isObj(raw)) throw new Error("widget must be a mapping (key: value block)");
  const type = optStr(raw, "type");
  switch (type) {
    case "status": {
      const source = optStr(raw, "source");
      if (source !== "stream" && source !== "node" && source !== "topic_hz")
        throw new Error("'source' must be one of: stream, node, topic_hz");
      const w: StatusWidgetConfig = {
        type,
        label: reqStr(raw, "label"),
        source,
        span: optSpan(raw),
      };
      if (source === "stream") w.stream = reqStr(raw, "stream");
      if (source === "node") w.node = reqStr(raw, "node");
      if (source === "topic_hz") {
        w.topic = reqStr(raw, "topic");
        w.min_hz = optNum(raw, "min_hz");
        w.window_s = optNum(raw, "window_s");
      }
      return w;
    }
    case "service_button": {
      const request = raw["request"];
      if (request !== undefined && !isObj(request)) throw new Error("'request' must be a mapping of field: value");
      return {
        type,
        label: reqStr(raw, "label"),
        service: reqStr(raw, "service"),
        srv_type: optStr(raw, "srv_type"),
        request: request as Obj | undefined,
        confirm: optBool(raw, "confirm"),
        timeout_s: optNum(raw, "timeout_s"),
        span: optSpan(raw),
      };
    }
    case "video":
      return {
        type,
        stream: reqStr(raw, "stream"),
        label: optStr(raw, "label"),
        span: optSpan(raw),
      };
    case "topic_value":
      return {
        type,
        label: reqStr(raw, "label"),
        topic: reqStr(raw, "topic"),
        field: reqStr(raw, "field"),
        precision: optNum(raw, "precision"),
        unit: optStr(raw, "unit"),
        warn_below: optNum(raw, "warn_below"),
        warn_above: optNum(raw, "warn_above"),
        err_below: optNum(raw, "err_below"),
        err_above: optNum(raw, "err_above"),
        span: optSpan(raw),
      };
    default:
      throw new Error(
        type === undefined
          ? "'type' is required (status | service_button | video | topic_value)"
          : `unknown widget type '${type}' (status | service_button | video | topic_value)`,
      );
  }
}

export function parseHome(value: unknown): ParsedHome {
  if (!isObj(value)) return { widgets: [], fatal: "home: must be a mapping" };
  const version = value["version"] ?? HOME_SCHEMA_VERSION;
  if (version !== HOME_SCHEMA_VERSION)
    return { widgets: [], fatal: `home.version ${String(version)} is not supported (expected ${HOME_SCHEMA_VERSION})` };
  const rawWidgets = value["widgets"];
  if (rawWidgets === undefined) return { title: optStr(value, "title"), widgets: [] };
  if (!Array.isArray(rawWidgets)) return { widgets: [], fatal: "home.widgets must be a list" };
  const widgets: ParsedWidget[] = rawWidgets.map((raw, index) => {
    try {
      return { ok: true as const, widget: parseWidget(raw) };
    } catch (e) {
      const type = isObj(raw) ? optStr(raw, "type") : undefined;
      const where = `widgets[${index}]${type ? ` (${type})` : ""}`;
      return { ok: false as const, index, message: `${where}: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  return { title: optStr(value, "title"), widgets };
}

/** Parse the whole instance YAML. Throws only on unparseable YAML (caller maps to the error state). */
export function parseDashboardConfig(yamlText: string): DashboardConfig {
  const doc: unknown = parseYaml(yamlText);
  if (!isObj(doc)) return {};
  return {
    name: optStr(doc, "name"),
    web_port: optNum(doc, "web_port"),
    ws_port: optNum(doc, "ws_port"),
    home: doc["home"] !== undefined ? parseHome(doc["home"]) : undefined,
  };
}
