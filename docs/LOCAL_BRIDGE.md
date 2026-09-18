# Laptop bridge with vehicle fallback

Keep running the dashboard stack on the vehicle and opening its URL on the laptop. The app now
tries `ws/127.0.0.1:10000` on the laptop before using the vehicle's remote-api WebSocket. The topbar
and connection widget show the selected endpoint. No laptop process is required for direct use.

```text
preferred: browser → localhost remote-api → native Zenoh → vehicle router
fallback:  browser → vehicle remote-api → vehicle router
```

## Start the laptop bridge

Run the same remote-api version as the vehicle (currently 1.9.0), pointed at the vehicle's native
Zenoh endpoint. For example, with the locally built dashboard bridge image, replace `VEHICLE_IP`:

```sh
docker run --rm --name dashboard-laptop-bridge \
  -p 127.0.0.1:10000:10000 dashboard-zenoh:local \
  --mode client --connect tcp/VEHICLE_IP:7447 --no-multicast-scouting --ws-port 10000
```

The explicit `--mode client` matters: the bridge CLI's default can override a config file's mode.
The vehicle must be reachable when this example starts. The app discovers an already running
bridge; it does not install, start, or reconfigure one.

In the vehicle's dashboard instance YAML:

```yaml
# Default when omitted: try the laptop's loopback port, then the vehicle's ws_port.
local_bridge: ws/127.0.0.1:10000
# local_bridge: false                  # vehicle only
# local_bridge: wss/localhost:11000     # custom local TLS proxy / port
ws_port: 10000                         # VEHICLE bridge port; independent of local_bridge
```

Only loopback candidates are accepted (`127.0.0.1`, `localhost`, or `[::1]`). Both `ws/host:port`
and `ws://host:port` notation work. A malformed candidate falls back to the vehicle. An explicit
`VITE_REMOTE_API_LOCATOR` pins the connection and disables automatic selection. For local development,
`VITE_VEHICLE_HOST=VEHICLE_IP npm run dev` sets the target vehicle while retaining automatic selection.

## Selection and recovery

- Local connection attempts are limited to 1.2 seconds, including the SDK handshake. A refused,
  blocked, silent, or incompatible localhost service cannot hold up fallback indefinitely.
- Before subscribing through localhost, the app verifies that it can reach the selected vehicle.
  On first use it briefly opens the vehicle WebSocket to learn that bridge's Zenoh ID. It caches
  the ID in `sessionStorage`, scoped to the vehicle endpoint. This first identification therefore
  requires a working direct WebSocket; subsequent attempts in that tab can use the cached ID.
- A small routed query, `@/<vehicle-bridge-id>/remote-plugin/version$*`, must return that bridge's
  version key. This checks the native path to the vehicle, not just the laptop's WebSocket.
  The vehicle remote-api process must remain running: its admin queryable verifies this path. An unrelated
  bridge or blocked admin query falls back to direct use; no ACLs are changed by the app.
- While using localhost, the same routed check runs every 5 seconds. If the native uplink fails,
  the reconnect loop tries the vehicle first. Existing subscriptions and ROS discovery tokens are
  restored; stale callbacks are ignored. Pending commands fail and are **never replayed**.
- A healthy connection stays on its selected endpoint. Starting a laptop bridge later, or granting
  browser permission after fallback, takes effect on reload or the next reconnection. A vehicle
  bridge restart changes its ID; direct fallback refreshes the cached identity.

## Browser and bandwidth considerations

Browsers can restrict a vehicle-hosted page's access to loopback. Supporting browsers require a
secure page context and local-network permission; an ordinary `http://VEHICLE_IP` page can be
denied. Use trusted HTTPS for the page and compatible WebSocket endpoints where required; a local
TLS proxy can provide the configured `wss` endpoint. A denied request falls back to the vehicle.
After granting access, reload to retry localhost. See [MDN's local network access guide](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

The native laptop-to-vehicle transport can be configured for Zenoh compression separately. Bridge
selection itself does not enable compression or lower message rates. In particular, dashboard
`topic_rate_hz` / `topic_rates` rules live in the **vehicle remote-api sidecar**: connecting directly
to the router bypasses them. To save wireless bandwidth on the native path, apply rate limits on
the vehicle before that link; filtering after arrival on the laptop does not save airtime. Likewise,
sidecar-specific access policies do not automatically apply to the independent laptop bridge.

Camera signalling remains addressed to the vehicle, and WebRTC uses its existing media path.
The page, config, run downloads, and Clouds files still use HTTP from the vehicle. The Clouds tab
still downloads and renders files in the browser; keeping full cloud data on the vehicle requires
server-side processing/rendering or a separate reduced-data preview. This selection change does
not alter cloud loading.

## Implementation and verification

`app/src/transport/bridgeSelection.ts` selects the route behind the existing stable reconnecting
transport. `app/patches/zenoh-ts.mjs` applies a version-checked patch at `npm ci` / `npm install`:
one cancellable WebSocket attempt, bounded close, failed-handshake cleanup, correct closed-socket
checks, and cleanup of failed request sends. The SDK and wire protocol remain pinned to 1.9.0.
Review the patch when upgrading; do not install with lifecycle scripts disabled. Production image
builds copy the patch before running `npm ci`.

Run `cd app && npm test && npm run build`. With Docker, Node 26, and `dashboard-zenoh:local` available,
run `node tools/test_bridge_failover.mjs` from the repo root. It creates two disposable bridges and
an isolated network, verifies local selection using the real routed identity query, disconnects
only the laptop's native uplink, and checks fallback plus subscription delivery. It cleans up its
containers and network and does not touch rig services. Browser permission handling still needs
verification on the operator's browser and deployed page origin.
