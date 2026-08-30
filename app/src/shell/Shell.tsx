import { useTransportContext } from "../transport/TransportContext";
import { CameraConsole } from "../streams/CameraConsole";
import { RosExplorer } from "../ros/RosExplorer";
import { KeyspaceDebug } from "../debug/KeyspaceDebug";
import { HomeTab } from "../home/HomeTab";
import { TabBar } from "./TabBar";
import { useHashRoute, type TabId } from "./useHashRoute";

/**
 * The tabbed shell. All panels stay MOUNTED across tab switches — the inactive ones are hidden with
 * CSS only (`.hidden-tab`). This extends the camera console's "layout changes are CSS-only" doctrine
 * one level up: switching tabs never tears down WebRTC sessions, zenoh subscriptions, scroll
 * positions, or <details> state. (Not the `hidden` attribute — `.page { display:flex }` overrides it.)
 */
export function Shell({ title }: { title?: string }) {
  const { status, error, locator } = useTransportContext();
  const { tab, navigate } = useHashRoute();
  const pillClass = status === "connected" ? "ok" : status === "error" ? "err" : "warn";

  const panelClass = (id: TabId) => `page tab-panel${id === tab ? "" : " hidden-tab"}`;

  return (
    <>
      <header className="topbar">
        <span className="brand">
          Vehicle Dashboard<small>{title ?? "Phase 1"}</small>
        </span>
        <TabBar tab={tab} navigate={navigate} />
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
      <main className={panelClass("home")}>
        <HomeTab navigate={navigate} />
      </main>
      <main className={panelClass("cameras")}>
        <CameraConsole />
      </main>
      <main className={panelClass("ros")}>
        <RosExplorer />
      </main>
      <main className={panelClass("debug")}>
        <KeyspaceDebug />
      </main>
    </>
  );
}
