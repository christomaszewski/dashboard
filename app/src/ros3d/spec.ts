import { defineWidget, type BaseWidgetConfig } from "../widgets/registry";
import { optStr } from "../widgets/parse";
import { parseSceneOverrides, type SceneOverrides } from "./config";
export interface PointCloudWidgetConfig extends BaseWidgetConfig, SceneOverrides { type: "pointcloud" }
defineWidget<PointCloudWidgetConfig>({ type: "pointcloud", defaultSpan: "full", description: "ROS 2 point clouds with timestamped TF and scan history",
  parse: (raw) => ({ ...parseSceneOverrides(raw), label: optStr(raw, "label") }) });
