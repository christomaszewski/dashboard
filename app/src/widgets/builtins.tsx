// Attaches the React components to the built-in widget specs. Imported once by the app entry
// (main.tsx) BEFORE anything renders; the specs themselves live in home/widgets/specs.ts (and
// primitives/specs.ts) so the config schema stays React-free.
import "../home/widgets/specs";
import { lazy, Suspense } from "react";
import type { PointCloudWidgetConfig } from "../ros3d/spec";
import type { RosbagPlaybackWidgetConfig } from "../playback/rosbagSpec";
import { attachWidgetComponent } from "./registry";
import { StatusWidget } from "../home/widgets/StatusWidget";
import { ServiceButtonWidget } from "../home/widgets/ServiceButtonWidget";
import { VideoWidget } from "../home/widgets/VideoWidget";
import { CameraWidget } from "../home/widgets/CameraWidget";
import { CamerasWidget } from "../home/widgets/CamerasWidget";
import { BagRecordersWidget } from "../home/widgets/BagRecordersWidget";
import { ServicesWidget } from "../home/widgets/ServicesWidget";
import { TopicValueWidget } from "../home/widgets/TopicValueWidget";
import { MapWidget } from "../home/widgets/MapWidget";
import { LifecycleWidget } from "../home/widgets/LifecycleWidget";
import { RigWidget } from "../home/widgets/RigWidget";
import { PanelWidget } from "../home/widgets/PanelWidget";
import { GaugeWidget } from "../home/widgets/primitives/GaugeWidget";
import { SparklineWidget } from "../home/widgets/primitives/SparklineWidget";
import { IndicatorWidget } from "../home/widgets/primitives/IndicatorWidget";
import { TextWidget } from "../home/widgets/primitives/TextWidget";

attachWidgetComponent("status", StatusWidget);
attachWidgetComponent("service_button", ServiceButtonWidget);
attachWidgetComponent("video", VideoWidget);
attachWidgetComponent("camera", CameraWidget);
attachWidgetComponent("cameras", CamerasWidget);
attachWidgetComponent("bag_recorders", BagRecordersWidget);
attachWidgetComponent("services", ServicesWidget);
attachWidgetComponent("topic_value", TopicValueWidget);
attachWidgetComponent("map", MapWidget);
attachWidgetComponent("lifecycle", LifecycleWidget);
attachWidgetComponent("rig", RigWidget);
attachWidgetComponent("panel", PanelWidget);
attachWidgetComponent("gauge", GaugeWidget);
attachWidgetComponent("sparkline", SparklineWidget);
attachWidgetComponent("indicator", IndicatorWidget);
attachWidgetComponent("text", TextWidget);
const PointCloudWidget = lazy(() => import("../ros3d/PointCloudWidget"));
const RosbagPlaybackWidget = lazy(() => import("../playback/RosbagPlaybackWidget"));
attachWidgetComponent("rosbag_playback", ({ widget }: { widget: RosbagPlaybackWidgetConfig }) =>
  <Suspense fallback={<div className="widget-card">Loading replay controls…</div>}><RosbagPlaybackWidget widget={widget} /></Suspense>);
attachWidgetComponent("pointcloud", ({ widget }: { widget: PointCloudWidgetConfig }) =>
  <Suspense fallback={<div className="widget-card">Loading 3D view…</div>}><PointCloudWidget widget={widget} /></Suspense>);
