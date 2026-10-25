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
   `{ v: 1, view, epoch, fresh: 1 }`. The view id is a hash of the canonical spec: identical layouts
   from several operators share one view, and re-registering is idempotent.
2. **Poll** — `get B/poll`, payload `{ v: 1, view, epoch, since, fresh? }`. The reply carries the
   current state of every item that changed after update number `since`. `since: 0` (or a different
   epoch) returns every item: the snapshot path and the delta path are the same code. When nothing
   has changed the vehicle holds the query until something does, or for 2 s as a heartbeat. The
   browser sends its next poll when the reply lands, at most every 200 ms.
3. **View changes** — when a widget appears or goes away the browser registers the new set but keeps
   its `since`, and lists in `fresh` the view indices of the items it has no state for. Those come
   whole and at once; the rest stay changes. The previous view still holds the shared items on the
   vehicle, so their trails and histories continue. A vehicle without `fresh: 1` in its register
   reply, a new epoch, or an `unknown-view` reply makes the browser start over with `since: 0`.

```ts
ItemSpec  = {                                   // exactly one of topic, node, health
  topic?: string; fields?: { p: string; q?: number }[]; hz?: boolean; window_ms?: number;
  trail?: number;                               // keep this many positions (lat, lon = fields 0, 1)
  series?: { window_ms: number; bucket_ms: number };  // keep a history of field 0
  node?: string;                                // is this node in the vehicle's ROS graph
  health?: string;                              // "*" = the health service keys; else one service
}
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
  // Computed per reply for what this caller lacks (its `since`):
  tr?: { i: number; p: [lat, lon][] };       // trail points from absolute index i
  hs?: [index, ageMs, min, max, last][];     // changed history buckets
  a?: 0 | 1;               // node items: present in the vehicle's graph
  hk?: string[];           // health "*": the service keys
  hd?: HealthWire;         // one health service, with ages instead of timestamps
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
state (larger values become an item error naming the limit), 64 live views, 5000 points per trail,
600 buckets per history. A view nobody has
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
- **On a Jetson AGX Orin** (MAXN, Cortex-A78AE at 2.2 GHz) the same work costs about ten times as
  much CPU as on Apple silicon. The bench Home, with those three image widgets at 5, 2 and 2 frames
  a second and eleven other widgets, held `dashboard-state` at 72–95% of one of its 12 cores and
  43–67 MB. Per frame, on one core:

  | Work | CPU |
  |---|---|
  | Receive a 640×480 `rgb8` camera at 15 Hz (13.8 MB/s), before any encode | ~13% of a core |
  | 640×480 `rgb8` → JPEG | 20 ms |
  | 640×480 `rgb8` → WebP | 90 ms |
  | 1280×720 JPEG → 480 wide, JPEG or WebP | 50–60 ms |

  Prefer the default JPEG on Jetson-class CPUs, keep `max_hz` modest, and size `max_width` to the
  tile. Encodes are shared: more operators on the same widget settings cost nothing extra.

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

### Trails and histories

A map trail and a sparkline's line used to be built in the browser from the values it received, so
every reload or reconnect started them empty. The vehicle now keeps them:

- **Map trails.** A map position item asks for `trail: N` (the map's `trail`, default 500, at most
  5000). The vehicle appends a point whenever the rounded position changes and numbers the points
  with the update that added them. A poll carries only the points after the caller's `since`; a
  reload gets the whole trail in its first reply.
- **Sparkline history.** A sparkline item asks for `series` over its window (`window_s`, default
  60 s) in buckets of window/240, at least 100 ms. Each bucket holds the min, max and last value of
  the first field; only changed buckets travel, with their age at reply time so the browser places
  them on its own clock. The line draws each bucket's spread.

Bench, 30 s after a reload in Chromium: the map trail came back whole in the first reply (150
points), then one point a reply; a heave sparkline showed the same 290-segment line before and
after the reload.

### Health and node status

- **Node status** (`status` with `source: node`) asks the vehicle whether the node is in its own ROS
  graph: one `a: 0|1` item instead of the browser's graph subscription.
- **Health.** The vehicle runs the health discovery (camera-service health keys and every
  `/diagnostics` subscription) while some page watches it. A `health: "*"` item lists the service
  keys; one item per service carries it as the vehicle assembled it, sent again only when it
  changes, with ages instead of timestamps. The browser mirrors these into its own health discovery,
  so the Health tab, Home health widgets, preflight health checks, events and staleness work
  unchanged, and the instance's `health:` filters apply.

### The browser's ROS graph

The browser subscribes to the whole ROS graph (`@ros2_lv/**`) only while a visible view needs it,
and keeps it 30 s after the last one goes. With vehicle state, Home never does: widgets that need
a few graph entities ask for just those with one-shot liveliness queries, refreshed every 15 s while
visible.

| Widget | Query |
|---|---|
| `service_button`, `services`, preflight `ros_service` | the service's servers, plus their node's services (vendor type descriptions) |
| `bag_recorders`, preflight `bag_recording`, recording controls | the recorder's services |
| `ros_image` topic picker | image and compressed-image publishers, by type |

The ROS tab and the 3D view open the full graph when shown.

## Configuration

```yaml
vehicle_state: true        # start dashboard-state + its private bridge; Home widgets use it
# vehicle_id: rover-3      # default: the vehicle host's short hostname
# state_ws_port: 10001     # the private bridge's loopback WebSocket port
```

Per widget: `vehicle_state: false` keeps that widget (or panel item) on the direct path.

## What stays direct

- ROS explorer, topic inspector, 3D view and bus debug: debugging tools that need raw messages (and,
  for the first three, the whole graph).
- Service calls and lifecycle/playback/rig control: already small request/response traffic. On a
  bad link they report an unknown outcome instead of guessing ([SPOTTY_LINK.md](SPOTTY_LINK.md)).
- `pointcloud`: better served by vehicle-side decimation (later). `ros_image` uses vehicle frames
  (see [Images](#images)); a widget with `vehicle_state: false` stays direct.

## Phases

1. **Done.** The service and protocol; `topic_value`, panel readouts, `gauge`, `sparkline`,
   `indicator`, `status` (topic rate) and `map` position/heading on vehicle state; vehicle frames
   for `ros_image`; deployment, rig integration and tests.
2. **Done.** A vehicle-kept map trail (sent once, then appended), min/max sparkline history, health
   and node status from the vehicle, a lazy browser graph so Home never pulls `@ros2_lv/**`, and
   view changes that resend only the new items.
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
  loopback to a real server, trails, histories, node and health items, view changes, and the Home
  widgets on the vehicle path. `app/src/shell/Shell.test.tsx` and
  `app/src/ros/RosGraphContext.test.tsx` cover when the browser's graph is open.
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

Phase 1 was built in a cloud session without a Docker daemon or a vehicle. Bench passes on
2026-10-24 (Docker Desktop on an arm64 Mac) covered everything short of the vehicle:

1. **Image builds — done.** `./dash-up <config> build` with `vehicle_state: true` builds all images;
   `dashboard-state` typechecks during its build and installs the pinned `sharp`.
2. **Docker mode of `tools/test_vehicle_state.mjs` — done.** 54× fewer bytes moving, 111× parked. On a
   Mac, Docker Desktop's host networking must be enabled.
3. **`rig certify --require-build-check` — done**, in CI (example config) and locally with
   `vehicle_state: true`.
4. **On a vehicle — open:** TESTING.md, "Vehicle state (on-vehicle acceptance)".

What the bench exercised beyond that, against a real `rmw_zenohd` and an rclpy node (Lyrical,
ROS domain 1) from the fleet message image:

- **Vendor types:** `sbg_msgs` topics decode through the publisher's `~/get_type_description`, on
  the vehicle and in the browser, within ~1.3 s — the same call service buttons use, so this also
  exercised the rmw_zenoh service wire format.
- **Images:** a 640×480 `rgb8` camera, a 1024×64 `mono16` range image and a 1280×720 JPEG stream as
  vehicle frames (see [Images](#images)), in Chromium and over simulated radios.
- **Faults** (each with a page-like client watching): public sidecar restart — values kept, back in
  1.5 s; private bridge restart — 1.3 s; bridge down 15 s — 2.1 s after it returns; service restart
  — under 1.2 s across 25 restarts × 40 clients; router restart or outage — no visible effect, as the
  bridges also hold direct links to rmw_zenoh peers; publisher restart — none.
- **Laptop bridge** (`--mode client`): Home and frames work through it; cutting its radio kept values
  without errors, and the page failed over to the vehicle sidecar 6 s in.
- **Soak:** 20 min over 1 Mbit/s with 3% loss and a 5 s outage every minute, four state clients and
  two image streams, three service restarts: no widget or frame errors, values under 2 s old in 88% of
  samples, `dashboard-state` at 46–80 MB without a trend.
- **Jetson AGX Orin** (2026-10-25): the same images and bench publisher on an Orin, the browser on
  a Mac across the LAN. Every phase 2 check below passed there too; image costs are under
  [Images](#images).
- **Phase 2** (2026-10-25, Chromium against the same bench): the map trail and a sparkline history
  came back whole after a reload; a health widget showed a `/diagnostics` reporter's level and
  temperature through the vehicle; node status and a service button (`list_parameters`) worked; Home
  sent only the narrow liveliness queries above, each matching exactly the tokens the full graph has
  for that entity, and the ROS tab opened the full graph on first view.

Found and fixed on the way: a zenoh-ts race that left some pages on `vehicle state: Timeout` for ~9 s
after a service restart (handlers now registered before their declaration); every widget flashing
`WebSocket is closed` on a sidecar restart; ~12 s of `service not reachable` after a private-bridge
restart; silent topics going blank after a service restart (now held, stale); error flashes during
1–2 s gaps (a 3 s grace); a stale IMU still drawing a heading.

Known limits, not changed here:

- A direct view of a heavy topic over a weak link still shows little: the bridge's bounded sample
  lane drops the oldest samples instead of queueing them ([SPOTTY_LINK.md](SPOTTY_LINK.md)), and
  `bridge_mem_limit` (default 512m) stays as a backstop. Use vehicle frames, or `topic_rates`.
- Health trend lines (temperatures) are kept in the browser, so they restart on a reload; the
  current values and levels come back at once.
- `topic_rate_hz` was removed: zenoh keeps one budget per rule, so a domain-wide cap starved slow
  topics. dash-up refuses it and points to per-topic `topic_rates`.
- The private bridge grew ~3–4 MB per `dashboard-state` restart in the soak (per-client state in the
  plugin); a bridge restart clears it.
- Image rates read on the vehicle are true rates; there is no image ingest cap (zenoh's per-rule
  budget would starve the slower cameras).

A 1.9.0 bridge binary for `BRIDGE_BIN`: crates.io has `zenoh-plugin-remote-api` 1.9.0 but no
`zenoh-bridge-remote-api` 1.9.0. Build the 1.10.1 bridge crate with every `zenoh*` dependency pinned
to `=1.9.0`, or use the `dashboard-zenoh:local` image built from `deploy/Dockerfile.zenoh-remote-api`.

Next: item 4 on a vehicle, including the phase 2 checks in TESTING.md.
