import { defineWidget, type BaseWidgetConfig } from "../widgets/registry";
import { optStr, reqStr } from "../widgets/parse";

export interface RosImageWidgetConfig extends BaseWidgetConfig {
  type: "ros_image";
  topic: string;
  /** Optional picker allowlist. Omit to offer every advertised sensor_msgs/Image topic. */
  topics?: string[];
  domain_id?: number;
  normalize: boolean;
  stale_after_s: number;
  /** Vehicle state only: at most this many frames per second (fewer when the link is slow). */
  max_hz: number;
  /** Vehicle state only: frames are downscaled on the vehicle to at most this width (px). */
  max_width: number;
  /** Vehicle state only: JPEG/WebP quality 10..95 (lowered further on a slow link). */
  quality: number;
  /** Vehicle state only: frame encoding. */
  format: "jpeg" | "webp";
}

defineWidget<RosImageWidgetConfig>({
  type: "ros_image",
  description: "ROS image preview over Zenoh (Image or CompressedImage), including Ouster mono16 panoramas; with vehicle state, frames are downscaled and compressed on the vehicle",
  defaultSpan: "full",
  parse: (raw) => {
    const topic = reqStr(raw, "topic");
    if (!topic.startsWith("/")) throw new Error("'topic' must be an absolute ROS topic name");
    const topics = raw.topics;
    if (topics !== undefined && (!Array.isArray(topics) || !topics.length ||
      !topics.every((t) => typeof t === "string" && t.startsWith("/")) || !topics.includes(topic))) {
      throw new Error("'topics' must be a non-empty list of absolute names including 'topic'");
    }
    const domain = raw.domain_id;
    if (domain !== undefined && (typeof domain !== "number" || !Number.isInteger(domain) || domain < 0 || domain > 0xffffffff)) {
      throw new Error("'domain_id' must be an unsigned 32-bit integer");
    }
    if (raw.normalize !== undefined && typeof raw.normalize !== "boolean") throw new Error("'normalize' must be a boolean");
    const stale = raw.stale_after_s ?? 3;
    if (typeof stale !== "number" || !Number.isFinite(stale) || stale <= 0) throw new Error("'stale_after_s' must be positive and finite");
    const maxHz = raw.max_hz ?? 2;
    if (typeof maxHz !== "number" || !Number.isFinite(maxHz) || maxHz < 0.1 || maxHz > 30) throw new Error("'max_hz' must be between 0.1 and 30");
    const maxWidth = raw.max_width ?? 640;
    if (typeof maxWidth !== "number" || !Number.isInteger(maxWidth) || maxWidth < 32 || maxWidth > 1920) throw new Error("'max_width' must be an integer from 32 to 1920");
    const quality = raw.quality ?? 60;
    if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 10 || quality > 95) throw new Error("'quality' must be an integer from 10 to 95");
    const format = raw.format ?? "jpeg";
    if (format !== "jpeg" && format !== "webp") throw new Error("'format' must be jpeg or webp");
    return { label: optStr(raw, "label"), topic, topics: topics as string[] | undefined,
      domain_id: domain as number | undefined, normalize: (raw.normalize as boolean | undefined) ?? true, stale_after_s: stale,
      max_hz: maxHz, max_width: maxWidth, quality, format };
  },
});
