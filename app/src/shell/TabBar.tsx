import type { TabId } from "./useHashRoute";

const LABELS: Record<TabId, string> = {
  home: "Home",
  cameras: "Cameras",
  ros: "ROS",
  debug: "Bus debug",
};

export function TabBar({ tab, navigate }: { tab: TabId; navigate: (tab: TabId) => void }) {
  return (
    <nav className="tabs" aria-label="dashboard sections">
      {(Object.keys(LABELS) as TabId[]).map((id) => (
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
