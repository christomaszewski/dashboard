import { useMemo, useSyncExternalStore } from "react";
import { useConfig } from "../config/ConfigContext";
import { sceneConfig } from "./config";
import { expandedScene } from "./expandedScene";
import { Ros3DView } from "./Ros3DView";
export default function Ros3DTab({ active }: { active: boolean }) {
  const state = useConfig(); const app = state.phase === "ready" ? state.config : undefined;
  const expanded = useSyncExternalStore(expandedScene.subscribe, expandedScene.snapshot);
  const initial = useMemo(() => sceneConfig(app?.ros3d, expanded), [app?.ros3d, expanded]);
  return <div className="ros3d-tab">
    {app?.ros3d_error && <div className="error-box">3D config: {app.ros3d_error}</div>}
    <Ros3DView initial={initial} storageKey={`ros3d.tab.${app?.name ?? "dashboard"}`} active={active} />
  </div>;
}
