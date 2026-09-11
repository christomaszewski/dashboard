import type { BaseWidgetConfig } from "../widgets/registry";
import { isObj, optBool, optNum, optStr, reqStr, type Obj } from "../widgets/parse";
import type { BasemapId } from "./basemaps";

export interface MapPositionOptions {
  lat_field?: string;
  lon_field?: string;
  /** Optional quaternion topic, e.g. sensor_msgs/Imu. Without it the marker stays a dot. */
  orientation_topic?: string;
  orientation_field?: string; // default: orientation
  orientation_frame?: "enu" | "ned";
  heading_offset_deg?: number; // clockwise correction after conversion to a compass bearing
}

export interface MapFeedConfig extends MapPositionOptions {
  id: string;
  topic: string;
  label?: string;
  color?: string;
  visible?: boolean;
}

export interface MapWidgetConfig extends BaseWidgetConfig, MapPositionOptions {
  type: "map";
  /** Single-feed shorthand; mutually exclusive with feeds. */
  topic?: string;
  feeds?: MapFeedConfig[];
  default_feed?: string;
  basemap?: BasemapId;
  tiles?: string;
  zoom?: number;
  trail?: number;
  follow?: boolean;
  attribution?: string;
}

const POSITION_KEYS = ["lat_field", "lon_field", "orientation_topic", "orientation_field", "orientation_frame", "heading_offset_deg"] as const;

function positionOptions(raw: Obj): MapPositionOptions {
  for (const key of POSITION_KEYS.filter(k => k !== "heading_offset_deg")) {
    if (raw[key] !== undefined && optStr(raw, key) === undefined)
      throw new Error(`'${key}' must be a non-empty string`);
  }
  const frame = optStr(raw, "orientation_frame");
  if (frame !== undefined && frame !== "enu" && frame !== "ned")
    throw new Error("'orientation_frame' must be enu or ned");
  if (raw.heading_offset_deg !== undefined && optNum(raw, "heading_offset_deg") === undefined)
    throw new Error("'heading_offset_deg' must be a finite number");
  if (!raw.orientation_topic && ["orientation_field", "orientation_frame", "heading_offset_deg"].some(k => raw[k] !== undefined))
    throw new Error("orientation options require 'orientation_topic'");
  return {
    lat_field: optStr(raw, "lat_field"), lon_field: optStr(raw, "lon_field"),
    orientation_topic: optStr(raw, "orientation_topic"), orientation_field: optStr(raw, "orientation_field"),
    orientation_frame: frame as MapPositionOptions["orientation_frame"],
    heading_offset_deg: optNum(raw, "heading_offset_deg"),
  };
}

/** Keep the original topic: form intact; explicit feeds have stable IDs for the runtime controls. */
export function parseMapWidget(raw: Obj) {
  let feeds: MapFeedConfig[] | undefined;
  if (raw.feeds !== undefined) {
    if (!Array.isArray(raw.feeds) || raw.feeds.length === 0)
      throw new Error("'feeds' must be a non-empty list");
    if (["topic", ...POSITION_KEYS].some(k => raw[k] !== undefined))
      throw new Error("use either 'topic' with its position/orientation options, or 'feeds' with those options per feed");
    feeds = raw.feeds.map((value, i) => {
      try {
        if (!isObj(value)) throw new Error("feed must be a mapping");
        const id = reqStr(value, "id");
        const color = optStr(value, "color");
        if (value.color !== undefined && (!color || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)))
          throw new Error("'color' must be a hex color, e.g. '#38bdf8'");
        if (value.visible !== undefined && typeof value.visible !== "boolean")
          throw new Error("'visible' must be true or false");
        return { id, topic: reqStr(value, "topic"), label: optStr(value, "label"), color,
          visible: optBool(value, "visible"), ...positionOptions(value) };
      } catch (error) { throw new Error(`feeds[${i}]: ${(error as Error).message}`); }
    });
    if (new Set(feeds.map(f => f.id)).size !== feeds.length) throw new Error("feed IDs must be unique");
  }
  const defaultFeed = optStr(raw, "default_feed");
  if (raw.default_feed !== undefined && (!defaultFeed || !feeds?.some(f => f.id === defaultFeed && f.visible !== false)))
    throw new Error("'default_feed' must name an initially visible feed ID");
  const tiles = optStr(raw, "tiles");
  if (tiles !== undefined && tiles !== "none" && !(tiles.includes("{z}") && tiles.includes("{x}") && tiles.includes("{y}")))
    throw new Error("'tiles' must be an XYZ template containing {z}/{x}/{y}, or 'none'");
  const basemap = optStr(raw, "basemap");
  if (basemap !== undefined && !["streets", "satellite", "terrain", "none", "custom"].includes(basemap))
    throw new Error("'basemap' must be streets, satellite, terrain, none, or custom");
  if (basemap === "custom" && (!tiles || tiles === "none"))
    throw new Error("'basemap: custom' requires a 'tiles' XYZ template");
  return {
    label: optStr(raw, "label"), topic: feeds ? undefined : reqStr(raw, "topic"),
    ...(feeds ? {} : positionOptions(raw)), feeds, default_feed: defaultFeed,
    basemap: basemap as BasemapId | undefined, tiles,
    zoom: optNum(raw, "zoom"), trail: optNum(raw, "trail"), follow: optBool(raw, "follow"),
    attribution: optStr(raw, "attribution"),
  };
}

export function mapFeeds(widget: MapWidgetConfig): MapFeedConfig[] {
  return widget.feeds ?? [{
    id: "position", topic: widget.topic!, label: widget.label ?? widget.topic,
    lat_field: widget.lat_field, lon_field: widget.lon_field,
    orientation_topic: widget.orientation_topic, orientation_field: widget.orientation_field,
    orientation_frame: widget.orientation_frame, heading_offset_deg: widget.heading_offset_deg,
  }];
}
