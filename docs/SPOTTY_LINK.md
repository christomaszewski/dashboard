# The dashboard over a spotty link

The operator's radio hop drops packets, adds latency, runs at a few hundred kbit/s and goes away for
seconds at a time. This page lists what the dashboard does about each part of that, where each piece
is configured, and how to rehearse a bad link on the bench before a vehicle test.

## Layer by layer

| What | Without help on a bad link | What the dashboard does | Where |
|---|---|---|---|
| Opening the page | A reload during an outage shows the browser's error page | An app-shell service worker reopens the last good page and config, then reconnects on its own | [Opening the page](#opening-the-page) |
| The connection | zenoh-ts never re-dials; queries into a dead socket hang | Reconnects with backoff, re-declares subscriptions, a deadline on every query; a laptop bridge when present | [README](../README.md), [LOCAL_BRIDGE.md](LOCAL_BRIDGE.md) |
| Home values | Raw topics queue behind each other; values seconds to minutes old | Vehicle state: only the shown fields, rounded, sent when changed, one held poll at a time | [VEHICLE_STATE.md](VEHICLE_STATE.md) |
| Map trails, sparkline history | Start empty after every reload or reconnect | Kept on the vehicle and sent whole once, then appended | [VEHICLE_STATE.md](VEHICLE_STATE.md#trails-and-histories) |
| Health, node status | Every `/diagnostics` and the whole ROS graph cross the link | Assembled on the vehicle and sent as changes; Home never subscribes to `@ros2_lv/**` | [VEHICLE_STATE.md](VEHICLE_STATE.md#health-and-node-status) |
| Camera images | Megabytes per second; frames arrive later and later, then not at all | Vehicle frames: downscaled JPEG/WebP, one request in flight, size stepped down to fit the link | [VEHICLE_STATE.md](VEHICLE_STATE.md#images) |
| Raw subscriptions (ROS tab, 3D, debug, `vehicle_state: false`) | The bridge buffers without limit and its replies wait behind the backlog | Per-topic `topic_rates`; a bounded, drop-oldest sample lane per client in the bridge; a memory ceiling | [Raw subscriptions](#raw-subscriptions) |
| Commands | A call that times out may or may not have run; pressing again may repeat it | The outcome is reported as not sent, refused or unknown; after an unknown outcome the next press asks first | [Commands](#commands) |
| Knowing the link | Nothing says whether the radio is weak or the channel is crowded | A header indicator: signal bars for the operator's peer and an interference mark, from the radio service's health report | [Radio indicator](#radio-indicator) |

## Opening the page

`dashboard-web` serves the app with a service worker (`app/public/sw.js`):

- **The page and `/config/*`** are fetched from the network first, with a 3 s deadline, and fall back
  to the last good copy. A reload while the vehicle's web server is out of reach still opens the
  dashboard with its Home layout and the vehicle-state key, and it reconnects when the link returns.
- **`/assets/*`** (content-hashed) are served from the cache first, at most 120 entries.
- **Caching headers:** assets are immutable for a year, the page and the worker are `no-cache`, so a
  reload over a working link revalidates only the page.
- **Smaller downloads:** the bundle ships with Brotli-11 and gzip-9 copies that Caddy serves as they
  are. The entry script is 260 KB over HTTPS and 316 KB over plain HTTP, against 342 KB with
  per-request gzip.

Browsers allow service workers only in secure contexts: HTTPS, or `localhost`. A page opened as
`http://<vehicle-ip>:8080` does not get the offline shell (it still gets the caching headers and the
compressed bundle). Serve the page over HTTPS, or open it through a local proxy on `localhost`, to
use it.

## Raw subscriptions

Views that need raw messages still subscribe directly: the ROS explorer and inspector, the 3D view,
bus debug, point clouds, and any widget with `vehicle_state: false`. On a weak link:

- **Cap heavy topics** with `topic_rates` in the instance YAML (per topic, in Hz). dash-up renders
  them as downsampling rules on the public sidecar, scoped to the ROS domain. Each rule has its own
  budget, which is why there is no domain-wide cap: one cap shared by all topics starved the slow
  ones.
- **The bridge drops, it does not hoard.** `deploy/zenoh-remote-api-sample-lane.patch`, applied when
  the bridge image is built, gives each WebSocket client a bounded lane for subscriber samples
  (1024 messages or 8 MiB, `ZENOH_REMOTE_API_SAMPLE_QUEUE_MESSAGES` / `_BYTES`) that drops the oldest
  first. Replies, acknowledgements and liveliness use a separate reliable lane and are written ahead
  of queued samples, so a service reply never waits behind a camera backlog. On the bench a raw
  camera over 128 kbit/s held the bridge at ~30 MB, where the unpatched bridge grew by ~16 MB/s.
- **A memory ceiling stays as a backstop.** `bridge_mem_limit` (default `512m`) restarts a bridge
  that still grows past it, and pages reconnect, instead of the vehicle running out of memory.
- One large sample already being written still delays what follows it on that TCP stream. Vehicle
  frames avoid sending large samples at all.

## Commands

Service calls and lifecycle requests go directly to the vehicle; requests and replies are small.
What a bad link changes is whether you know the result. Service buttons, the services list and bag
recorders report it as one of three outcomes:

| Outcome | When | What the operator sees |
|---|---|---|
| Not sent | No server advertised, or the link was already down | The error; nothing ran on the vehicle |
| Refused | The service answered with an error | The service's error |
| Unknown | A timeout, the link lost mid-call, or an unreadable reply | "outcome unknown — it may have run; check before retrying", kept until the next call |

After an unknown outcome a service button's next press asks "retry? may repeat" before calling
again. Calls are never retried automatically. A lifecycle timeout says the transition may still have
happened; the card shows the vehicle's actual state as it arrives.

## Radio indicator

When a radio service reports health (the Doodle service does), the header shows signal bars next
to the connection pill, and a wave mark when the channel is noisy or busy. Hover, focus or tap for
the numbers: the peer, signal, SNR, noise floor, channel busy time, TX power and peer counts. The
radio's health summary shows the same Signal and Interference readings.

- The bars describe `health.radio.peer` when it is set, else the strongest peer in the radio's
  report. Set the peer to the operator's ground radio on a mesh, so a strong link to another node
  does not hide a weak link to the operator.
- They come from SNR (reported, or signal minus the noise floor), else signal strength, else link
  quality. Interference is moderate or high when the noise floor or the channel busy time is above
  its threshold. Thresholds are presentation only; `health.radio` in the instance YAML changes them.
- The report crosses the link it describes. When the link drops, the indicator dims to last known
  rather than showing zero bars; the connection pill says `reconnecting`.
- Any radio service can feed it: the vendor-neutral `link.*` keys are in
  [SERVICE_HEALTH.md](SERVICE_HEALTH.md). The Doodle service publishes them from its peers' `rssi`,
  `pl_ratio` and `tq` fields, and the dashboard reads those vendor fields directly too, for older
  Doodle images. The exact per-peer format still needs a check with a second radio.

## Rehearsing a bad link

On a bench with Docker (host networking enabled on Docker Desktop):

```sh
tools/radio_link.sh up radio-a 18090 <ws_port>          # a relay from laptop port 18090 to the sidecar
tools/radio_link.sh set radio-a delay 50ms 10ms loss 1% rate 400kbit
tools/radio_link.sh outage radio-a 12                    # drop everything for 12 s, then restore
tools/radio_link.sh flap radio-a 6 3 2                   # 6 s up, 3 s down, twice
tools/radio_link.sh down radio-a
```

Point a page at the radio by serving a copy whose `ws_port` is the radio's port, or point
`tools/test_vehicle_state_link.mjs` at it to measure vehicle state against the direct path for each
profile (results in [VEHICLE_STATE.md](VEHICLE_STATE.md#on-an-impaired-link)).

What a bad link should look like, on the bench and on the vehicle: values that freeze but do not
error, a `reconnecting` pill during outages, values back within about 2 s of the link returning, and
image frames that get smaller rather than older. The connection diagnostics download (the header
pill) records drops, reconnects and byte counters for a later look.
