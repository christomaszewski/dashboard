# dashboard/deploy — Phase 1 transport spine

Optional, additive sidecar that turns the vehicle into a browsable dashboard host. It runs
**alongside** the vehicle's rmw_zenoh router and **does not modify it**.

## What runs

| Service | What | Port |
|---|---|---|
| `dashboard-zenoh` | `zenoh-bridge-remote-api` — a Zenoh **client** of the rmw_zenoh router that exposes a WebSocket for the browser's `zenoh-ts` | `:10000` (ws) |
| `dashboard-web` | Caddy with the React bundle baked in (a built image — `deploy/Dockerfile.web`) | `:8080` (http) |
| `dashboard-rig-agent` (opt-in) | the rig deployment over Zenoh (`docs/RIG_AGENT.md`, `deploy/Dockerfile.rig-agent`): `rig status` snapshots, the run registry, rig verbs as detached jobs. Only with `rig_agent: true` in the instance YAML (`docker-compose.rig-agent.yml` + `docker-compose.rig-data.yml` overlays). | — (peer on `:7447`) |

Connect your laptop to the mesh, then open `http://<vehicle-ip>:8080`. The app talks Zenoh over
`ws://127.0.0.1:10000` when a verified laptop bridge is available, otherwise
`ws://<vehicle-ip>:10000`. See [laptop bridge setup and fallback](../docs/LOCAL_BRIDGE.md), including
browser local-network permissions and the different placement required for native-link rate limits.

## Rig agent (opt-in)

`dash-up` applies the agent overlay when the instance YAML sets `rig_agent: true`. What it mounts
and why (see the comments in `docker-compose.rig-agent.yml`):

- **Identity mounts.** rig hands `docker compose` the launchers' *host* bind paths and the agent
  talks to the *host* daemon through `/var/run/docker.sock`, so the deployment tree (and, for dev
  catalogs with `../sibling` checkouts, the wider `rig_mount:`) is mounted at the **same absolute
  path** inside the container. The tree is read-only; its `var/` is read-write because rig renders
  configs and mints its deployment id there on every verb — and the agent keeps its job records
  under `var/dashboard-rig-agent/` too (no named volume).
- **Runs as the operator on Linux.** `dash-up` passes `$(id -u):$(id -g)` and the docker socket's
  group, so run manifests and rendered configs stay operator-owned (a root-owned
  `var/rendered/*.yaml` would break the operator's next `rig up`). `mkdir -p <root>/var/…` runs
  as the operator before compose can create it as root.
- **Detached jobs.** A verb like `down --end-run` removes the agent's own container mid-verb, so
  jobs run as sibling `docker run` containers from the agent's image with **no compose labels**
  (`compose down` cannot see them); they finish, seal the run, and write their record themselves.
- **`/rig-data/`.** When a `data_dir` is known (`rig_data_dir:` or rig's `RIG_DATA_DIR`), the
  registry is mounted read-write into the agent and read-only into `dashboard-web`, which serves it
  at `/rig-data/` (JSON listings + downloads) for the run browser.
- **The rig tree's own `rig_cli/`** is what the agent runs (`PYTHONPATH=<root>`); the image
  bundles python, PyYAML, the docker CLI + compose plugin and the zenoh binding — no rig.

Security: this is a **new actuation surface** — the socket makes the agent root-equivalent on the
vehicle and its verbs stop the whole stack. Hence opt-in, a fixed verb whitelist with validated
arguments (row names must exist, labels are regex-checked, no free-form argv), a read-only mode
(`rig_actuate: false`), and a `client` tag on every job. A key-scoped sidecar ACL
(`deny` queries on `fleet/*/rig/jobs/**` in `zenohd-dashboard.json5`) blocks verbs without breaking
discovery, unlike the general `deny query` warned about below.

## Run (on the vehicle)

```sh
docker compose -f deploy/docker-compose.yml up --build
```

The first build compiles zenoh from source (slow). Pin `ZENOH_TS_REF` to a release tag for
reproducibility. If/when an official `zenoh-bridge-remote-api` image exists, swap `build:` →
`image:` in `docker-compose.yml`.

## Verify the spine

1. `http://<vehicle-ip>:8080` shows the dashboard (status, Camera streams, Bus debug).
2. Open a `zenoh-ts` session to `ws://<vehicle-ip>:10000` and subscribe to `**` (or `@/**` for
   the admin space) — you should see the vehicle's keys / rmw_zenoh topics flowing.

## Security posture (deliberate)

- **No auth / no ACL** here, by design. The trust boundary is the **mesh**.
- The rmw_zenoh router is **already open/unauthenticated** on the mesh — any node or zenoh
  client that reaches it can publish (incl. `cmd_vel`). The dashboard's remote-api is just
  another client on that same bus; it adds **no new** actuation surface.
- **Do NOT add auth/ACL to the rmw_zenoh router** to "lock down" the dashboard — enabling
  usrpwd there forces every ROS node to authenticate and **breaks the ROS graph**. Actually
  preventing mesh actuation is a separate, deliberate rmw_zenoh hardening project (creds for
  all nodes, or SROS2).
- Optional footgun-guard (stop the *dashboard itself* from publishing): add a `deny put/delete`
  `access_control` rule to `zenohd-dashboard.json5` (the **sidecar**, never the ROS router), and
  verify it intercepts remote-api ops (`session.put(...)` from zenoh-ts → confirm blocked).
  **Scope caveat**: the dashboard's ROS2 service calls are zenoh *queries* (`session.get`), which a
  put/delete rule does not touch — the guard still permits service-based actuation, which is now a
  deliberate dashboard feature (home-tab service buttons). A `deny query` rule would disable them,
  but would ALSO break stream discovery and transient-local topic reads — don't.

## TODO

- Pin `ZENOH_TS_REF` to a release tag (the workspace pulls `zenoh` from git `main`).
- Swap to an official remote-api image if one is published.
