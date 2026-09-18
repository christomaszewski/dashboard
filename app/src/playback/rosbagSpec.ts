import { defineWidget, type BaseWidgetConfig } from "../widgets/registry";
import { optStr } from "../widgets/parse";
import { parseSceneOverrides } from "../ros3d/config";
export interface RosbagPlaybackWidgetConfig extends BaseWidgetConfig {
  type: "rosbag_playback"; domain_id?: number; service?: string; state_topic?: string;
}
defineWidget<RosbagPlaybackWidgetConfig>({ type: "rosbag_playback", defaultSpan: "full", description: "Central controls for an optional ROS bag player",
  parse: (raw) => ({ label: optStr(raw, "label"), domain_id: parseSceneOverrides({ domain_id: raw.domain_id }).domain_id,
    service: optStr(raw, "service"), state_topic: optStr(raw, "state_topic") }) });
