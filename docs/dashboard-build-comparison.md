# Comparing dashboard builds on an impaired link

`tools/compare_dashboard_builds.mjs` builds two exact Git revisions in separate temporary
directories. It never changes the checkout and does not include uncommitted deployment changes.
Each snapshot gets its own `npm ci` and its own archived Zenoh SDK patch. Reusing the working
checkout's `node_modules` would contaminate the comparison when transport diagnostics are being
developed there.

```sh
node tools/compare_dashboard_builds.mjs \
  --baseline 2ca7709 --candidate c88b07f \
  --out /private/tmp/dashboard-build-comparison \
  --network
```

The output directory must not already exist. Dependency installation is offline by default;
add `--allow-download` if an exact locked package is absent from the npm cache. The optional
network test requires Docker and a locally available bridge image. Override its image with
`--image IMAGE`; the test records the immutable image ID and uses that ID for both revisions.
It starts one uniquely named container bound to an ephemeral loopback port and removes that
container on completion.

The output contains:

- Complete archived sources, separately installed dependencies, and production `app/dist` bundles.
- Install/build logs, commit IDs, lockfile/SDK-patch hashes, and per-file SHA-256/byte inventories.
- `comparison-build.json` in each web bundle, identifying the revision without changing app behavior.
- `baseline-web-image` and `candidate-web-image` Docker contexts containing those exact built assets.
- With `--network`, the source bundles used by the native test and `network-results.json`, including
  state transitions, query timing, bytes transferred, maximum TCP queue size, and decode errors.
- Subsequent network runs also save timestamped bridge output to `bridge-container.log` before cleanup.

## What the network test establishes

Both revisions use the same native Zenoh remote-API bridge and a TCP shaper. The impaired cases
allow 16 KiB/s downstream with 200 ms propagation in each direction. Traffic keys, serialized
images, service replies, and rates are identical between revisions.

The test loads each archived revision's actual `ReconnectingTransport`, `ZenohRemoteApiTransport`,
`TopicStore`, ROS image decoder, and `callService`. The synthetic Home workload is a 256×256 mono8
image at 10 Hz plus completion-paced `rosbag2_interfaces/srv/IsPaused` calls every three seconds
with a two-second query timeout. The service-only case omits images. The image path decodes at
the store's normal five-Hz flush rate. The counter named `decodedFlushes` is decoded store updates,
not received network packets.

This is a native client test of archived application modules. It does **not** load the React Home
screen, run a real rosbag recorder, reproduce the vehicle's exact topic graph, or establish the
cause of a specific field incident. The production browser bundles are separate artifacts for
an actual browser/vehicle A/B test.

## Recorded comparison: October 22, 2026

Compared `2ca7709ab5ce009f1aeb2309c33a5c0a0f4aefa1` (October 19, including preflight recording
controls) with `c88b07ff2c12790cded6c369d4299c433b795101` (Docker logs, publisher traffic, and
runtime image pinning). These builds exclude the subsequent diagnostic/fix work in the checkout.
Both production builds passed TypeScript checking and Vite compilation on Node 26.12.0.

| Measurement | October 19 baseline | October 22 candidate |
| --- | ---: | ---: |
| Main JavaScript bundle, uncompressed | 1,344,712 B | 1,391,489 B |
| Fast image + service scenario | 0 reconnects | 0 reconnects |
| Slow service-only scenario | 0 reconnects | 0 reconnects |
| Slow image + service scenario | 1 reconnect | 1 reconnect |
| Fast image decode errors | None | None |
| Slow image decode errors | None | None |
| Fast image + service bytes transferred | 6,837,017 B | 6,837,017 B |
| Slow service-only bytes transferred | 847 B | 847 B |

The main bundle grew by 46,777 bytes (3.48%). In the saturated case both original transports
closed an actively transferring TCP connection because the link probe had not completed within
four seconds, at 9.841 and 9.845 seconds respectively. TCP bytes had arrived 15 and 9 milliseconds
before those disconnects. This reproduces a pre-existing congestion failure in both builds. It does not
demonstrate that publisher-origin accounting increased ongoing network traffic, nor rule out a
different regression involving the vehicle's actual Home layout, workload, deployment, or browser.

### Follow-up: Home subscriptions and heading traffic

The map subscribes to the full position and orientation messages, not just the fields it displays.
`TopicStore` decodes/coalesces updates at five Hz **after** every subscribed sample has crossed the
WebSocket. Raising an IMU/heading publisher's rate therefore raises dashboard network traffic even
if the map does not visibly update faster. Consumers of the same topic share one subscription;
different orientation topics add separate streams.

Health, ordinary topic readouts, and map position/orientation subscriptions stay active when Home
is hidden. The ROS image widget releases its subscription after a one-second grace period (unless
another consumer still holds that topic), and preflight recorder polling pauses. Consequently,
switching to ROS can bring an overloaded image-plus-heading connection back under its bandwidth
budget while the map subscriptions continue running.

An additional local integration test exercised actual map/readout components and old/current
TopicStore implementations with 200 graph rebuilds and five consumers sharing three topics.
Both versions made exactly three data subscriptions and three ROS subscriber announcements, with
50 map updates and 150 decodes. Hiding Home and subsequent idle traffic-counter updates did not
cause subscription churn or extra map updates. Health's ROS source uses a separate, unchanged
ingestion path. Evidence: `/private/tmp/dashboard-home-review-20261022/topics.test.ts`.

The cached upstream remote-API 1.9.0 source confirms that sample data, query replies and SDK
acknowledgements share one unbounded outgoing queue and one WebSocket writer. A local native-bridge
test started an image stream before declaring additional health/map/readout subscriptions. With
16 KiB/s downstream and 200 ms propagation each way, both the archived baseline and current
transport dropped the link about five seconds after connecting: the later declaration's three-second
acknowledgement deadline expired with `Remote api request timeout`. TCP bytes were still arriving.
This is a second congestion failure path, earlier than the periodic probe timeout. The bridge's
`Client Disconnected` log does not preserve which reader/writer finished first or its error.

A separate combined-load experiment used 128 KiB/s downstream and 200 ms propagation each way:

| Synthetic workload | Result |
| --- | --- |
| 64 KiB image at 1 Hz alone | Connected throughout 13 seconds of publishing; all 13 frames received |
| 512-byte heading samples requested at 200 Hz alone (about 184 Hz achieved) | Connected throughout 13 seconds; 2,347 samples received |
| Both streams together | Probe timeout at 14.84 seconds from test start, during 20 seconds of publishing |

In the combined case, TCP data arrived 21 ms before the drop and a complete WebSocket message
arrived 305 ms before it. The browser-side transport requested closure; the bridge logged
`Client Disconnected` 201 ms later. This demonstrates cumulative bandwidth starving control replies
even when either stream fits individually. The chosen sizes/rates are synthetic and are **not**
measurements of the vehicle's actual heading topic. The startup and combined-load results, traces
and matching bridge logs are in `/private/tmp/dashboard-startup-review-5dd41e8c/`.

The publisher-origin update also introduced a rendering cost: the expanded ROS endpoint lists
rendered while that tab was hidden. A React development/jsdom fixture with actual Home widgets and 250 topics with four
endpoints each measured 3.95 ms per graph update before the change versus 10.88 ms after it;
DOM nodes increased from 2,068 to 5,220. Without the hidden explorer, Home measured 0.51 versus
0.55 ms. These measurements exclude real browser layout/paint and establish extra work during
graph discovery/churn, not the cause of the vehicle incident.

The fix passes tab activity from Shell and memoizes the topic and node/service tables, skipping
updates while hidden. Tables are not built until the first visit; after a visit their DOM and open
details remain intact while hidden. Activation refreshes them from the latest graph. The selected
inspector stays outside that boundary on the live graph, retaining its subscription across tab
changes and releasing it when the topic disappears. Regression tests cover initial activation,
hidden graph changes, retained details, live hidden samples, and selected-topic removal.
Original measurement evidence: `/private/tmp/dashboard-react-churn-comparison-20261022.json`.

Repeating the actual-component fixture after the fix reduced hidden graph-update work from
10.79 to 0.50 ms before the first ROS visit and from 11.00 to 0.56 ms after a visit, matching
Home alone at 0.56 ms. Previously opened details retained their DOM identity and open state;
all cases maintained three topic acquisitions and zero releases during graph churn. These are
React development/jsdom measurements, excluding browser layout/paint and network behavior.
Evidence: `/private/tmp/dashboard-hidden-ros-fix-review-20261022/results.json`.

For high-rate heading streams, use per-topic `topic_rates` on the vehicle dashboard sidecar to
limit only the browser-facing copy, initially around 5–10 Hz for heading. Keep onboard publishers
at their required rate. Match the actual topic names and ROS domain; choose the image cap separately
from its serialized frame size and available bandwidth. Avoid a blanket cap on shared diagnostics
topics, which can discard individual reporters' health updates. A laptop bridge that connects
directly to the router bypasses the vehicle sidecar's limits.

The existing limiter was verified using an upstream Zenoh peer and separate capped/uncapped client
sidecars connected over native TCP, with SDK clients on their WebSockets. The actual config
generator produced a domain-91 `/heading` limit of ten Hz. Of 1,096 messages published over six
seconds, the capped sidecar delivered 59 and the uncapped sidecar delivered all 1,096. An unrelated
topic and `/heading` in domain 92 remained uncapped. All 30 service-style queries on the capped
key completed. Evidence: `/private/tmp/dashboard-native-rate-cap-f06a311e/result.json`.

Local evidence for this run is retained at
`/private/tmp/dashboard-build-comparison-20261022-v4/` (inventories, build logs, source bundles,
and network results). Temporary evidence should be copied elsewhere if needed after cleanup.

## Testing the exact web artifacts on a vehicle

Build both web images from the generated contexts. These Dockerfiles copy the tested assets;
they do not rebuild JavaScript or incorporate the working checkout's Dockerfile changes.

```sh
comparison_dir=/private/tmp/dashboard-build-comparison
docker build -t dashboard-web:compare-2ca7709 "$comparison_dir/baseline-web-image"
docker build -t dashboard-web:compare-c88b07f "$comparison_dir/candidate-web-image"
```

Tag/publish the images to the vehicle's registry if the build machine is different. Use the same
runtime Caddy image digest for both if runtime reproducibility matters. For a controlled test,
keep the dashboard bridge, agent, instance YAML, active topics, client device, and network path
fixed; change only `dashboard-web`. Preserve the existing Compose project name when invoking
the launcher directly:

```sh
COMPOSE_PROJECT_NAME=EXISTING_DASHBOARD_PROJECT \
DASH_WEB_IMAGE=REGISTRY/dashboard-web:compare-2ca7709 \
./dash-up /absolute/path/to/dashboard.yaml up -d --no-deps dashboard-web
```

Repeat with `compare-c88b07f`. Reload the browser fully between trials and inspect
`http://VEHICLE:WEB_PORT/comparison-build.json` to verify the served revision. Record which Home
widgets are active, the selected image/cloud topics, elapsed time to disconnect, and the visible
connection error. An unrelated refused localhost bridge attempt does not establish that the
active vehicle WebSocket failed. The launcher example above is an operator procedure; this
comparison tool never deploys to a vehicle or pushes images.
