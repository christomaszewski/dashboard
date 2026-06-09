import type { StreamDescriptor } from "./types";
import { vehicleHost } from "../config";

/**
 * The descriptor advertises the signalling URL the producer serves (often `ws://<vehicle-hostname>:8443`),
 * but that hostname may not resolve from the operator's browser. The signalling server is on the SAME
 * vehicle as the remote-api sidecar, so rewrite the host to the vehicle we're already talking to
 * (`vehicleHost()` — the page host when vehicle-served, or the locator-override host in dev), keeping the
 * descriptor's scheme/port/path.
 *
 * Single-vehicle assumption; a fleet / ground-station deployment must resolve a per-vehicle address.
 * Scheme (ws/wss) is left as advertised — it must match how the page is served (an https page can't open
 * a ws:// signalling socket; align the bridge's scheme accordingly).
 */
export function resolveSignallingUrl(d: StreamDescriptor): string {
  try {
    const url = new URL(d.signalling);
    url.hostname = vehicleHost();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return d.signalling;
  }
}
