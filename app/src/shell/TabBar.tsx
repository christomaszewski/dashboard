import type { TabId } from "./useHashRoute";

const LABELS: Record<TabId, string> = {
  home: "Home",
  cameras: "Cameras",
  ros: "ROS",
  rig: "Rig",
  clouds: "Clouds",
  debug: "Bus debug",
};

export function TabBar({
  tabs,
  tab,
  navigate,
}: {
  /** Visible tabs, in display order (config-filtered by the Shell). */
  tabs: readonly TabId[];
  tab: TabId;
  navigate: (tab: TabId) => void;
}) {
  return (
    <nav className="tabs" aria-label="dashboard sections">
      {tabs.map((id) => (
        <button
          key={id}
          className={`tab${id === tab ? " active" : ""}`}
          aria-current={id === tab ? "page" : undefined}
          onClick={() => navigate(id)}
        >
          {LABELS[id]}
        </button>
      ))}
    </nav>
  );
}
