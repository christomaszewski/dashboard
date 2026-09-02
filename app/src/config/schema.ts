// Pure parse/validate for the instance config YAML's `home:` block (and the flat instance keys the
// browser cares about). No I/O, no React — this is the unit-test surface. Validation is
// per-widget: one malformed widget yields an { ok: false } entry with a positioned message and the
// REST of the home page still renders. Only a structurally unusable block (wrong version, widgets
// not a list) is fatal — and fatal still means "banner + built-in default Home", never a blank page.
import { parse as parseYaml } from "yaml";

export const HOME_SCHEMA_VERSION = 1;

/** Tab ids — the routing/config vocabulary (useHashRoute imports these; order = display order). */
export const TAB_IDS = ["home", "cameras", "ros", "clouds", "debug"] as const;
export type TabId = (typeof TAB_IDS)[number];

/** `tabs:` block — per-tab visibility, everything defaulting to shown. Lenient: non-boolean
 *  values and unknown keys are ignored (forward compat). */
export type TabVisibility = Partial<Record<TabId, boolean>>;

export function parseTabs(value: unknown): TabVisibility | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: TabVisibility = {};
  for (const id of TAB_IDS) if (typeof raw[id] === "boolean") out[id] = raw[id] as boolean;
  return out;
}

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
  area?: string;
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
  area?: string;
}

export interface VideoWidgetConfig {
  type: "video";
  stream: string;
  label?: string;
  span?: WidgetSpan;
  area?: string;
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
  area?: string;
}

export interface MapWidgetConfig {
  type: "map";
  label?: string;
  /** Topic carrying the position (NavSatFix by default: latitude/longitude fields). */
  topic: string;
  lat_field?: string; // dot-paths, for non-NavSatFix sources
  lon_field?: string;
  /** XYZ tile template fetched by the VIEWING BROWSER, or "none". Default: OSM. */
  tiles?: string;
  zoom?: number;
  /** Breadcrumb points kept (0 disables the trail). */
  trail?: number;
  follow?: boolean;
  attribution?: string;
  span?: WidgetSpan;
  area?: string;
}

export interface LifecycleWidgetConfig {
  type: "lifecycle";
  label?: string;
  /** Service instance (`cam0`) or vehicle-qualified (`veh1/cam0`) — fleet/<v>/svc/<instance>/lifecycle. */
  service: string;
  confirm?: boolean; // two-step click before a transition
  run_id?: string; // passed with activate (recording run prefix suffix)
  span?: WidgetSpan;
  area?: string;
}

/** Widget types allowed inside a panel (no video, no map, no nested panels). */
export type PanelItemWidgetConfig =
  | StatusWidgetConfig
  | ServiceButtonWidgetConfig
  | TopicValueWidgetConfig
  | LifecycleWidgetConfig;

export type ParsedPanelItem =
  | { ok: true; item: PanelItemWidgetConfig }
  | { ok: false; index: number; message: string };

export interface PanelWidgetConfig {
  type: "panel";
  title?: string;
  /** Default topic inherited by readout shorthand items (items with `field` and no `type`). */
  topic?: string;
  items: ParsedPanelItem[];
  span?: WidgetSpan;
  area?: string;
}

export type WidgetConfig =
  | StatusWidgetConfig
  | ServiceButtonWidgetConfig
  | VideoWidgetConfig
  | TopicValueWidgetConfig
  | MapWidgetConfig
  | LifecycleWidgetConfig
  | PanelWidgetConfig;

export type ParsedWidget =
  | { ok: true; widget: WidgetConfig; warning?: string } // warning: area problems (widget auto-flows)
  | { ok: false; index: number; message: string };

export interface HomeLayout {
  /** Pass-through grid-template-columns track list (charset-vetted). Absent → synthesized. */
  columns?: string;
  /** Normalized grid-template-areas rows (tokens re-joined with single spaces); CSS-valid. */
  areas?: string[];
  areaNames: string[];
  columnCount: number;
}

export interface ParsedHome {
  title?: string;
  layout?: HomeLayout;
  /** Set whenever anything in home.layout was dropped/adjusted (rendered as one banner). */
  layoutWarning?: string;
  widgets: ParsedWidget[];
  /** Unusable block (bad version / widgets not a list): show a banner + the default Home. */
  fatal?: string;
}

export interface DashboardConfig {
  name?: string;
  web_port?: number;
  ws_port?: number;
  tabs?: TabVisibility;
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

// ---- layout ----------------------------------------------------------------------------------
// Validation here is load-bearing: an invalid grid-template-areas string reaching CSS makes the
// browser drop the whole declaration while widgets still carry `grid-area: name` — which throws
// them into implicit tracks OUTSIDE the grid. So this must be at least as strict as CSS, and the
// renderer must never emit a grid-area this validator didn't bless.

const AREA_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
// Grammar-significant words in `grid-area` / CSS-wide keywords — legal-looking but unusable.
const CSS_RESERVED = new Set(["auto", "span", "none", "inherit", "initial", "unset", "revert", "revert-layer", "default"]);

function parseAreas(
  raw: unknown,
): { ok: true; rows: string[]; names: string[]; columns: number } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((r) => typeof r === "string" && r.trim() !== ""))
    return { ok: false, message: "home.layout.areas must be a list of non-empty strings" };
  const rows = (raw as string[]).map((r) => r.trim().split(/\s+/));
  const width = rows[0].length;
  const cells = new Map<string, [number, number][]>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== width)
      return { ok: false, message: `home.layout.areas is not rectangular: row ${i} has ${rows[i].length} cells, expected ${width}` };
    for (let j = 0; j < rows[i].length; j++) {
      const tok = rows[i][j];
      if (/^\.+$/.test(tok)) continue; // '.', '...' etc. = one empty cell (CSS semantics)
      if (!AREA_NAME_RE.test(tok) || CSS_RESERVED.has(tok.toLowerCase()))
        return {
          ok: false,
          message: `home.layout.areas: invalid area name '${tok}' (letters, digits, '_', '-'; must start with a letter; '.' marks an empty cell)`,
        };
      let list = cells.get(tok);
      if (!list) cells.set(tok, (list = []));
      list.push([i, j]);
    }
  }
  // CSS requires each named area to be one solid rectangle; a hole or foreign name inside the
  // bounding box makes the cell count fall short of the box area.
  for (const [name, list] of cells) {
    const rs = list.map(([r]) => r);
    const cs = list.map(([, c]) => c);
    const h = Math.max(...rs) - Math.min(...rs) + 1;
    const w = Math.max(...cs) - Math.min(...cs) + 1;
    if (list.length !== h * w)
      return { ok: false, message: `home.layout.areas: area '${name}' does not form a solid rectangle` };
  }
  return { ok: true, rows: rows.map((r) => r.join(" ")), names: [...cells.keys()], columns: width };
}

const COLUMNS_CHARSET_RE = /^[A-Za-z0-9\s%().,-]+$/; // fr/px/%/rem/auto/minmax()/repeat()/fit-content()

/** Pure layout validation. `areas` and `columns` fail independently; failures become warnings. */
export function parseLayout(value: unknown): { layout?: HomeLayout; warning?: string } {
  if (!isObj(value)) return { warning: "home.layout must be a mapping" };
  const warnings: string[] = [];
  let areas: string[] | undefined;
  let areaNames: string[] = [];
  let columnCount = 0;

  if (value["areas"] !== undefined) {
    const parsed = parseAreas(value["areas"]);
    if (parsed.ok) {
      areas = parsed.rows;
      areaNames = parsed.names;
      columnCount = parsed.columns;
    } else warnings.push(parsed.message);
  }

  let columns: string | undefined;
  const rawColumns = value["columns"];
  if (rawColumns !== undefined) {
    if (typeof rawColumns !== "string" || rawColumns.trim() === "") warnings.push("home.layout.columns must be a string");
    else if (rawColumns.length > 200) warnings.push("home.layout.columns is too long");
    else if (!COLUMNS_CHARSET_RE.test(rawColumns))
      warnings.push("home.layout.columns has unsupported characters — using equal columns");
    else {
      const trimmed = rawColumns.trim();
      // Track-count cross-check only when trivially countable (no repeat()/minmax() forms).
      const tracks = trimmed.includes("(") ? undefined : trimmed.split(/\s+/).length;
      if (areas && tracks !== undefined && tracks !== columnCount)
        warnings.push(`home.layout.columns has ${tracks} tracks but areas define ${columnCount} columns — using equal columns`);
      else columns = trimmed;
    }
  }

  const layout = areas || columns ? { columns, areas, areaNames, columnCount } : undefined;
  return { layout, warning: warnings.length > 0 ? warnings.join("; ") : undefined };
}

// ---- panel items ------------------------------------------------------------------------------

const PANEL_ITEM_TYPES = "status | service_button | topic_value | lifecycle, or a readout with 'field'";

function parsePanelItem(raw: unknown, index: number, panelTopic: string | undefined): ParsedPanelItem {
  const fail = (message: string): ParsedPanelItem => ({ ok: false, index, message: `items[${index}]: ${message}` });
  if (!isObj(raw)) return fail("item must be a mapping");
  const type = optStr(raw, "type");
  if (type === "panel") return fail("nested panels are not supported");
  if (type === "video") return fail(`'video' is not allowed inside a panel (${PANEL_ITEM_TYPES})`);
  if (type === "status" || type === "service_button" || type === "topic_value" || type === "lifecycle") {
    // Full widget configs are full: a typed topic_value item does NOT inherit the panel topic.
    try {
      return { ok: true, item: parseWidget(raw) as PanelItemWidgetConfig };
    } catch (e) {
      return { ok: false, index, message: `items[${index}] (${type}): ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (type !== undefined) return fail(`unknown item type '${type}' (${PANEL_ITEM_TYPES})`);
  // Readout shorthand: no type → a topic_value row. `name:` is the documented label key.
  const field = optStr(raw, "field");
  if (field === undefined) return fail("needs a 'type' or a readout 'field'");
  const topic = optStr(raw, "topic") ?? panelTopic;
  if (topic === undefined) return fail("'topic' is required (set it on the item or on the panel)");
  return {
    ok: true,
    item: {
      type: "topic_value",
      label: optStr(raw, "name") ?? optStr(raw, "label") ?? field,
      topic,
      field,
      precision: optNum(raw, "precision"),
      unit: optStr(raw, "unit"),
      warn_below: optNum(raw, "warn_below"),
      warn_above: optNum(raw, "warn_above"),
      err_below: optNum(raw, "err_below"),
      err_above: optNum(raw, "err_above"),
    },
  };
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
        area: optStr(raw, "area"),
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
        area: optStr(raw, "area"),
      };
    }
    case "video":
      return {
        type,
        stream: reqStr(raw, "stream"),
        label: optStr(raw, "label"),
        span: optSpan(raw),
        area: optStr(raw, "area"),
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
        area: optStr(raw, "area"),
      };
    case "map": {
      const tiles = optStr(raw, "tiles");
      if (tiles !== undefined && tiles !== "none" && !(tiles.includes("{z}") && tiles.includes("{x}") && tiles.includes("{y}")))
        throw new Error("'tiles' must be an XYZ template containing {z}/{x}/{y}, or 'none'");
      return {
        type,
        label: optStr(raw, "label"),
        topic: reqStr(raw, "topic"),
        lat_field: optStr(raw, "lat_field"),
        lon_field: optStr(raw, "lon_field"),
        tiles,
        zoom: optNum(raw, "zoom"),
        trail: optNum(raw, "trail"),
        follow: optBool(raw, "follow"),
        attribution: optStr(raw, "attribution"),
        span: optSpan(raw),
        area: optStr(raw, "area"),
      };
    }
    case "lifecycle":
      return {
        type,
        label: optStr(raw, "label"),
        service: reqStr(raw, "service"),
        confirm: optBool(raw, "confirm"),
        run_id: optStr(raw, "run_id"),
        span: optSpan(raw),
        area: optStr(raw, "area"),
      };
    case "panel": {
      const rawItems = raw["items"];
      if (!Array.isArray(rawItems)) throw new Error("'items' is required and must be a list");
      if (rawItems.length === 0) throw new Error("'items' must not be empty");
      const panelTopic = optStr(raw, "topic");
      return {
        type,
        title: optStr(raw, "title"),
        topic: panelTopic,
        items: rawItems.map((item, j) => parsePanelItem(item, j, panelTopic)),
        span: optSpan(raw),
        area: optStr(raw, "area"),
      };
    }
    default:
      throw new Error(
        type === undefined
          ? "'type' is required (status | service_button | video | topic_value | map | lifecycle | panel)"
          : `unknown widget type '${type}' (status | service_button | video | topic_value | map | lifecycle | panel)`,
      );
  }
}

export function parseHome(value: unknown): ParsedHome {
  if (!isObj(value)) return { widgets: [], fatal: "home: must be a mapping" };
  const version = value["version"] ?? HOME_SCHEMA_VERSION;
  if (version !== HOME_SCHEMA_VERSION)
    return { widgets: [], fatal: `home.version ${String(version)} is not supported (expected ${HOME_SCHEMA_VERSION})` };

  let layout: HomeLayout | undefined;
  let layoutWarning: string | undefined;
  if (value["layout"] !== undefined) {
    const parsed = parseLayout(value["layout"]);
    layout = parsed.layout;
    layoutWarning = parsed.warning;
  }

  const rawWidgets = value["widgets"];
  if (rawWidgets === undefined) return { title: optStr(value, "title"), layout, layoutWarning, widgets: [] };
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

  // Area post-pass. Invariant afterwards: widget.area set ⇒ valid, unique, defined in the layout —
  // the renderer can emit grid-area unconditionally (see the parseAreas doc comment for why).
  const claimed = new Map<string, number>();
  for (let i = 0; i < widgets.length; i++) {
    const pw = widgets[i];
    if (!pw.ok || pw.widget.area === undefined) continue;
    const a = pw.widget.area;
    const strip = (warning: string) => {
      widgets[i] = { ok: true, widget: { ...pw.widget, area: undefined }, warning };
    };
    if (!layout?.areas) strip(`area '${a}' set but home.layout.areas is not defined — placed automatically`);
    else if (!AREA_NAME_RE.test(a)) strip(`invalid area name '${a}' — placed automatically`);
    else if (!layout.areaNames.includes(a)) strip(`area '${a}' is not defined in home.layout.areas — placed automatically`);
    else if (claimed.has(a)) strip(`area '${a}' is already used by widgets[${claimed.get(a)}] — placed automatically`);
    else claimed.set(a, i);
  }

  return { title: optStr(value, "title"), layout, layoutWarning, widgets };
}

/** Parse the whole instance YAML. Throws only on unparseable YAML (caller maps to the error state). */
export function parseDashboardConfig(yamlText: string): DashboardConfig {
  const doc: unknown = parseYaml(yamlText);
  if (!isObj(doc)) return {};
  return {
    name: optStr(doc, "name"),
    web_port: optNum(doc, "web_port"),
    ws_port: optNum(doc, "ws_port"),
    tabs: doc["tabs"] !== undefined ? parseTabs(doc["tabs"]) : undefined,
    home: doc["home"] !== undefined ? parseHome(doc["home"]) : undefined,
  };
}
