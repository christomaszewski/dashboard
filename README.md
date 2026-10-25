# vehicle-dashboard

Vehicle operator dashboard — a *vehicle-served*, tabbed web app: a config-driven **Home** tab
(status pills, ROS2 service buttons, live video, position map, topic readouts/panels — laid out
per project from the instance config YAML), a **Cameras** console (WebRTC), a **ROS** explorer
(graph + live decode), an optional **Rig** tab (the rig deployment: every row's compose/health/
operational state with standby/activate/up/down, the open run with new-run/end-run, live job
logs, and a run-registry browser with downloads — backed by the vehicle-side `dashboard-rig-agent`,
[docs/RIG_AGENT.md](docs/RIG_AGENT.md)), a **Clouds** point-cloud viewer (vendored from
github.com/christomaszewski/cloud-viewer, lazy-loaded; BPF and LAS, from a drop, a `clouds_dir`, or any
directory of any rig run in the served registry), and a raw **Bus debug** tab. Tabs beyond
Home are opt-in per project from the same YAML (`tabs: [cameras, ros]`). An optional **Logs** tab
shows a selected vehicle container's Docker log tail through the Rig agent (see below).
Runs as an optional sidecar next to the
vehicle's rmw_zenoh router; one generic service — projects customize only their instance YAML.

- Transport: browser `zenoh-ts` → a verified laptop `remote-api` bridge when available, otherwise
  the vehicle's `dashboard-zenoh` sidecar, connected to the rmw_zenoh router.
  Bundle served by `dashboard-web` (Caddy), which also serves the
  bind-mounted instance config at `/config/dashboard.yaml` for the Home tab.
- ROS2 service calls run over the same bus as zenoh queries (rmw_zenoh wire format), with dynamic
  type resolution via each node's `~/get_type_description` — vendor srv types need no bundling.
  Topics use the same resolution for message types outside the bundled definitions.
- Camera widgets: `camera` (one tile you drive — its `stream` is a default the tile's picker can
  change, or omitted to pick from discovery) and `cameras` (several feeds: one in focus with a
  carousel of live thumbnails, or a grid — the same deck the Cameras tab uses).
- Camera recording settings: **Cameras → Recording control** shows the requested encoder, H.264
  quality/speed, segment length, and advanced recording options advertised by camera-service.
  Apply edits before activating; controls lock during recording and transitions. The card shows
  the encoder actually selected on the machine, including fallbacks. Changes use Zenoh
  `…/lifecycle/configure_recording` with a generation/revision check; activation checks that same
  revision. Runtime edits last until the service restarts. Each camera session writes a
  `<prefix>.recording-settings.json` alongside its MKV/CSV files in the run directory, available
  through the Rig run browser. Older camera-service versions keep their existing start/stop UI.
- Service health: a `health` Home widget (and a zero-config **Cameras → Health** card) reads the
  health camera-service publishes on Zenoh (`fleet/<vehicle>/svc/<instance>/health{,/state}`, its
  `docs/HEALTH.md` — ROS-diagnostics-shaped JSON, no ROS involved): per instance a verdict pill
  (OK / WARN / ERROR / STALE, `offline` when its token drops, `silent` when snapshots stop), every
  temperature it reports (`temp.<where>_c`: a GigE camera's GenICam `DeviceTemperature`, a FLIR
  Boson's FPA) with a trend line, and each status that is not OK in the producer's own words.
  Read-only. Thresholds on the widget color the reading; limits that should be recorded with the
  data belong in the sensor config (`health.limits`).
- ROS 3D: `pointcloud` Home widget and opt-in `ros3d` tab show timestamped PointCloud2 overlays
  and accumulated scans through TF. They follow live data or external playback; optional central
  controls use a separate `rosbag_playback` widget. See [docs/ROS_3D.md](docs/ROS_3D.md).
- Bag recorders: `bag_recorders` lists every rosbag2 recorder on the graph (found by its own
  `…/pause` + `…/is_paused` services, one per bag_logger namespace) with a recording/paused pill
  and pause / resume / split / snapshot over the recorder's own services — writing control only;
  where a bag session starts and ends stays rig's call.
- Services: `service_button` (one click, fixed request) and `services` (several services with
  server status, a request form built from the live type — nested messages as JSON — and the
  response kept on the row).
- Home widget schema: the commented `home:` block in
  [config/infra/dashboard.example.yaml](config/infra/dashboard.example.yaml) — status pills,
  service buttons, video, map, lifecycle control, readouts (one field, or a `format:` line
  interpolating several fields of one message), gauges, sparklines, rule-driven
  indicators, notes, grouped panels. Projects can add their own widget types in React
  ([app/src/extensions/README.md](app/src/extensions/README.md)) — compiled into the image,
  registered through the same registry as the built-ins.
- Rig control: `rig_agent: true` in the instance YAML adds the `dashboard-rig-agent` service
  ([agent/](agent/README.md)) — rig is a one-shot CLI, this is its daemon half, speaking the
  generic contract in [docs/RIG_AGENT.md](docs/RIG_AGENT.md) (`fleet/<vid>/rig/…`). Opt-in: it
  holds the vehicle's docker socket.
- Vehicle state: `vehicle_state: true` keeps ROS traffic on the vehicle. A small `dashboard-state`
  service projects each Home widget's fields there and sends only changes, one held poll at a time,
  so a slow link skips stale values instead of queueing them ([docs/VEHICLE_STATE.md](docs/VEHICLE_STATE.md)).
- Deploy/architecture details + security rationale: [deploy/README.md](deploy/README.md).

## Run standalone (on the vehicle)

```sh
./dash-up config/infra/dashboard.example.yaml up -d      # or: docker compose -f deploy/docker-compose.yml up
```

Then, from a laptop on the mesh, open `http://<vehicle-ip>:8080`.

**The link is expected to be bad.** Zenoh traffic rides one selected WebSocket: preferably to a
laptop bridge on `127.0.0.1:10000`, otherwise to the vehicle's sidecar. The laptop route must prove
it reaches this vehicle before selection and during heartbeats; a lost native uplink triggers
vehicle fallback. See [laptop setup, browser requirements, and configuration](docs/LOCAL_BRIDGE.md).
A spotty wireless hop used to leave the page silently dead (zenoh-ts never
re-dials) and service calls hung forever (a query into a dead socket gets no reply). The app now
reconnects on its own with backoff and re-declares every subscription behind one stable transport
(the pill says `reconnecting`, controls disable, nothing is queued into the void), every query has
a client-side deadline, and a call refused or dropped mid-way fails at once as `disconnected`.
Volume is the other half: cap heavy topics before the air with per-topic `topic_rates` in the
instance YAML — dash-up renders them into the sidecar's zenoh config as downsampling rules, scoped
to the ROS domain so lifecycle/playback state and service calls stay untouched. These sidecar rules
apply to the direct WebSocket path; a laptop bridge connected to the router needs rate limits on
the vehicle before its native wireless link. Better still, `vehicle_state: true` keeps the raw
topics on the vehicle for Home widgets on either path ([docs/VEHICLE_STATE.md](docs/VEHICLE_STATE.md)).
What the dashboard does about each part of a bad link (reloading offline, a bounded bridge queue,
unknown call outcomes) and how to rehearse one on the bench: [docs/SPOTTY_LINK.md](docs/SPOTTY_LINK.md).

## Orchestrate with `rig`

This repo is rig-compatible (one-way — the repo does not depend on rig):

- [`rigging.yaml`](rigging.yaml) — the descriptor: service `dashboard`, launcher `dash-up`, verb map,
  `host_ports` (clash check), `launch_surface` (vendored/baked), and `build` (run by `rig build`).
- [`dash-up`](dash-up) — the launcher rig drives: `dash-up <config> <verb>`.

The dashboard is a vehicle-wide sidecar that depends on the rmw_zenoh router, so it belongs in `infra:`
(shared services brought up first — after the router — and torn down last), not `sensors:`. Its
`rigging.yaml` declares `tier: infra`, so `rig add dashboard` places the row there for you. Register it
in your rig checkout:

```yaml
# bringup/services.yaml          (catalog: service -> repo)
services:
  dashboard: { path: ../dashboard }

# bringup/vehicle.yaml           (infra = shared, vehicle-wide services)
infra:
  - { name: zenoh-router, service: zenoh-router, config: config/infra/zenoh-router.yaml, order: 0 }
  - { name: dashboard,    service: dashboard,    config: config/infra/dashboard.yaml,    order: 5 }
```

Then `rig up|down|status|logs dashboard`. Fleet deploy:
`rig build --registry devbox:5000` (builds+pushes via `build:`, copies `mirror:` images in) →
`rig bake --registry devbox:5000` (digest-pins) → ship → on the Orin `rig unbake` + `rig up`. `rig`
injects `RIG_IMAGE_REGISTRY`; `dash-up` resolves images to `<registry>/dashboard-zenoh:<tag>` and runs
`pull` + `up` (no build/source on the vehicle).

For replay, `dash-up <config> runtime-images` returns the version-1 JSON inventory of the
resolved Compose stack; `images` returns the same image references as a YAML list. Both queries
are read-only, honor registry and per-image overrides, and include `dashboard-rig-agent` only
when the agent is enabled and its deployment root resolves. They validate topic rate limits
without generating config or state directories.

Rig supplies `RIG_RUNTIME_IMAGE_PINS` for replay `up`: the launcher requires an exact map of the
active references to full `sha256:` image IDs, honors native `RIG_TARGET_ARCH`, and starts that
frozen Compose model with building and pulling disabled. The agent's detached jobs use its
pinned image too. Replay rejects platform mismatches, changed image selections and extra image
policy/service-selection flags. Standalone launches without pins retain normal Compose behavior.
Update the dashboard launcher package in existing deployments to use this contract; no dashboard
image rebuild is required for the launcher change alone.

## Layout

```
dash-up                     # rig launcher (verb passthrough to docker compose)
rigging.yaml                # rig descriptor
config/infra/dashboard.example.yaml
tools/dash_env.py           # config -> DASH_* env for dash-up
tools/build-images.sh       # build + push images to the fleet registry
deploy/                     # the transport spine (compose + overlays, Caddyfile, sidecar zenoh config, Dockerfiles)
agent/                      # dashboard-rig-agent (python): the rig deployment over zenoh (docs/RIG_AGENT.md)
docs/RIG_AGENT.md           # the rig-over-zenoh contract (generic; the agent is its reference producer)
app/                        # the React/Vite frontend (see app/README.md for the seam map)
```

## Docker logs

Add `logs` to the dashboard YAML's tabs and enable the vehicle agent:

```yaml
rig_agent: true
rig_actuate: false
tabs: [logs]             # Home + Rig + Logs; preserve any other tabs you already use
```

To show Logs without Rig, use `tabs: { logs: true, rig: false }`. Rebuild/redeploy both
`dashboard-web` and `dashboard-rig-agent`, then bring up the dashboard with the updated YAML.
The agent uses the same deployment-tree and Docker-socket mounts as the Rig tab; no new port or
browser access to Docker is needed. Existing agent images show an upgrade message in Logs.

Choose a container by name or its Compose project/service. All containers on the agent's Docker
host are listed, including stopped containers; service replicas are separate choices. If multiple
vehicles advertise, choose the vehicle first. The selected container's timestamped stdout/stderr
tail refreshes two seconds after each completed query. Choose 100, 200, or 500 lines, pause/resume
updates, or turn off auto-scroll to inspect a line. Each snapshot is capped at 64 KiB; this is a
rolling tail, so busy containers can produce more lines between refreshes than the viewer retains.
It is not a log archive. The inventory refreshes every ten seconds and can be refreshed manually.

Polling stops while Logs or the browser tab is hidden, or the connection is lost. Cached output is
labeled on disconnect/error; reconnect fetches a fresh tail. Removed containers require selecting
their replacement. Docker permission errors and unsupported logging drivers appear in the viewer.
Log access works with `rig_actuate: false` and follows the existing trusted-mesh access model.

## Preflight strip

Add `type: preflight` as the first Home widget for a thin, full-width readiness strip. It is
opt-in per dashboard YAML. Groups and checks appear in the configured order; `display: dots`
hides pill labels while retaining accessible names and hover/focus/tap tooltips.

```yaml
home:
  version: 1
  widgets:
    - type: preflight
      span: full
      recording_controls: true
      groups:
        - label: Services
          checks:
            - { type: health, service: ouster, label: Lidar }
            - { type: health, service: ins, label: Navigation }
        - label: Logging
          checks:
            - { type: bag_recording, recorder: /bag_logger/rosbag2_recorder, label: ROS bag, domain_id: 0 }
            - { type: camera_recording, service: cam0, label: Front }
        - label: Readiness
          checks:
            - { type: ros_service, service: /ouster/get_config, label: Lidar config, domain_id: 0 }
```

With a named grid layout, add a full-width `preflight` row to `home.layout.areas` and assign
`area: preflight` instead. The strip wraps on narrow screens.

- **Health:** shared native/ROS diagnostics; green for current OK, yellow for warnings or
  incomplete observations, red for errors, missing reports, or expired observations. Optional
  `components: [gps, imu]` limits a check to exact diagnostic component names. Missing selected
  components stay red. Use actual instance/component names from the Health view.
- **Camera recording:** shared camera health's `stream` and `recording` components, plus camera
  diagnostics when present. Green requires an active recording with recorded frames and current
  healthy capture. Inactive, disabled, or still starting is yellow; faults/stalls/silence are red.
- **Bag recording:** a read-only `is_paused` query every `poll_s` seconds (default 3, minimum 0.5),
  scheduled after the previous query completes, with a 2-second deadline. Unpaused is green,
  paused is yellow, missing/invalid/nonresponsive is red. Bag players are excluded. Unpaused
  does not prove disk throughput. Polling stops while Home is hidden or disconnected.
- **ROS service:** green when a server is advertised in the selected domain, red when absent.
  No service is called by this check; advertised presence does not prove the server can respond.

Health/camera references accept `instance`, `vehicle/instance`, or a full health key. Ambiguous
references or ROS domains require an explicit selection and show red. A disconnected dashboard
shows red rather than retaining green from an earlier observation. Tooltips explain the reason.

Set `recording_controls: true` to add compact **Record all** (●) and **Stop recording** (■) icon
buttons. Their labels appear on hover and are available to screen readers. The default is false.
Targets come only from this widget's `bag_recording` and
`camera_recording` checks, across all groups; repeated checks resolving to the same recorder
receive one command. Health and ROS availability checks are never commanded. Missing, offline,
disabled, ambiguous, and unsupported targets remain visible as failures rather than disappearing.

Commands run independently: bags resume/pause and verify `is_paused`; cameras activate/deactivate
through their lifecycle control, preserving the recording-settings revision guard. The existing
preflight dots show recording status; controls add no counts, success messages, or expanding rows.
A small **!** appears only if a command fails or camera finalization reports trouble. Click it for
an overlay containing only the issues and **Retry failed**, which retries only failed targets for
the last action. Successful targets keep their state; nothing is automatically retried on reconnect.
Finalization warnings remain available there (retrying cannot repair a truncated file).

Stopping pauses the existing bag session and finalizes each camera session while keeping camera
preview running. Starting resumes bags and opens camera sessions; it does not create a Rig run or
guarantee synchronized start times. For standby at boot, set bag `control.start_paused: true` and
camera `control.initial_state: inactive`, with camera `recording.enabled: true`.

Omitting `groups` gives one Services group containing every discovered health reporter. A
`{ type: health }` check also expands to all reporters inside a custom group. Explicit service
references are recommended for required equipment: discovery cannot identify a service that
has never appeared. The existing health store retains reporters that go offline during a session.

## ROS image previews

Use `type: ros_image` on Home to display `sensor_msgs/msg/Image` directly over Zenoh.
For Ouster, start with `/ouster/nearir_image`; `/ouster/reflec_image`, `/ouster/signal_image`
and `/ouster/range_image` are alternate views. The driver's `IMG` processor publishes
destaggered `mono16` panoramas. The existing Cameras widget continues to use WebRTC feeds.

```yaml
- type: ros_image
  label: Ouster panorama
  topic: /ouster/nearir_image
  topics: [/ouster/nearir_image, /ouster/reflec_image, /ouster/signal_image, /ouster/range_image]
  normalize: true
  stale_after_s: 3
```

The picker subscribes to one topic at a time; ambiguous ROS domains require a choice or
`domain_id`. Auto contrast changes only grayscale display brightness. Native aspect ratio,
row padding and pixel byte order are preserved. Silence and disconnection label the last
frame; changing topics clears it. Hidden Home views release their subscriptions.

Watched ROS topics also announce a ROS subscriber, including CPU buffer support when advertised
by the publisher. Lyrical `rmw_zenoh` image publishers need this announcement to start CPU delivery;
a plain Zenoh data subscription is insufficient. If Ouster images appear only after running
`ros2 topic echo` on each topic, rebuild/redeploy `dashboard-web` and reload the page. Affected
middleware versions can retain departed subscriber state, explaining why delivery may continue
after echo exits; see the [upstream investigation](https://github.com/ros2/rmw_zenoh/issues/1075).

Supported encodings: `mono8`, `mono16`, `8UC1`, `16UC1`, `rgb8`, `bgr8`, `rgba8`, `bgra8`.
Frames are limited to 2 megapixels / 16 MiB. The shared topic store renders at most 5 Hz;
this does not reduce network traffic. Use vehicle-side per-topic rate limits for slow links.
CompressedImage and other pixel encodings are reported as unsupported, not guessed.
See the [complete example](config/infra/dashboard.example.yaml) for every option.

## Sensor and service health

Enable `tabs: [home, health]` for the Health tab; add a Home widget with `type: health` for
a compact overview. Both consume native service health and standard ROS 2 DiagnosticArray
messages discovered through Zenoh. They show temperature and electrical telemetry, faults,
observation age and recent events. Offline observations remain visible for the session;
Rig inventory also identifies services that have not reported health.

The Home widget auto-populates by default. Use its **All reporters** picker to choose a
subset; choices are remembered in this browser. Issue pills open details on hover, keyboard
focus, or tap. Temperature/power readings include units, trends, and explicit last-known
labels during outages. The Health tab provides attention-first sorting, issue search,
expandable components, and session events.

When reported, the compact summary also shows **GNSS fix**, **satellites used**, **EKF state**,
and dual-antenna **heading validity** beside temperature. These read `gnss.fix_type`,
`gnss.sv_used`, `ekf.solution_mode`, and `gnss.heading_valid` from existing diagnostics;
no widget configuration or extra subscriptions are needed. ROS string values and native
numeric/boolean values are supported. Each indicator follows its own component's freshness
and producer severity; cached values are dimmed and labeled last known, while existing
warning/error pills remain visible. Missing fields and explicitly unsupported metrics are
omitted; null or invalid values display an unavailable dash, and zero satellites remains zero.

Doodle radio diagnostics add **TX power** in dBm, **Target** (for example, `low (23 dBm)`),
and **RF state** to both views. The `radio` component supplies `rf.tx_power_dbm` and
`rf.state`; the `service` component supplies `rf.target` and `rf.target_dbm`. If only the
service component is present, its observed power/state are used. RF off shows a dash for
TX power, missing readings stay unavailable, and retrying/stale/offline observations are
marked last known independently of the target. These are radio-reported settings, not
measurements of radiated power. No extra topic or widget configuration is needed.

```yaml
- type: health
  label: Sensors
  # services: [vehicle/cam_front, vehicle/top]  # optional initial selection
  # lock: true        # enforce that selection and hide the picker
  # details: true     # expand component details initially
  history_s: 300      # 0 disables trends
```

Give independent widgets distinct labels. Omit `services` for discovery; the picker can
restore automatic discovery at any time. Changing the YAML list resets its saved selection.

The [shared health specification](docs/SERVICE_HEALTH.md) defines producer adoption, ROS
identity metadata, topic/domain filters, configuration and validation. ROS health traffic
must reach the dashboard's router; the browser does not connect to sensor HTTP endpoints.
