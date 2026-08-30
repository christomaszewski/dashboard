# vehicle-dashboard

Vehicle operator dashboard — a *vehicle-served*, tabbed web app: a config-driven **Home** tab
(status pills, ROS2 service buttons, live video, topic readouts — laid out per project from the
instance config YAML), a **Cameras** console (WebRTC), a **ROS** explorer (graph + live decode),
and a raw **Bus debug** tab. Runs as an optional sidecar next to the vehicle's rmw_zenoh router;
one generic service — projects customize only their instance YAML.

- Transport: browser `zenoh-ts` → `remote-api` (the `dashboard-zenoh` sidecar, a Zenoh **client**
  of the rmw_zenoh router). Bundle served by `dashboard-web` (Caddy), which also serves the
  bind-mounted instance config at `/config/dashboard.yaml` for the Home tab.
- ROS2 service calls run over the same bus as zenoh queries (rmw_zenoh wire format), with dynamic
  type resolution via each node's `~/get_type_description` — vendor srv types need no bundling.
- Home widget schema: the commented `home:` block in
  [config/infra/dashboard.example.yaml](config/infra/dashboard.example.yaml).
- Deploy/architecture details + security rationale: [deploy/README.md](deploy/README.md).

## Run standalone (on the vehicle)

```sh
./dash-up config/infra/dashboard.example.yaml up -d      # or: docker compose -f deploy/docker-compose.yml up
```

Then, from a laptop on the mesh, open `http://<vehicle-ip>:8080`.

## Orchestrate with `rig`

This repo is rig-compatible (one-way — the repo does not depend on rig):

- [`rigging.yaml`](rigging.yaml) — the descriptor: service `dashboard`, launcher `dash-up`, verb map,
  `host_ports` (clash check), `launch_surface` (vendored/baked), and `build` (run by `rig build`).
- [`dash-up`](dash-up) — the launcher rig drives: `dash-up <config> <verb>`.

The dashboard is a vehicle-wide sidecar that depends on the rmw_zenoh router, so it belongs in `infra:`
(shared services brought up first — after the router — and torn down last), not `sensors:`. Register it
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
deploy/                     # the transport spine (compose + config overlay, Caddyfile, sidecar zenoh config)
app/                        # the React/Vite frontend (see app/README.md for the seam map)
```
