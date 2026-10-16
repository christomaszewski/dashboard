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
}

defineWidget<RosImageWidgetConfig>({
  type: "ros_image",
  description: "ROS image preview over Zenoh, including Ouster mono16 panoramas",
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
    return { label: optStr(raw, "label"), topic, topics: topics as string[] | undefined,
      domain_id: domain as number | undefined, normalize: (raw.normalize as boolean | undefined) ?? true, stale_after_s: stale };
  },
});
