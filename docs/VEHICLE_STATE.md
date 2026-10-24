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
- `pointcloud`, `ros_image`: better served by vehicle-side decimation and the video path (later).
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

## Open items

Phase 1 was built in a cloud session without a Docker daemon or a vehicle. Not yet verified:

1. **Image builds.** Neither `dashboard-state` nor the overlay has been built by Docker; the
   `Dockerfile.state` steps were replayed by hand on a clean copy of `app/`. With
   `vehicle_state: true` in a copy of the example config, run `./dash-up <config> build`, or
   `tools/build-images.sh <registry>`.
2. **The Docker mode of `tools/test_vehicle_state.mjs`** (`BRIDGE_IMAGE`, host networking). Only
   `BRIDGE_BIN` mode has run.
3. **CI's `rig certify --require-build-check`** against the new image, overlay and `state_ws_port`.
4. **On a vehicle:** the checklist in TESTING.md, "Vehicle state (on-vehicle acceptance)". That
   includes the laptop-bridge route and a real ROS graph. Decoding uses the bundled message
   definitions, as in the browser, so vendor types still need their own decoder.

A 1.9.0 bridge binary for `BRIDGE_BIN`: crates.io has `zenoh-plugin-remote-api` 1.9.0 but no
`zenoh-bridge-remote-api` 1.9.0. Build the 1.10.1 bridge crate with every `zenoh*` dependency pinned
to `=1.9.0`, or use the `dashboard-zenoh:local` image built from `deploy/Dockerfile.zenoh-remote-api`.

`src/transport/useTransport.test.tsx` fails on `main` as well (a leftover-timer assertion); this
branch does not touch it.

Suggested order: items 1–4, then phase 2, starting with the vehicle-kept map trail.
