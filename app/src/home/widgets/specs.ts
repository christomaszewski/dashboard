// Specs (config types + YAML validation + layout metadata) for the built-in widgets. Pure — no
// React, no browser APIs — so the config schema and its tests can import this in node. The
// components attach in widgets/builtins.tsx. Importing this module registers the specs.
import { defineWidget, type BaseWidgetConfig } from "../../widgets/registry";
import { isObj, optBool, optNum, optStr, optThresholds, reqStr, type Obj, type Thresholds } from "../../widgets/parse";
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
  stream: string;
  confirm?: boolean; // two-step click before a recording transition
  run_id?: string; // passed with activate (recording run prefix suffix)
  /** auto (default) = whatever the service advertises; record / playback = only that strip; none = a plain tile. */
  controls: CameraControls;
}
const CAMERA_CONTROLS: readonly CameraControls[] = ["auto", "record", "playback", "none"];

export interface TopicValueWidgetConfig extends BaseWidgetConfig, Thresholds {
  type: "topic_value";
  label: string;
  topic: string;
  field: string; // dot-path into the decoded message, numeric segments index arrays
  precision?: number;
  unit?: string;
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
  /** Show New run / End run controls (default true). */
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

defineWidget<CameraWidgetConfig>({
  type: "camera",
  description: "camera tile with overlaid recording (and, for playback feeds, playback) controls",
  defaultSpan: 2,
  label: (w) => w.label ?? w.stream,
  parse: (raw: Obj) => {
    const controls = optStr(raw, "controls") ?? "auto";
    if (!(CAMERA_CONTROLS as readonly string[]).includes(controls)) {
      throw new Error(`'controls' must be one of ${CAMERA_CONTROLS.join(" | ")}, got '${controls}'`);
    }
    return {
      stream: reqStr(raw, "stream"),
      label: optStr(raw, "label"),
      confirm: optBool(raw, "confirm"),
      run_id: optStr(raw, "run_id"),
      controls: controls as CameraControls,
    };
  },
});

defineWidget<TopicValueWidgetConfig>({
  type: "topic_value",
  description: "live single-field readout with unit and thresholds",
  panelCapable: true,
  parse: (raw: Obj) => ({
    label: reqStr(raw, "label"),
    topic: reqStr(raw, "topic"),
    field: reqStr(raw, "field"),
    precision: optNum(raw, "precision"),
    unit: optStr(raw, "unit"),
    ...optThresholds(raw),
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
