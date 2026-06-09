// The remote-api sidecar (zenoh-bridge-remote-api) serves the WebSocket on :10000. In the
// vehicle-served deployment the bundle and the ws share a host, so derive the locator from the page.
// zenoh-ts locator canon form is `<proto>/<addr>` (proto = ws | wss) — NOT a ws:// URL.
//
// For dev (page on localhost, sidecar on a vehicle), override:
//   VITE_REMOTE_API_LOCATOR=ws/192.168.1.10:10000 npm run dev
const WS_PORT = 10000;

// The host of the vehicle we're talking to: the page host when vehicle-served, or the host parsed from
// the VITE_REMOTE_API_LOCATOR override in dev — so the remote-api AND the WebRTC signalling target the
// same vehicle.
export function vehicleHost(): string {
  const loc = import.meta.env.VITE_REMOTE_API_LOCATOR as string | undefined;
  const m = loc?.match(/^[a-z]+\/([^:/]+)/i); // ws/<host>:<port>
  return m?.[1] ?? (window.location.hostname || "127.0.0.1");
}

export function remoteApiLocator(): string {
  const override = import.meta.env.VITE_REMOTE_API_LOCATOR as string | undefined;
  if (override) return override;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}/${vehicleHost()}:${WS_PORT}`;
}
