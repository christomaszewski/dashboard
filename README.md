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
Home are opt-in per project from the same YAML (`tabs: [cameras, ros]`). Runs as an optional sidecar next to the
vehicle's rmw_zenoh router; one generic service — projects customize only their instance YAML.

- Transport: browser `zenoh-ts` → `remote-api` (the `dashboard-zenoh` sidecar, a Zenoh **client**
  of the rmw_zenoh router). Bundle served by `dashboard-web` (Caddy), which also serves the
  bind-mounted instance config at `/config/dashboard.yaml` for the Home tab.
- ROS2 service calls run over the same bus as zenoh queries (rmw_zenoh wire format), with dynamic
  type resolution via each node's `~/get_type_description` — vendor srv types need no bundling.
- Camera widgets: `camera` (one tile you drive — its `stream` is a default the tile's picker can
  change, or omitted to pick from discovery) and `cameras` (several feeds: one in focus with a
  carousel of live thumbnails, or a grid — the same deck the Cameras tab uses).
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
- Deploy/architecture details + security rationale: [deploy/README.md](deploy/README.md).

## Run standalone (on the vehicle)

```sh
./dash-up config/infra/dashboard.example.yaml up -d      # or: docker compose -f deploy/docker-compose.yml up
```

Then, from a laptop on the mesh, open `http://<vehicle-ip>:8080`.

**The link is expected to be bad.** Everything but video rides ONE WebSocket from the browser to
the vehicle's sidecar; a spotty wireless hop used to leave the page silently dead (zenoh-ts never
re-dials) and service calls hung forever (a query into a dead socket gets no reply). The app now
reconnects on its own with backoff and re-declares every subscription behind one stable transport
(the pill says `reconnecting`, controls disable, nothing is queued into the void), every query has
a client-side deadline, and a call refused or dropped mid-way fails at once as `disconnected`.
Volume is the other half: cap what reaches the air with `topic_rate_hz` / `topic_rates` in the
instance YAML — dash-up renders them into the sidecar's zenoh config as downsampling rules, scoped
to the ROS domain so lifecycle/playback state and service calls stay untouched.

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
