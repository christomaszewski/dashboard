import { useCallback, useEffect, useState } from "react";

/** Tab ids double as the hash routes: #/home, #/cameras, #/ros, #/debug. */
export const TAB_IDS = ["home", "cameras", "ros", "debug"] as const;
export type TabId = (typeof TAB_IDS)[number];

function parse(hash: string): TabId {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  return (TAB_IDS as readonly string[]).includes(path) ? (path as TabId) : "home";
}

/**
 * Hash routing (`#/cameras`) instead of path routing: real served paths (`/config/…`) can never
 * collide with a tab route, and deep links work under Vite dev / Caddy / any sub-path serving with
 * no server cooperation. Hash changes push history, so back/forward navigate tabs.
 */
export function useHashRoute(): { tab: TabId; navigate: (tab: TabId) => void } {
  const [tab, setTab] = useState<TabId>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setTab(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: TabId) => {
    window.location.hash = `/${next}`;
  }, []);

  return { tab, navigate };
}
