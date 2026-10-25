# Vehicle-side state: a small, change-only view stream

Status: phase 1 implemented on `feat/vehicle-state`. Opt-in with `vehicle_state: true`.

## Problem

The browser is a full Zenoh client. Every Home widget subscribes to its ROS topic's raw CDR
messages, which cross the wireless hop at the publisher's rate. The browser then decodes the latest
one five times a second (`app/src/ros/topicStore.ts`) and reads one or two fields. Most of the
bytes that cross the air are discarded on arrival.

- A heading readout on a 200 Hz `sensor_msgs/Imu` topic receives about 350 bytes × 200/s
  (≈ 70 KB/s, ≈ 0.5 Mbit/s) to show one number at 5 Hz.
- `topic_rates` caps (sidecar downsampling) lower the message rate but still send full messages,
  make rate widgets report the capped rate, and do not apply to the laptop-bridge route.
- All of it shares one TCP WebSocket. On a lossy link TCP delivers old samples in order instead of
  dropping them, and one large message holds up every small one behind it, so data arrives late
  and in bursts. That traffic also competes with the WebRTC video for the same radio.

## Goal

Keep high-rate ROS traffic on the vehicle. Send the operator only what the screen shows, only when
it changes, and never queue stale values behind each other.

Non-goals for phase 1: point clouds, image previews, the ROS explorer, bus debug, and service
calls. These stay on the direct path (see [What stays direct](#what-stays-direct)).

## Design

```text
                         vehicle                                          laptop
 ROS nodes ──► rmw_zenoh router ──► dashboard-state-zenoh (127.0.0.1 only)
                     │                      │ full-rate topics, loopback
                     │                      ▼
                     │              dashboard-state (Node)
                     │                decode · project · quantize · rate · staleness
                     │                answers   fleet/<vehicle>/dash/<name>/state/{view,poll}
                     │
                     └──► dashboard-zenoh (public sidecar) ══ radio ══►  browser
                                    only the small poll replies cross
```

### Widgets declare what they show

A widget passes the fields it renders to `useTopic`:

```ts
useTopic(widget.topic, { fields: [{ path: widget.field, quantum: 0.01 }] })
```

With `vehicle_state: true`, the hook routes the request to the vehicle service instead of
subscribing to the raw topic. It returns the same `TopicSnapshot` shape, whose `message` is a sparse
object holding only the requested paths, so `pluckField`, templates, thresholds and rules work
unchanged. Callers that do not pass `fields` (the ROS inspector, extensions that read whole
messages) keep the direct path. A widget opts out with `vehicle_state: false`.

The vehicle never reads the dashboard YAML. Requests come from the widgets actually mounted, so
custom extension widgets can use vehicle state too, and the YAML and service cannot drift apart.

### Change-only, exactly

Each numeric field carries a quantum derived from how it is displayed. The vehicle rounds to that
quantum and sends a field only when the rounded value changes, so "unchanged" means "would render
identically".

| Widget | Requested fields | Quantum |
|---|---|---|
| `topic_value` (`field`) | the field | `10^-precision`, else 0.001 (`formatValue`'s default rounding) |
| `topic_value` (`format`) | every placeholder | `10^-N` for `{p:.Nf}`, else 0.001 |
| `gauge` | the field | the smaller of the text quantum and (max − min)/1000 |
| `sparkline` | the field | text quantum |
| `indicator` | the field | none: rules compare exact values |
| `map` position | lat / lon fields | 1e-7° (≈ 1 cm) |
| `map` heading | orientation field, `orientation_covariance.0` | 1e-3 per quaternion component (≈ 0.1°) |
| `status` (topic rate) | none (rate only, never decoded) | Hz to 0.1 |

Rounding a thresholded value to its display precision can move the threshold comparison by at most
half a display unit; the operator cannot see that difference either.

### Protocol v1

Keys are under `B = fleet/<vehicle>/dash/<name>/state`. Both operations are Zenoh queries with JSON
payloads, so they ride the existing reconnecting transport, query deadlines, laptop-bridge selection
and diagnostics.

1. **Register** — `get B/view`, payload `{ v: 1, items: ItemSpec[] }`. Reply
   `{ v: 1, view, epoch }`. The view id is a hash of the canonical spec: identical layouts from
   several operators share one view, and re-registering is idempotent.
2. **Poll** — `get B/poll`, payload `{ v: 1, view, epoch, since }`. The reply carries the current
   state of every item that changed after update number `since`. `since: 0` (or a different epoch)
   returns every item: the snapshot path and the delta path are the same code. When nothing has
   changed the vehicle holds the query until something does, or for 2 s as a heartbeat. The browser
   sends its next poll when the reply lands, at most every 200 ms.

```ts
ItemSpec  = { topic: string; fields?: { p: string; q?: number }[]; hz?: boolean; window_ms?: number }
PollReply = { v: 1; epoch: string; seq: number; items: [index: number, state: ItemState][] }
          | { v: 1; error: "unknown-view" }        // vehicle restarted: register again
ItemState = {
  t?: string;              // type name; absent = topic not advertised on the vehicle
  d?: number;              // ROS domain
  f?: (Value | null)[];    // one per requested field; null = path absent in the message
  hz?: number;             // vehicle-measured rate (only when requested)
  e?: string; w?: string;  // decode/subscribe error, decoder warning
  l?: 1;                   // value came from a latched (transient-local) publisher
  s?: 1;                   // stale: no new sample for 5 s, or 3 × its usual interval if longer
}
```

Values are JSON with tags for what JSON cannot carry: `{"$big":"…"}` for int64/uint64,
`{"$num":"NaN"}` for non-finite floats. Typed arrays become arrays.

Why this shape:

- **No backlog, ever.** Each operator has at most one poll in flight, so the newest state is at
  most one round trip old. On a bad link replies get rarer and carry larger deltas; values that
  changed in between are skipped automatically.
- **No per-client state on the vehicle.** Each item records the update number of its last change.
  A reconnect or a new operator is just a poll with an old `since`.
- **Same path through the laptop bridge.** The data is already small before it reaches the radio.
- **Pull, not push.** Publishing over Zenoh would queue again inside the bridge and its WebSocket;
  the publisher cannot see that a browser is behind.

Limits: 256 items per view, 16 fields per item, 64 KiB per registration, 8 KiB per encoded item
state (larger values become an item error naming the limit), 64 live views. A view nobody has
polled for 60 s is dropped; its raw subscriptions close when no other view uses them.

### Staleness is state

The vehicle knows when each topic last published and sends a `stale` transition. The browser
learns link health from its own polls. Today "the publisher stopped" and "the link dropped" both
look like a frozen number. Value widgets mark stale readings in their detail line.

### Vehicle service

`dashboard-state` is a Node process bundled from the same TypeScript the browser runs. It reuses
the graph builder, `TopicStore` (subscription, decode at 5 Hz, rate, transient-local seeding),
the decoders and `pluckField`, so field semantics have one implementation.

- It connects to its **own** remote-api bridge, `dashboard-state-zenoh`: the existing
  `dashboard-zenoh` image, listening on `127.0.0.1` only. The public sidecar's `topic_rates` caps
  therefore apply to the browser path only, and the vehicle service always sees full-rate data and
  measures true rates.
- Crash-only: if its Zenoh session stops answering probes it exits and Docker restarts it. Browsers
  see `unknown-view` (or a new epoch) and re-register automatically.

### Vehicle identity

Several vehicles can be visible on one mesh, so the key carries the vehicle. `vehicle_id:` in the
instance YAML sets it; otherwise dash-up uses the host's short hostname. dash-up passes the key to
the service and renders `var/run/<name>/runtime.json`, which `dashboard-web` serves at
`/config/runtime.json` so the browser addresses the right vehicle.

### Failure behaviour

| Situation | What the operator sees |
|---|---|
| Link down | Last values stay; the connection pill shows `reconnecting`; polling resumes after reconnect |
| State service absent or not answering | Widgets show `!` with "vehicle state service not reachable"; retried with backoff |
| State service restarted | One `unknown-view` round trip, then a full snapshot |
| Topic not advertised on the vehicle | "waiting for topic", as before |
| Topic stopped publishing | Last value with a stale marker |

### Images

`ros_image` widgets on the vehicle path get **frames** instead of raw image messages. The vehicle
keeps only the newest sample of the topic (`sensor_msgs/Image` or `CompressedImage`), decodes it
only when a widget asks, downscales it to the widget's `max_width`, and encodes JPEG or WebP at its
`quality` with sharp (libvips) — once per frame and size, however many operators watch.

- **Pull, one request in flight per widget**, at most `max_hz` frames a second (default 2). The
  vehicle holds a request until it has a frame newer than the one shown, so an idle camera costs a
  heartbeat every 2 s.
- **Sized to the link.** The browser times each frame's crossing (round trip minus the vehicle's
  hold). Frames slower than 1.5 × their interval step down in size and quality (75%, 50%, 35%,
  25% of `max_width`; quality −10 to −30); five quick ones in a row step back up.
- **Own key**, `B/frame`: a large frame never delays the small state polls on the vehicle side. The
  reply is binary — a u32 header length, a JSON header (frame number, source and encoded size,
  encoding, age on the vehicle, hold, stamp, vehicle-measured rate, stale, error) and the image.
- **Cost on the vehicle.** The frame service subscribes to a topic only while some widget asks for
  it (dropped 10 s after the last request) and keeps raw bytes, never decoding unwatched samples.
  Bench: a 640×480 `rgb8` camera at 15 Hz plus a 1024×64 `mono16` range image and a 1280×720
  JPEG stream, all at full rate, took 8–14% of one Apple-silicon core and ~60 MB.

Measured on the bench (real `rmw_zenohd`, Lyrical): the 640×480 camera reached the operator at
5 frames a second in 31 KB/s (6–7 KB per frame, ~10 ms old on leaving the vehicle) where the raw
stream is 13.8 MB/s; the 1280×720 JPEG stream as 480×270 WebP in 1.5–1.8 KB per frame.

Over a simulated radio (`tools/radio_link.sh`), the same 640×480 camera as vehicle frames (`max_hz:
5`) against the raw `sensor_msgs/Image` path, age = display time − header stamp:

| Radio hop | Vehicle frames | Raw images |
|---|---|---|
| Clean | 5 fps, 35 KB/s, 0.04 s old | 5 fps shown, 13.5 MB/s |
| 2 Mbit/s, 1% loss | 4.9 fps, 0.2 s old (p50) | 0.3 fps, 11–15 s old |
| 400 kbit/s, 1% loss | 4.1 fps at 75% size, 0.3 s old | 0.1 fps, 34 s old |
| 128 kbit/s | 2.5 fps at 50% size, 0.5 s old | none |

The synthetic test pattern compresses unusually well (~7 KB per frame); a real 640-wide camera frame
is more like 30–50 KB, so expect deeper size steps and roughly one frame a second at 128 kbit/s.

There is no ingest cap on the private bridge: zenoh's downsampling keeps one budget per rule, so a
cap on all image topics would be shared between cameras and starve the slower ones.

## Configuration

```yaml
vehicle_state: true        # start dashboard-state + its private bridge; Home widgets use it
# vehicle_id: rover-3      # default: the vehicle host's short hostname
# state_ws_port: 10001     # the private bridge's loopback WebSocket port
```

Per widget: `vehicle_state: false` keeps that widget (or panel item) on the direct path.

## What stays direct

- ROS explorer, topic inspector and bus debug: debugging tools that need raw messages.
- Service calls and lifecycle/playback/rig control: already small request/response traffic.
- `pointcloud`: better served by vehicle-side decimation (later). `ros_image` uses vehicle frames
  (see [Images](#images)); a widget with `vehicle_state: false` stays direct.
- Health and preflight: they read the camera-service health keys and `/diagnostics` (phase 2).
- The browser's ROS graph subscription (`@ros2_lv/**`) still runs for the ROS tab, node status and
  services widgets (phase 2 makes it lazy).

## Phases

1. **This branch.** The service and protocol; `topic_value`, panel readouts, `gauge`,
   `sparkline`, `indicator`, `status` (topic rate) and `map` position/heading on vehicle state;
   deployment, rig integration and tests.
2. **Richer projections.** A vehicle-kept map trail (sent once, then appended), min/max-decimated
   sparkline history, health and preflight summaries, a graph summary for `status: node`, and a lazy
   browser graph so Home alone never pulls `@ros2_lv/**`.
3. **Raw ROS is opt-in.** An optional "operator mode" that denies `<domain>/**` on the public sidecar
   (the state service has its own bridge, so it is unaffected).

The earlier idea of pausing direct subscriptions while Home is hidden is dropped: it would break map
trails and sparkline history, and with vehicle state a hidden Home costs at most a heartbeat poll
per couple of seconds.

## Measured

Real 1.9.0 remote-api bridges on one machine, a publisher shaped like rmw_zenoh (200 Hz
`sensor_msgs/Imu`, 10 Hz `NavSatFix`), bytes counted on the operator's WebSocket in steady state.

| Operator view | Path | Received | Sent | Messages/s |
|---|---|---|---|---|
| Map position + heading, vehicle turning and driving | direct | 77.1 KB/s | 0 | 204 |
| | vehicle state | 1.25 KB/s | 0.56 KB/s | 10 |
| Same, vehicle parked (sensor noise only) | direct | 77.0 KB/s | 0 | 203 |
| | vehicle state | 0.79 KB/s | 0.52 KB/s | 9 |
| Seven-widget Home in Chromium, vehicle moving | direct | 76.8 KB/s | 0 | 203 |
| | vehicle state | 2.3 KB/s | 0.56 KB/s | 10 |

The operator receives 33–98× fewer bytes, or 27–59× counting the poll requests it sends (the sent
column, at most five a second), in 20× fewer messages, and nothing queues. A real vehicle publishes far more
topics; on the vehicle-state path the cost depends on how many widgets are shown, not on how much
the vehicle publishes.

### On an impaired link

The same publisher behind the bench stack (Docker images, 2026-10-24). Two simulated radios
(`tools/radio_link.sh`: netem on a relay between the operator and the public sidecar, both
directions) carry one operator each, vehicle state and direct, with the same profile. The figure is
the age of the IMU value the operator would display, in seconds, sampled every 100 ms for 20 s;
"drain" is how long the direct path needed, once the link was clean again, to show a value under a
second old.

| Radio hop | Vehicle state p50 / p95 / max | Direct p50 / p95 / max | Direct drain |
|---|---|---|---|
| Clean | 0.11 / 0.21 / 0.31 | 0.10 / 0.20 / 0.20 | – |
| 150 ms ± 20 ms each way | 0.42 / 0.58 / 0.65 | 0.32 / 0.43 / 0.48 | – |
| 50 ms, 5% loss | 0.22 / 0.61 / 0.93 | 0.20 / 0.39 / 0.58 | – |
| 50 ms, 15% loss | 0.29 / 0.94 / 1.52 | 0.25 / 1.26 / 2.07 | – |
| 400 kbit/s, 50 ms, 1% loss | 0.24 / 0.34 / 0.55 | 4.36 / 8.32 / 9.22 | 6.5 s |
| 128 kbit/s, 100 ms | 0.36 / 0.49 / 0.56 | 10.2 / 17.2 / 17.9 | 14.6 s |
| 6 s up / 3 s down, twice | 0.25 / 4.00 / 4.41 | 0.28 / 3.73 / 4.13 | – |
| 12 s outage | 6.91 / 15.9 / 16.9 | 7.02 / 15.8 / 16.3 | – |

- **Bandwidth is where vehicle state matters.** Once the link carries less than the raw stream
  (about 520 kbit/s here), the direct path falls behind without bound and keeps showing old data for
  seconds after the link recovers. Vehicle state stays under 0.6 s at 128 kbit/s.
- **Pulling costs about one round trip.** On a 300 ms link the vehicle-state median is 0.1 s older,
  and under moderate loss its tail is slightly longer (a lost poll waits for a retransmission). At
  15% loss its tail is shorter.
- **Outages freeze both paths equally,** and neither shows errors. In a browser through a radio, a
  20 s outage kept the last values on screen, the connection pill said `reconnecting` from 5 s in,
  and values resumed 1.7 s after the link returned.

## Verification

- Unit tests (`app/src/vstate/*.test.ts*`): protocol encoding and quantization, server deltas,
  held polls, expiry and staleness, client reconciliation and recovery through an in-process
  loopback to a real server, and the Home widgets on the vehicle path.
- Deployment (`tools/test_runtime_image_contract.py`): the overlay, the service key, runtime.json,
  registry images and the pinned replay model, including a real `docker compose config` round trip.
- End to end (`tools/test_vehicle_state.mjs`): real bridges, the bundled service, the publisher
  above, and the browser's own client and TopicStore in Node. It checks heading and position against
  the published truth, that only the requested fields arrive, staleness of a silenced topic, and
  recovery from a service restart, and prints the table above (`MOTION=parked` for the parked rows).

  ```sh
  cd app && npm ci && cd ..
  BRIDGE_BIN=/path/to/zenoh-bridge-remote-api node tools/test_vehicle_state.mjs   # or Docker:
  node tools/test_vehicle_state.mjs                     # BRIDGE_IMAGE=dashboard-zenoh:local, host network
  ```
- Bad links (`tools/test_vehicle_state_link.mjs`, bench only): against a running stack with
  `vehicle_state: true`, it starts two radios and the synthetic publisher, runs each link profile and
  prints the table above. `tools/radio_link.sh` alone shapes the hop for a browser: serve a copy of
  the page whose `ws_port` is a radio's port.

  ```sh
  STATE_KEY=fleet/<vehicle>/dash/<name>/state SIDECAR_PORT=<ws_port> node tools/test_vehicle_state_link.mjs
  ```

## Open items

Phase 1 was built in a cloud session without a Docker daemon or a vehicle. A bench pass on
2026-10-24 (Docker Desktop on an arm64 Mac, host networking enabled, a stand-in Zenoh router)
covered items 1–3:

1. **Image builds — done.** `./dash-up <config> build` with `vehicle_state: true` builds all three
   images; `dashboard-state` typechecks during its build. The stack came up with the private bridge
   on 127.0.0.1 only, `/config/runtime.json` served, and the service logging its keys and per-minute
   summary. A seven-widget Home showed live values in Chromium at about 2.6 KB/s; stopping the IMU
   marked its widgets stale within 8 s.
2. **Docker mode of `tools/test_vehicle_state.mjs` — done.** All checks pass: 54× fewer bytes
   moving, 111× parked. On a Mac, Docker Desktop's host networking must be enabled.
3. **`rig certify --require-build-check` — done.** CI passed on this branch (example config, so
   vehicle state off). Locally, the rig checkout also passed with `vehicle_state: true`, covering
   both state services, the state image's registry rewrite and the loopback port.
4. **On a vehicle — open:** the checklist in TESTING.md, "Vehicle state (on-vehicle acceptance)".
   That includes the laptop-bridge route and a real ROS graph. Types outside the bundled message
   definitions resolve through a node's `~/get_type_description`, on the vehicle as in the browser.

Found and fixed on the bench: after `docker restart dashboard-state`, 1 restart in 12 left some
pages showing `vehicle state: Timeout` for about 9 s. zenoh-ts registers a queryable's handler only
after the bridge acknowledges the declaration and drops, unanswered, a query that arrives first; the
querier then waits out its whole deadline. `app/patches/zenoh-ts.mjs` now registers the handler
first. With it, 25 restarts under 40 polling clients all recovered within 1.2 s.

Observed, not changed: after a service restart, a topic that is silent at that moment loses its last
value and sparkline history in the browser (the new service has never seen it), and the map keeps
showing a heading arrow while the IMU behind it is stale.

A 1.9.0 bridge binary for `BRIDGE_BIN`: crates.io has `zenoh-plugin-remote-api` 1.9.0 but no
`zenoh-bridge-remote-api` 1.9.0. Build the 1.10.1 bridge crate with every `zenoh*` dependency pinned
to `=1.9.0`, or use the `dashboard-zenoh:local` image built from `deploy/Dockerfile.zenoh-remote-api`.

`src/transport/useTransport.test.tsx` failed on `main` in the cloud session (a leftover-timer
assertion); it passes on the bench with Node 26, so it may be timing-sensitive. This branch does not
touch it.

Next: item 4 on a vehicle, then phase 2, starting with the vehicle-kept map trail.
