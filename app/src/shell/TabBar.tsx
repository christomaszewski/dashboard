import type { TabId } from "./useHashRoute";

const LABELS: Record<TabId, string> = {
  home: "Home",
  cameras: "Cameras",
  ros: "ROS",
  ros3d: "3D",
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
  // Home alone (the no-`tabs:` default) needs no bar: one button that goes nowhere is noise.
  if (tabs.length < 2) return null;
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
