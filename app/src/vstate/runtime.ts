// Where this page's vehicle-state service lives. dash-up derives the key (vehicle_id or the host's
// short hostname, plus the instance name) and renders it into /config/runtime.json next to the
// instance YAML, so the browser addresses its own vehicle even when several share the mesh.
import { STATE_KEY_RE } from "./protocol";

export const RUNTIME_URL = "/config/runtime.json";

export type StateKeyResult = { base: string } | { error: string };

export interface RuntimeKeys {
  base?: string;
  currentRunBase?: string;
  error?: string;
  currentRunError?: string;
  /** A network failure is worth retrying even when full vehicle state is disabled. */
  retry?: boolean;
}

/** One runtime read configures both full widget projection and the independent local run header. */
export async function loadRuntimeKeys(fetchFn: typeof fetch = fetch, override?: string): Promise<RuntimeKeys> {
  const base = override && STATE_KEY_RE.test(override) ? override : undefined;
  const overrideError = override && !base ? `vehicle state: VITE_VEHICLE_STATE_KEY '${override}' is not a plain key` : undefined;
  try {
    const res = await fetchFn(RUNTIME_URL, { cache: "no-store" });
    if (!res.ok) return { base, error: overrideError || (base ? undefined : `vehicle state: ${RUNTIME_URL} is missing (HTTP ${res.status}) — start the dashboard with dash-up`), retry: res.status !== 404 };
    const doc: unknown = await res.json();
    const config = typeof doc === "object" && doc !== null ? doc as Record<string, unknown> : {};
    const key = config.vehicle_state_key;
    const runKey = config.current_run_state_key;
    return {
      base: base || (typeof key === "string" && STATE_KEY_RE.test(key) ? key : undefined),
      error: overrideError || (!base && !(typeof key === "string" && STATE_KEY_RE.test(key)) ? `vehicle state: ${RUNTIME_URL} has no valid vehicle_state_key` : undefined),
      currentRunBase: typeof runKey === "string" && STATE_KEY_RE.test(runKey) ? runKey : undefined,
      currentRunError: runKey !== undefined && !(typeof runKey === "string" && STATE_KEY_RE.test(runKey))
        ? `Current run: ${RUNTIME_URL} has no valid current_run_state_key` : undefined,
    };
  } catch (e) {
    return { base, error: overrideError || (base ? undefined : `vehicle state: could not load ${RUNTIME_URL} (${e instanceof Error ? e.message : String(e)})`), retry: true };
  }
}

export async function loadStateKey(fetchFn: typeof fetch = fetch, override?: string): Promise<StateKeyResult> {
  const keys = await loadRuntimeKeys(fetchFn, override);
  return keys.error ? { error: keys.error } : keys.base ? { base: keys.base } : { error: "vehicle state key unavailable" };
}
