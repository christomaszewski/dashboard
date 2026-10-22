# Capturing dashboard WebSocket disconnects

The dashboard now keeps a bounded local connection trace without changing connection timeouts,
retry policy, or subscriptions. Rebuild/redeploy `dashboard-web` to install it; the vehicle bridge
and rig agent do not need changes for this trace.

After a failure, click the connection-status pill in the dashboard header to download a JSON
report. It remains available after reconnecting. Alternatively, in Chrome DevTools:

```js
window.dashboardConnectionDiagnostics.download()
// Or inspect/copy the report:
copy(window.dashboardConnectionDiagnostics.snapshot())
```

Chrome's Console also logs significant failures with the prefix `[dashboard connection]`.
Enable **Preserve log** when collecting a reproduction. The JSON report includes the frontend
revision (when available), build time and a source-content hash, so Docker builds without `.git`
can still be distinguished. The last 240 events are retained; failure evidence is saved in bounded
session storage across reloads of the same tab. Nothing is uploaded automatically. Message
payloads, image bytes, service arguments and Docker log contents are not included.

## Read the sequence, not just the last error

- `bridge-dial-failure` / `ws-error` with `route: "local"` is the laptop-bridge attempt. It is
  separate from the vehicle route. The default localhost attempt may fail on every reconnect.
- `connection-drop` records the dashboard's decision to close its current session. Its reason
  identifies a probe timeout or subscription declaration failure; `probe-*`, `query-deadline`
  and `declaration-failure` events supply the operation, deadline and elapsed time.
- `ws-close-request` followed by `ws-close` with `appInitiated: true` means the dashboard/SDK
  requested the close. Use the preceding `connection-drop` to find why. `sdk-close` alone is not
  a network diagnosis: it also occurs during page cleanup and when discarding an unused bridge.
- `ws-close` with `appInitiated: false` records an unsolicited browser socket close. `code`,
  `reason` and `wasClean` are the browser's actual CloseEvent fields. Code 1006 indicates an
  abnormal close; browsers do not expose enough information to distinguish every network,
  proxy or server failure from that code alone.
- `ws-snapshot` contains cumulative WebSocket message bytes/counts, time since the last complete received
  message and the browser's outgoing `bufferedAmount`. Differences between snapshots show traffic
  rate. A partially received large WebSocket frame does not yet count as a received message;
  `bufferedAmount` measures outgoing buffering, not the incoming backlog.
- `browser-timer-delay` records a browser scheduling delay of at least 250 ms. Check its page
  visibility and the active tab before interpreting a missed probe as a network outage.

Every socket event carries an endpoint, route and unique socket ID. A late close from an old socket
therefore cannot be mistaken for failure of its replacement. The report also records page/tab
changes, bridge selection, subscription counts and pending queries.

Save the matching vehicle-side log as well, using the actual dashboard Zenoh container name:

```sh
docker logs --timestamps --since 10m CONTAINER > dashboard-zenoh-disconnect.log 2>&1
```

A disconnect in the bridge log alone does not identify which side initiated it. Match its timestamp
to the browser's `connection-drop`, `ws-close-request` and `ws-close` sequence, accounting for any
clock difference between laptop and vehicle. Preserve messages immediately before the disconnect;
those may contain the server-side error. If the entire container restarted, also record its restart
count and last start time with `docker inspect` so a process restart is distinguished from a socket
being replaced.

## Comparing previous and current versions

Use the [build comparison procedure](dashboard-build-comparison.md) for exact revision builds and
controlled local network tests. For a vehicle reproduction, keep the vehicle services, bridge,
dashboard YAML, browser and network path the same; run one dashboard build at a time. Leave Home
open long enough to reproduce, then switch to ROS without selecting a topic and capture that
transition. Do not run both dashboards simultaneously: that changes subscription traffic.

If no laptop bridge is intended, `local_bridge: false` removes its discovery attempts. Apply that
setting equally to both versions when comparing them. It is not a fix for a vehicle disconnect.

If a map's heading publisher has increased its rate, the dashboard still receives the entire
orientation message even though the display updates at 5 Hz. See the
[10 Hz heading-topic cap example](../app/README.md#layout--seams) for vehicle-side `topic_rates`.
Use the actual orientation topic and ROS domain, regenerate the configuration and recreate
`dashboard-zenoh` through the same deployment, and record that configuration change in the comparison. The cap preserves
onboard publishing/recording rates; it does not apply to a laptop bridge that bypasses that sidecar.

Clear an old trace before a controlled run if needed:

```js
window.dashboardConnectionDiagnostics.clear()
```
