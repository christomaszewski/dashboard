# dashboard/deploy — Phase 1 transport spine

Optional, additive sidecar that turns the vehicle into a browsable dashboard host. It runs
**alongside** the vehicle's rmw_zenoh router and **does not modify it**.

## What runs

| Service | What | Port |
|---|---|---|
| `dashboard-zenoh` | `zenoh-bridge-remote-api` — a Zenoh **client** of the rmw_zenoh router that exposes a WebSocket for the browser's `zenoh-ts` | `:10000` (ws) |
| `dashboard-web` | Caddy with the React bundle baked in (a built image — `deploy/Dockerfile.web`) | `:8080` (http) |

Connect your laptop to the mesh, then open `http://<vehicle-ip>:8080`. The app talks Zenoh over
`ws://<vehicle-ip>:10000`.

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

## TODO

- Pin `ZENOH_TS_REF` to a release tag (the workspace pulls `zenoh` from git `main`).
- Swap to an official remote-api image if one is published.
