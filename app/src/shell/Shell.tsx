import { Suspense, lazy, useRef } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { CameraConsole } from "../streams/CameraConsole";
import { LifecycleServicesCard } from "../lifecycle/LifecycleServicesCard";
import { PlaybackServicesCard } from "../playback/PlaybackServicesCard";
import { RosExplorer } from "../ros/RosExplorer";
import { KeyspaceDebug } from "../debug/KeyspaceDebug";
import { HomeTab } from "../home/HomeTab";
import { RigTab } from "../rig/RigTab";
import { visibleTabs, type TabVisibility } from "../config/schema";
import { TabBar } from "./TabBar";
import { useHashRoute, type TabId } from "./useHashRoute";
import { TabActivity } from "./TabActivity";

// Lazy: three.js + the BPF loaders live in their own chunk, downloaded on first visit only.
const CloudsTab = lazy(() => import("../clouds/CloudsTab"));
const Ros3DTab = lazy(() => import("../ros3d/Ros3DTab"));

/**
 * The tabbed shell. All ACTIVE panels stay MOUNTED across tab switches — the inactive ones are
 * hidden with CSS only (`.hidden-tab`), so switching never tears down WebRTC sessions, zenoh
 * subscriptions, scroll positions, or <details> state. (Not the `hidden` attribute — `.page
 * { display:flex }` overrides it.) Two config-driven exceptions: tabs the instance YAML does not
 * opt into (`tabs:` — Home is the only default) are not rendered at all, and the heavy Clouds tab
 * mounts on FIRST visit (kept mounted after) so its chunk only loads when someone opens it.
 */
export function Shell({ title, tabs }: { title?: string; tabs?: TabVisibility }) {
  const { status, error, locator } = useTransportContext();
  const visible = visibleTabs(tabs);
  const { routed, navigate } = useHashRoute();
  const tab = routed !== null && visible.includes(routed) ? routed : visible[0];

  const visited = useRef(new Set<TabId>());
  visited.current.add(tab);

  const pillClass = status === "connected" ? "ok" : status === "error" ? "err" : "warn";
  const panelClass = (id: TabId) => `page tab-panel${id === tab ? "" : " hidden-tab"}`;

  return (
    <>
      <header className="topbar">
        <span className="brand">
          Vehicle Dashboard<small>{title ?? "Phase 1"}</small>
        </span>
        <TabBar tabs={visible} tab={tab} navigate={navigate} />
        <span className="spacer" />
        <span className="locator">{locator}</span>
        <span className={`pill ${pillClass}`}>{status}</span>
      </header>
      {status === "error" && (
        <main className="page">
          <div className="error-box">
            {error}
            {"\n\n"}Is the dashboard-zenoh sidecar up and reachable at that locator?
          </div>
        </main>
      )}
      {visible.includes("home") && (
        <main className={panelClass("home")}>
          <TabActivity.Provider value={tab === "home"}><HomeTab navigate={navigate} tabs={visible} /></TabActivity.Provider>
        </main>
      )}
      {visible.includes("cameras") && (
        <main className={panelClass("cameras")}>
          <LifecycleServicesCard />
          <PlaybackServicesCard />
          <CameraConsole />
        </main>
      )}
      {visible.includes("ros") && (
        <main className={panelClass("ros")}>
          <RosExplorer />
        </main>
      )}
      {visible.includes("rig") && (
        <main className={panelClass("rig")}>
          <RigTab />
        </main>
      )}
      {visible.includes("ros3d") && visited.current.has("ros3d") && (
        <main className={panelClass("ros3d")}>
          <Suspense fallback={<p className="empty">Loading 3D view…</p>}><Ros3DTab active={tab === "ros3d"} /></Suspense>
        </main>
      )}
      {visible.includes("clouds") && visited.current.has("clouds") && (
        <main className={panelClass("clouds")}>
          <Suspense fallback={<p className="empty">loading viewer…</p>}>
            <CloudsTab />
          </Suspense>
        </main>
      )}
      {visible.includes("debug") && (
        <main className={panelClass("debug")}>
          <KeyspaceDebug />
        </main>
      )}
    </>
  );
}
