// Pure parse/validate for the instance config YAML: the flat instance keys the browser cares
// about, `tabs:`, and the `home:` block (layout + widgets). No I/O, no React — this is the
// unit-test surface. Widget TYPES are not known here: each type is a spec in the widget registry
// (widgets/registry.ts) — built-ins from home/widgets/specs.ts, extensions from src/extensions/ —
// and this module looks them up. Validation is per-widget: one malformed widget yields an
// { ok: false } entry with a positioned message and the REST of the home page still renders.
// Only a structurally unusable block (wrong version, widgets not a list) is fatal — and fatal
// still means "banner + built-in default Home", never a blank page.
import { parse as parseYaml } from "yaml";
import { parseReadout } from "../home/widgets/specs";
import { ATTACHMENT_LAYOUTS, type AttachmentLayout } from "../services/attachment";
import { defineWidget, getWidget, panelItemTypes, widgetTypes, type BaseWidgetConfig } from "../widgets/registry";
import { isObj, optNum, optSpan, optStr, type Obj, type WidgetSpan } from "../widgets/parse";
import "../home/widgets/specs"; // registers the built-in widget specs (pure)

export type { WidgetSpan } from "../widgets/parse";
export type {
  StatusWidgetConfig,
  ServiceButtonWidgetConfig,
  VideoWidgetConfig,
  CameraWidgetConfig,
  CamerasWidgetConfig,
  BagRecordersWidgetConfig,
  ServicesWidgetConfig,
  ServiceCallSpec,
  TopicValueWidgetConfig,
  MapWidgetConfig,
  LifecycleWidgetConfig,
  RigWidgetConfig,
} from "../home/widgets/specs";

export const HOME_SCHEMA_VERSION = 1;

/** Tab ids — the routing/config vocabulary (useHashRoute imports these; order = display order). */
export const TAB_IDS = ["home", "cameras", "ros", "rig", "clouds", "debug"] as const;
export type TabId = (typeof TAB_IDS)[number];

/** Visibility when `tabs:` says nothing: Home only. Every other tab is OPT-IN — a deployment lists
 *  the ones it uses and never has to know about the rest to keep them off. `rig_agent: true` (the
 *  same YAML) implies `rig` (the tab is that agent's UI); an explicit `tabs.rig` always wins.
 *  Resolved into `tabs` by parseDashboardConfig; visibleTabs applies it (no-config included). */
export const TAB_DEFAULT_VISIBLE: Record<TabId, boolean> = { home: true, cameras: false, ros: false, rig: false, clouds: false, debug: false };

/** `tabs:` block — per-tab visibility. Two spellings: a LIST of the tabs to show (`[cameras, ros]`;
 *  the common case) or a MAP of booleans (`{ cameras: true, home: false }`; the only way to say
 *  `false`, e.g. to hide Rig despite `rig_agent`). Lenient: unknown ids, non-boolean map values
 *  and non-string list entries are ignored (forward compat). */
export type TabVisibility = Partial<Record<TabId, boolean>>;

export function parseTabs(value: unknown): TabVisibility | undefined {
  const out: TabVisibility = {};
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === "string" && isTabId(v)) out[v] = true;
    return out;
  }
  if (!isObj(value)) return undefined;
  for (const id of TAB_IDS) if (typeof value[id] === "boolean") out[id] = value[id] as boolean;
  return out;
}

function isTabId(v: string): v is TabId {
  return (TAB_IDS as readonly string[]).includes(v);
}

/** The tabs to render, in display order: `tabs:` over TAB_DEFAULT_VISIBLE. Never empty — a config
 *  that switches everything off (`home: false` and nothing else on) still gets Home, so the app
 *  always has a page. */
export function visibleTabs(tabs?: TabVisibility): TabId[] {
  const on = TAB_IDS.filter((id) => (tabs?.[id] ?? TAB_DEFAULT_VISIBLE[id]) !== false);
  return on.length > 0 ? on : ["home"];
}

/** Any registered widget's parsed config. Narrow with the registry / type guards, never a switch. */
export type WidgetConfig = BaseWidgetConfig;
export type PanelItemWidgetConfig = BaseWidgetConfig;

export type ParsedPanelItem =
  | { ok: true; item: PanelItemWidgetConfig }
  | { ok: false; index: number; message: string };

export interface PanelWidgetConfig extends BaseWidgetConfig {
  type: "panel";
  title?: string;
  /** Default topic inherited by readout shorthand items (items with `field` and no `type`). */
  topic?: string;
  items: ParsedPanelItem[];
}

export function isPanelWidget(w: WidgetConfig): w is PanelWidgetConfig {
  return w.type === "panel";
}

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
  /** dash-up starts the vehicle-side rig agent (docs/RIG_AGENT.md); shows the Rig tab by default. */
  rig_agent?: boolean;
  tabs?: TabVisibility;
  home?: ParsedHome;
  /** The rmw_zenoh attachment layout this page SENDS on service calls: `plain` (rmw_zenoh 0.10 /
   *  Lyrical — default) or `labelled` (Jazzy). Must match the vehicle's nodes: a server given the
   *  other layout crashes. Bus debug shows which one live samples carry. */
  rmw_attachment?: AttachmentLayout;
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

// ---- widgets (via the registry) --------------------------------------------------------------

function typeList(): string {
  return widgetTypes().join(" | ");
}

/** Parse one widget mapping through its registered spec; span/area are filled here for every type. */
export function parseWidget(raw: unknown): WidgetConfig {
  if (!isObj(raw)) throw new Error("widget must be a mapping (key: value block)");
  const type = optStr(raw, "type");
  if (type === undefined) throw new Error(`'type' is required (${typeList()})`);
  const def = getWidget(type);
  if (!def) throw new Error(`unknown widget type '${type}' (${typeList()})`);
  const cfg = def.parse(raw) as Partial<WidgetConfig>;
  return { ...cfg, type, span: cfg.span ?? optSpan(raw), area: cfg.area ?? optStr(raw, "area") } as WidgetConfig;
}

function panelItemHint(): string {
  return `${panelItemTypes().join(" | ")}, or a readout with 'field' / 'format'`;
}

function parsePanelItem(raw: unknown, index: number, panelTopic: string | undefined): ParsedPanelItem {
  const fail = (message: string): ParsedPanelItem => ({ ok: false, index, message: `items[${index}]: ${message}` });
  if (!isObj(raw)) return fail("item must be a mapping");
  const type = optStr(raw, "type");
  if (type === "panel") return fail("nested panels are not supported");
  if (type !== undefined) {
    const def = getWidget(type);
    if (!def) return fail(`unknown item type '${type}' (${panelItemHint()})`);
    if (!def.panelCapable) return fail(`'${type}' is not allowed inside a panel (${panelItemHint()})`);
    // Full widget configs are full: a typed topic_value item does NOT inherit the panel topic.
    try {
      return { ok: true, item: parseWidget(raw) };
    } catch (e) {
      return { ok: false, index, message: `items[${index}] (${type}): ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  // Readout shorthand: no type → a topic_value row. `name:` is the documented label key.
  if (raw["field"] === undefined && raw["format"] === undefined) return fail("needs a 'type' or a readout 'field' / 'format'");
  const topic = optStr(raw, "topic") ?? panelTopic;
  if (topic === undefined) return fail("'topic' is required (set it on the item or on the panel)");
  try {
    const body = parseReadout(raw);
    return {
      ok: true,
      item: {
        type: "topic_value",
        label: optStr(raw, "name") ?? optStr(raw, "label") ?? body.field ?? topic,
        topic,
        ...body,
      } as PanelItemWidgetConfig,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// The panel is structural (it parses OTHER widgets), so its spec lives here with the schema.
defineWidget<PanelWidgetConfig>({
  type: "panel",
  description: "grouped mini-widgets in one card (readout shorthands + any panel-capable widget)",
  label: (w) => w.title ?? "panel",
  parse: (raw: Obj) => {
    const rawItems = raw["items"];
    if (!Array.isArray(rawItems)) throw new Error("'items' is required and must be a list");
    if (rawItems.length === 0) throw new Error("'items' must not be empty");
    const panelTopic = optStr(raw, "topic");
    return {
      title: optStr(raw, "title"),
      topic: panelTopic,
      items: rawItems.map((item, j) => parsePanelItem(item, j, panelTopic)),
    };
  },
});

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
  const layout = doc["rmw_attachment"];
  if (layout !== undefined && !(ATTACHMENT_LAYOUTS as readonly unknown[]).includes(layout)) {
    // loud on purpose: the wrong layout kills the node that receives it
    throw new Error(`rmw_attachment must be ${ATTACHMENT_LAYOUTS.join(" | ")}, got '${String(layout)}'`);
  }
  const rigAgent = doc["rig_agent"] === true || doc["rig_agent"] === "true";
  const tabs = doc["tabs"] !== undefined ? parseTabs(doc["tabs"]) : undefined;
  const resolvedTabs: TabVisibility | undefined =
    tabs?.rig !== undefined ? tabs : rigAgent ? { ...(tabs ?? {}), rig: true } : tabs;
  return {
    name: optStr(doc, "name"),
    web_port: optNum(doc, "web_port"),
    ws_port: optNum(doc, "ws_port"),
    rig_agent: rigAgent || undefined,
    tabs: resolvedTabs,
    home: doc["home"] !== undefined ? parseHome(doc["home"]) : undefined,
    rmw_attachment: layout as AttachmentLayout | undefined,
  };
}

// Keep the span type reachable for callers that only import the schema.
export type { WidgetSpan as HomeWidgetSpan };
