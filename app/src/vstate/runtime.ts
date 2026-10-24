// Where this page's vehicle-state service lives. dash-up derives the key (vehicle_id or the host's
// short hostname, plus the instance name) and renders it into /config/runtime.json next to the
// instance YAML, so the browser addresses its own vehicle even when several share the mesh.
import { STATE_KEY_RE } from "./protocol";

export const RUNTIME_URL = "/config/runtime.json";

export type StateKeyResult = { base: string } | { error: string };

export async function loadStateKey(fetchFn: typeof fetch = fetch, override?: string): Promise<StateKeyResult> {
  if (override) {
    return STATE_KEY_RE.test(override) ? { base: override } : { error: `vehicle state: VITE_VEHICLE_STATE_KEY '${override}' is not a plain key` };
  }
  try {
    const res = await fetchFn(RUNTIME_URL, { cache: "no-store" });
    if (!res.ok) return { error: `vehicle state: ${RUNTIME_URL} is missing (HTTP ${res.status}) — start the dashboard with dash-up` };
    const doc: unknown = await res.json();
    const key = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).vehicle_state_key : undefined;
    if (typeof key === "string" && STATE_KEY_RE.test(key)) return { base: key };
    return { error: `vehicle state: ${RUNTIME_URL} has no valid vehicle_state_key` };
  } catch (e) {
    return { error: `vehicle state: could not load ${RUNTIME_URL} (${e instanceof Error ? e.message : String(e)})` };
  }
}
