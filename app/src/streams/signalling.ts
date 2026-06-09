import type { StreamDescriptor } from "./types";

/**
 * The descriptor advertises the signalling URL the producer serves (often `ws://<vehicle-hostname>:8443`),
 * but that hostname may not resolve from the operator's browser. In the Phase-1 vehicle-served model the
 * signalling server is on the SAME host the dashboard was loaded from, so rewrite the host to
 * `window.location.hostname` (keeping the descriptor's scheme/port/path).
 *
 * This is a single-vehicle assumption; a fleet / ground-station deployment must resolve a per-vehicle
 * reachable address instead. Scheme (ws/wss) is left as advertised — it must match how the page is
 * served (an https page can't open a ws:// signalling socket; align the bridge's scheme accordingly).
 */
export function resolveSignallingUrl(d: StreamDescriptor): string {
  try {
    const url = new URL(d.signalling);
    if (window.location.hostname) url.hostname = window.location.hostname;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return d.signalling;
  }
}
