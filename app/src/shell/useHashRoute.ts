import { useCallback, useEffect, useState } from "react";
import { TAB_IDS, type TabId } from "../config/schema";

export { TAB_IDS };
export type { TabId };

function parse(hash: string): TabId | null {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  return (TAB_IDS as readonly string[]).includes(path) ? (path as TabId) : null;
}

/**
 * Hash routing (`#/cameras`) instead of path routing: real served paths (`/config/…`, `/clouds/…`)
 * can never collide with a tab route, and deep links work under Vite dev / Caddy / any sub-path
 * serving with no server cooperation. Hash changes push history, so back/forward navigate tabs.
 * Unknown (or config-hidden) routes are resolved by the Shell against its visible-tab list.
 */
export function useHashRoute(): { routed: TabId | null; navigate: (tab: TabId) => void } {
  const [routed, setRouted] = useState<TabId | null>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRouted(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: TabId) => {
    window.location.hash = `/${next}`;
  }, []);

  return { routed, navigate };
}
