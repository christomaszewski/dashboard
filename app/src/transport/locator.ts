// The remote-api sidecar (zenoh-bridge-remote-api) serves the WebSocket on :10000. In the
// vehicle-served deployment the bundle and the ws share a host, so derive the locator from the page.
// Prefer zenoh locator form `<proto>/<addr>` (ws | wss); the patched SDK also accepts ws:// URLs.
//
// For dev (page on localhost, sidecar on a vehicle), override:
//   VITE_REMOTE_API_LOCATOR=ws/192.168.1.10:10000 npm run dev
const DEFAULT_WS_PORT = 10000;

function locatorUrl(locator: string): URL {
  return new URL(locator.replace(/^(wss?)\/(?!\/)/, "$1://"));
}

function loopback(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(host.toLowerCase());
}

// The host of the vehicle we're talking to: the page host when vehicle-served, or the host parsed from
// VITE_VEHICLE_HOST or the VITE_REMOTE_API_LOCATOR override in dev. Local bridge selection must not
// redirect WebRTC signalling to the laptop.
export function vehicleHost(): string {
  const host = import.meta.env.VITE_VEHICLE_HOST as string | undefined;
  if (host) return host;
  const loc = import.meta.env.VITE_REMOTE_API_LOCATOR as string | undefined;
  if (loc) {
    try { return locatorUrl(loc).hostname; } catch { /* use page host */ }
  }
  return window.location.hostname || "127.0.0.1";
}

/** Precedence: VITE_REMOTE_API_LOCATOR (dev override) > wsPort (instance config) > default. */
export function remoteApiLocator(wsPort: number = DEFAULT_WS_PORT): string {
  const override = import.meta.env.VITE_REMOTE_API_LOCATOR as string | undefined;
  if (override) return override;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}/${vehicleHost()}:${wsPort}`;
}

/** Automatic bridge selection never changes vehicleHost(): media and HTTP files stay on the
 * vehicle. The dev locator override is an explicit pin and bypasses automatic selection. */
export function bridgeLocators(wsPort?: number, localBridge?: string | false): { vehicleLocator: string; localLocator?: string } {
  const vehicleLocator = remoteApiLocator(wsPort);
  if (import.meta.env.VITE_REMOTE_API_LOCATOR || localBridge === false) return { vehicleLocator };
  const localLocator = localBridge ?? "ws/127.0.0.1:10000";
  try {
    const local = locatorUrl(localLocator);
    if (!loopback(local.hostname) || !["ws:", "wss:"].includes(local.protocol) || local.username || local.password)
      return { vehicleLocator };
    const remote = locatorUrl(vehicleLocator);
    const sameHost = local.hostname === remote.hostname || (loopback(local.hostname) && loopback(remote.hostname));
    if (sameHost && local.port === remote.port && local.pathname === remote.pathname && local.protocol === remote.protocol)
      return { vehicleLocator };
    return { vehicleLocator, localLocator };
  } catch { return { vehicleLocator }; }
}
