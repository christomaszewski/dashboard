import { isObj, type Obj } from "../widgets/parse";

export interface CloudColor { mode: "height" | "intensity" | "field" | "rgb" | "flat"; field?: string; value?: string }
export interface CloudDisplay {
  id: string; topic: string; enabled: boolean; color: CloudColor; point_size: number; opacity: number; history_s: number;
}
export interface Ros3DSceneConfig {
  domain_id?: number;
  fixed_frame: string;
  tf_topics: string[];
  tf_static_topics: string[];
  time_source: "live" | "ros_clock";
  clock_topic: string;
  follow_frame: string;
  show_frames: boolean;
  show_grid: boolean;
  max_points: number;
  max_cloud_points: number;
  max_memory_mb: number;
  tf_history_s: number;
  tf_wait_ms: number;
  displays: CloudDisplay[];
  playback_service: string;
  playback_state_topic: string;
}
export type SceneOverrides = Partial<Ros3DSceneConfig>;
export const DEFAULT_SCENE: Ros3DSceneConfig = {
  fixed_frame: "", tf_topics: ["/tf"], tf_static_topics: ["/tf_static"], time_source: "live", clock_topic: "/clock",
  follow_frame: "", show_frames: false, show_grid: true, max_points: 2_000_000, max_cloud_points: 500_000,
  max_memory_mb: 128, tf_history_s: 10, tf_wait_ms: 500, playback_service: "", playback_state_topic: "/ros3d/replay_state",
  displays: [{ id: "ouster", topic: "/ouster/points", enabled: true, color: { mode: "height" }, point_size: 2, opacity: 1, history_s: 0 }],
};
function text(o: Obj, key: string, allowEmpty = false): string {
  const v = o[key];
  if (typeof v !== "string" || (!allowEmpty && !v.trim())) throw new Error(`${key} must be a ${allowEmpty ? "" : "non-empty "}string`);
  return v;
}
function number(o: Obj, key: string, min: number, max: number, integral = false): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integral && !Number.isInteger(v)))
    throw new Error(`${key} must be ${integral ? "an integer " : ""}between ${min} and ${max}`);
  return v;
}
export function parseDisplay(value: unknown): CloudDisplay {
  if (!isObj(value)) throw new Error("display must be a mapping");
  const topic = text(value, "topic");
  const color = value.color ?? { mode: "height" };
  if (!isObj(color) || !["height", "intensity", "field", "rgb", "flat"].includes(String(color.mode))) throw new Error("invalid cloud color mode");
  const parsedColor: CloudColor = { mode: color.mode as CloudColor["mode"] };
  if (color.field !== undefined) parsedColor.field = text(color, "field");
  if (parsedColor.mode === "field" && !parsedColor.field) throw new Error("field coloring requires color.field");
  if (color.value !== undefined) {
    if (typeof color.value !== "string" || !/^#[0-9a-f]{6}$/i.test(color.value)) throw new Error("color.value must be #rrggbb");
    parsedColor.value = color.value;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
  return { id: value.id === undefined ? topic : text(value, "id"), topic, enabled: value.enabled !== false, color: parsedColor,
    point_size: value.point_size === undefined ? 2 : number(value, "point_size", 1, 20),
    opacity: value.opacity === undefined ? 1 : number(value, "opacity", 0, 1),
    history_s: value.history_s === undefined ? 0 : number(value, "history_s", 0, 300) };
}
export function parseSceneOverrides(value: unknown): SceneOverrides {
  if (!isObj(value)) throw new Error("ros3d scene must be a mapping");
  const out: SceneOverrides = {};
  for (const key of ["fixed_frame", "follow_frame", "playback_service", "playback_state_topic"] as const) if (value[key] !== undefined) out[key] = text(value, key, true);
  if (value.clock_topic !== undefined) out.clock_topic = text(value, "clock_topic");
  for (const key of ["tf_topics", "tf_static_topics"] as const) {
    if (value[key] === undefined) continue;
    const list = value[key];
    if (!Array.isArray(list) || list.length > 16 || !list.every((v) => typeof v === "string" && v.trim())) throw new Error(`${key} must contain at most 16 topic names`);
    out[key] = [...new Set(list)] as string[];
  }
  for (const key of ["show_frames", "show_grid"] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be boolean`); out[key] = value[key];
  }
  if (value.time_source !== undefined) {
    if (value.time_source !== "live" && value.time_source !== "ros_clock") throw new Error("time_source must be live or ros_clock");
    out.time_source = value.time_source;
  }
  if (value.domain_id !== undefined) out.domain_id = number(value, "domain_id", 0, 0xffffffff, true);
  const ranges = { max_points: [1, 5_000_000], max_cloud_points: [1, 2_000_000], max_memory_mb: [8, 256],
    tf_history_s: [1, 120], tf_wait_ms: [50, 10000] } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) if (value[key] !== undefined)
    out[key] = number(value, key, ranges[key][0], ranges[key][1], true);
  if (value.displays !== undefined) {
    if (!Array.isArray(value.displays) || value.displays.length > 16) throw new Error("displays must contain at most 16 layers");
    out.displays = value.displays.map(parseDisplay);
    if (new Set(out.displays.map((d) => d.id)).size !== out.displays.length) throw new Error("display IDs must be unique");
  }
  return out;
}
export function sceneConfig(...overrides: (SceneOverrides | undefined)[]): Ros3DSceneConfig {
  return Object.assign({}, DEFAULT_SCENE, ...overrides);
}
