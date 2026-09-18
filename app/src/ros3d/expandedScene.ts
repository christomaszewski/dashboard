import type { Ros3DSceneConfig } from "./config";
let scene: Ros3DSceneConfig | undefined;
const listeners = new Set<() => void>();
export const expandedScene = {
  snapshot: () => scene,
  subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  open: (value: Ros3DSceneConfig) => { scene = value; for (const cb of listeners) cb(); window.location.hash = "/ros3d"; },
};
