// Specs (config types + YAML validation + layout metadata) for the built-in widgets. Pure — no
// React, no browser APIs — so the config schema and its tests can import this in node. The
// components attach in widgets/builtins.tsx. Importing this module registers the specs.
import { defineWidget, type BaseWidgetConfig } from "../../widgets/registry";
import { parseTemplate, type Template } from "../template";
import { isObj, optBool, optNum, optStr, optThresholds, reqStr, type Obj, type Thresholds, optStrList } from "../../widgets/parse";
import "./primitives/specs"; // gauge / sparkline / indicator / text register alongside

export type { GaugeWidgetConfig, SparklineWidgetConfig, IndicatorWidgetConfig, TextWidgetConfig } from "./primitives/specs";

export interface StatusWidgetConfig extends BaseWidgetConfig {
  type: "status";
  label: string;
  source: "stream" | "node" | "topic_hz";
  stream?: string; // source: stream — sensor id, descriptor id, or full keyexpr
  node?: string; // source: node — fully-qualified node name
  topic?: string; // source: topic_hz
  min_hz?: number;
  window_s?: number;
}

export interface ServiceButtonWidgetConfig extends BaseWidgetConfig {
  type: "service_button";
  label: string;
  service: string;
  /** Optional cross-check only — the actual type comes from the live graph's SS token. */
  srv_type?: string;
  request?: Record<string, unknown>;
  confirm?: boolean;
  timeout_s?: number;
}

export interface VideoWidgetConfig extends BaseWidgetConfig {
  type: "video";
  stream: string;
}
export type CameraControls = "auto" | "record" | "playback" | "none";
/** A camera tile with its controls OVERLAID: the record strip (the stream's lifecycle, paired by the
 *  one <instance> both contracts share) and, when the producer advertises playback, the playback
 *  strip. `video` is the passive fixture; this is the one you drive. */
export interface CameraWidgetConfig extends BaseWidgetConfig {
  type: "camera";
  /** The DEFAULT stream (sensor id, descriptor id, or key). Omit to pick from discovery: the only
   *  stream auto-selects, several offer a picker. The tile's picker changes it at runtime and the
   *  choice is remembered per widget (label) unless `lock`. */
  stream?: string;
  lock?: boolean; // no picker: the configured stream, and only it (operator deployments)
  confirm?: boolean; // two-step click before a recording transition
  run_id?: string; // passed with activate (recording run prefix suffix)
  /** auto (default) = whatever the service advertises; record / playback = only that strip; none = a plain tile. */
  controls: CameraControls;
}
const CAMERA_CONTROLS: readonly CameraControls[] = ["auto", "record", "playback", "none"];

export type CamerasLayout = "focus" | "grid";
const CAMERAS_LAYOUTS: readonly CamerasLayout[] = ["focus", "grid"];

/** Several feeds in one widget: `focus` = one large feed with the rest as live thumbnails in a
 *  carousel (click one to bring it up), `grid` = all tiled. The set comes from `streams:` or, when
 *  omitted, from discovery; the picker adds/removes at runtime unless `lock`. Every feed is a WebRTC
 *  session AND a vehicle-side encode (shared with every other tile of that stream, but not free). */
export interface CamerasWidgetConfig extends BaseWidgetConfig {
  type: "cameras";
  streams?: string[]; // omit = every discovered stream
  layout: CamerasLayout;
  focus?: string; // the feed in focus at first (default: the first)
  columns?: number; // grid only (default: as many as fit)
  lock?: boolean; // no picker, no close: exactly `streams`
  confirm?: boolean;
  run_id?: string;
  controls: CameraControls; // on every tile (the focused one carries them in `focus`)
}

export type BagRecorderAction = "pause" | "resume" | "split" | "snapshot";
const BAG_ACTIONS: readonly BagRecorderAction[] = ["pause", "resume", "split", "snapshot"];

/** Every rosbag2 recorder on the graph, with its writing paused or resumed from here. Discovery is
 *  by the recorder's own services (a node offering `…/pause` AND `…/is_paused`), state by polling
 *  `is_paused`. Deliberately NOT session control: a bag session is a rig run's, and where a run
 *  starts and ends stays rig's call from the vehicle. */
export interface BagRecordersWidgetConfig extends BaseWidgetConfig {
  type: "bag_recorders";
  /** Recorder node bases (e.g. /bag_logger/rosbag2_recorder). Omit = every recorder discovered. */
  recorders?: string[];
  /** The buttons offered (default: pause, resume, split). */
  actions: BagRecorderAction[];
  poll_s: number; // is_paused polling period (default 3)
  confirm?: boolean; // two-step click before pause / split / snapshot
}

export interface TopicValueWidgetConfig extends BaseWidgetConfig, Thresholds {
  type: "topic_value";
  label: string;
  topic: string;
  /** ONE of: a dot-path into the decoded message (numeric segments index arrays) … */
  field?: string;
  /** … or a format string: literal text with `{dot.path}` / `{dot.path:.Nf}` placeholders, several
   *  values of one message on one line ("lat {latitude:.6f} lon {longitude:.6f}"). */
  format?: string;
  /** `format` parsed at config time (present iff `format` is). */
  template?: Template;
  precision?: number; // field rows only
  unit?: string; // field rows only
}

const FIELD_ONLY = ["precision", "unit", "warn_below", "warn_above", "err_below", "err_above"] as const;

/** The readout body shared by `topic_value` and the panel's readout shorthand: exactly one of
 *  `field` / `format`; precision, unit and thresholds belong to a field row (a format row has no
 *  single value to threshold — write units and decimals into the string). */
export function parseReadout(raw: Obj): Pick<TopicValueWidgetConfig, "field" | "format" | "template" | "precision" | "unit" | keyof Thresholds> {
  const field = optStr(raw, "field");
  const format = optStr(raw, "format");
  if (field !== undefined && format !== undefined) throw new Error("'field' and 'format' are exclusive: one value, or one formatted line");
  if (field === undefined && format === undefined) throw new Error("needs a 'field' (one value) or a 'format' (a line with {field} placeholders)");
  if (format !== undefined) {
    const extra = FIELD_ONLY.filter((k) => raw[k] !== undefined);
    if (extra.length) {
      throw new Error(`${extra.map((k) => `'${k}'`).join(", ")} only apply to a 'field' row: put units and decimals in the format string ({x:.2f} m)`);
    }
    return { format, template: parseTemplate(format) };
  }
  return { field, precision: optNum(raw, "precision"), unit: optStr(raw, "unit"), ...optThresholds(raw) };
}

export interface MapWidgetConfig extends BaseWidgetConfig {
  type: "map";
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
}

export interface LifecycleWidgetConfig extends BaseWidgetConfig {
  type: "lifecycle";
  /** Service instance (`cam0`) or vehicle-qualified (`veh1/cam0`) — fleet/<v>/svc/<instance>/lifecycle. */
  service: string;
  confirm?: boolean; // two-step click before a transition
  run_id?: string; // passed with activate (recording run prefix suffix)
}

export interface RigWidgetConfig extends BaseWidgetConfig {
  type: "rig";
  /** Only these vehicle.yaml rows (default: every enabled row). */
  stacks?: string[];
  /** Show standby/activate/up/down buttons (default true). */
  actions?: boolean;
  /** Show New run / End run controls. OPT-IN (default false): where a run starts and ends stays
   *  rig's call from the vehicle unless a deployment says otherwise. */
  runs?: boolean;
  confirm?: boolean; // two-step click before any verb
  /** Pass the open run's label as run_id to lifecycle activate (default true). */
  use_run_label?: boolean;
}

defineWidget<RigWidgetConfig>({
  type: "rig",
  description: "rig deployment summary: open run + per-row state with standby/activate + run controls",
  panelCapable: true,
  defaultSpan: 2,
  label: (w) => w.label ?? "rig",
  parse: (raw: Obj) => {
    const stacks = raw["stacks"];
    if (stacks !== undefined && !(Array.isArray(stacks) && stacks.every((s) => typeof s === "string" && s !== "")))
      throw new Error("'stacks' must be a list of row names");
    return {
      label: optStr(raw, "label"),
      stacks: stacks as string[] | undefined,
      actions: optBool(raw, "actions"),
      runs: optBool(raw, "runs"),
      confirm: optBool(raw, "confirm"),
      use_run_label: optBool(raw, "use_run_label"),
    };
  },
});

defineWidget<StatusWidgetConfig>({
  type: "status",
  description: "presence / rate indicator: a stream's liveliness, a ROS node, or a topic's Hz",
  panelCapable: true,
  parse: (raw: Obj) => {
    const source = optStr(raw, "source");
    if (source !== "stream" && source !== "node" && source !== "topic_hz")
      throw new Error("'source' must be one of: stream, node, topic_hz");
    const w: Omit<StatusWidgetConfig, "type"> = { label: reqStr(raw, "label"), source };
    if (source === "stream") w.stream = reqStr(raw, "stream");
    if (source === "node") w.node = reqStr(raw, "node");
    if (source === "topic_hz") {
      w.topic = reqStr(raw, "topic");
      w.min_hz = optNum(raw, "min_hz");
      w.window_s = optNum(raw, "window_s");
    }
    return w;
  },
});

defineWidget<ServiceButtonWidgetConfig>({
  type: "service_button",
  description: "call a ROS 2 service over zenoh (type resolved from the live graph)",
  panelCapable: true,
  parse: (raw: Obj) => {
    const request = raw["request"];
    if (request !== undefined && !isObj(request)) throw new Error("'request' must be a mapping of field: value");
    return {
      label: reqStr(raw, "label"),
      service: reqStr(raw, "service"),
      srv_type: optStr(raw, "srv_type"),
      request: request as Obj | undefined,
      confirm: optBool(raw, "confirm"),
      timeout_s: optNum(raw, "timeout_s"),
    };
  },
});

defineWidget<VideoWidgetConfig>({
  type: "video",
  description: "embedded live camera stream (shares the WebRTC session with the Cameras tab)",
  defaultSpan: 2,
  label: (w) => w.label ?? w.stream,
  parse: (raw: Obj) => ({ stream: reqStr(raw, "stream"), label: optStr(raw, "label") }),
});

function parseControls(raw: Obj): CameraControls {
  const controls = optStr(raw, "controls") ?? "auto";
  if (!(CAMERA_CONTROLS as readonly string[]).includes(controls)) {
    throw new Error(`'controls' must be one of ${CAMERA_CONTROLS.join(" | ")}, got '${controls}'`);
  }
  return controls as CameraControls;
}

defineWidget<CameraWidgetConfig>({
  type: "camera",
  description: "camera tile with overlaid recording (and, for playback feeds, playback) controls",
  defaultSpan: 2,
  label: (w) => w.label ?? w.stream ?? "camera",
  parse: (raw: Obj) => ({
    stream: optStr(raw, "stream"),
    lock: optBool(raw, "lock"),
    label: optStr(raw, "label"),
    confirm: optBool(raw, "confirm"),
    run_id: optStr(raw, "run_id"),
    controls: parseControls(raw),
  }),
});

defineWidget<CamerasWidgetConfig>({
  type: "cameras",
  description: "several camera feeds: one in focus with a carousel of the rest, or a grid",
  defaultSpan: "full",
  label: (w) => w.label ?? "cameras",
  parse: (raw: Obj) => {
    const layout = optStr(raw, "layout") ?? "focus";
    if (!(CAMERAS_LAYOUTS as readonly string[]).includes(layout)) {
      throw new Error(`'layout' must be one of ${CAMERAS_LAYOUTS.join(" | ")}, got '${layout}'`);
    }
    const columns = optNum(raw, "columns");
    if (columns !== undefined && (!Number.isInteger(columns) || columns < 1)) {
      throw new Error(`'columns' must be a positive integer, got ${columns}`);
    }
    return {
      streams: optStrList(raw, "streams"),
      layout: layout as CamerasLayout,
      focus: optStr(raw, "focus"),
      columns,
      lock: optBool(raw, "lock"),
      label: optStr(raw, "label"),
      confirm: optBool(raw, "confirm"),
      run_id: optStr(raw, "run_id"),
      controls: parseControls(raw),
    };
  },
});

defineWidget<BagRecordersWidgetConfig>({
  type: "bag_recorders",
  description: "every rosbag2 recorder on the graph: recording/paused state, pause / resume / split / snapshot",
  defaultSpan: 2,
  panelCapable: false,
  label: (w) => w.label ?? "bag recorders",
  parse: (raw: Obj) => {
    const actions = optStrList(raw, "actions") ?? ["pause", "resume", "split"];
    const bad = actions.filter((a) => !(BAG_ACTIONS as readonly string[]).includes(a));
    if (bad.length) throw new Error(`'actions' must be from ${BAG_ACTIONS.join(" | ")}, got '${bad.join(", ")}'`);
    const poll = optNum(raw, "poll_s") ?? 3;
    if (!(poll > 0)) throw new Error(`'poll_s' must be a positive number of seconds, got ${poll}`);
    return {
      recorders: optStrList(raw, "recorders"),
      actions: actions as BagRecorderAction[],
      poll_s: poll,
      confirm: optBool(raw, "confirm"),
      label: optStr(raw, "label"),
    };
  },
});

defineWidget<TopicValueWidgetConfig>({
  type: "topic_value",
  description: "live readout: one field with unit and thresholds, or a format line interpolating several",
  panelCapable: true,
  parse: (raw: Obj) => ({
    label: reqStr(raw, "label"),
    topic: reqStr(raw, "topic"),
    ...parseReadout(raw),
  }),
});

defineWidget<MapWidgetConfig>({
  type: "map",
  description: "vehicle position marker + trail on a tile map (tiles fetched by the browser)",
  defaultSpan: 2,
  label: (w) => w.label ?? w.topic,
  parse: (raw: Obj) => {
    const tiles = optStr(raw, "tiles");
    if (tiles !== undefined && tiles !== "none" && !(tiles.includes("{z}") && tiles.includes("{x}") && tiles.includes("{y}")))
      throw new Error("'tiles' must be an XYZ template containing {z}/{x}/{y}, or 'none'");
    return {
      label: optStr(raw, "label"),
      topic: reqStr(raw, "topic"),
      lat_field: optStr(raw, "lat_field"),
      lon_field: optStr(raw, "lon_field"),
      tiles,
      zoom: optNum(raw, "zoom"),
      trail: optNum(raw, "trail"),
      follow: optBool(raw, "follow"),
      attribution: optStr(raw, "attribution"),
    };
  },
});

defineWidget<LifecycleWidgetConfig>({
  type: "lifecycle",
  description: "standby/active control of a service (camera-service recording)",
  panelCapable: true,
  label: (w) => w.label ?? w.service,
  parse: (raw: Obj) => ({
    label: optStr(raw, "label"),
    service: reqStr(raw, "service"),
    confirm: optBool(raw, "confirm"),
    run_id: optStr(raw, "run_id"),
  }),
});
