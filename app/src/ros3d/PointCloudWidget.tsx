import { useMemo } from "react";
import { useConfig } from "../config/ConfigContext";
import { visibleTabs } from "../config/schema";
import { useTabActive } from "../shell/TabActivity";
import type { PointCloudWidgetConfig } from "./spec";
import { sceneConfig } from "./config";
import { Ros3DView } from "./Ros3DView";
import { expandedScene } from "./expandedScene";
export default function PointCloudWidget({ widget }: { widget: PointCloudWidgetConfig }) {
  const state = useConfig(); const active = useTabActive();
  const app = state.phase === "ready" ? state.config : undefined;
  const initial = useMemo(() => sceneConfig(app?.ros3d, widget), [app?.ros3d, widget]);
  return <div className="widget-card widget-pointcloud"><span className="widget-label">{widget.label ?? "Point clouds"}</span>
    <Ros3DView initial={initial} storageKey={`ros3d.widget.${app?.name ?? "dashboard"}.${widget.label ?? widget.area ?? "pointcloud"}`} compact active={active}
      onExpand={visibleTabs(app?.tabs).includes("ros3d") ? expandedScene.open : undefined} />
  </div>;
}
