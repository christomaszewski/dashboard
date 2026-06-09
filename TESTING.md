# Phase-1 bring-up & test

Validates the spine end-to-end against a live camera-service: deploy unit → transport (`zenoh-ts` ↔
remote-api) → stream discovery → WebRTC viewing → raw bus debug (which also surfaces the real rmw_zenoh
keys we need to finish the ROS decode).

## Prereqs (one host — vehicle or bench)

1. **rmw_zenoh router** on `:7447`. Standalone: `ros2 run rmw_zenoh_cpp rmw_zenohd` (rig runs this as
   `infra` in production). Everything below uses host networking → `tcp/localhost:7447`.
2. **camera-service streaming + advertising** — bring it up per its README (`cam-up <config> up -d` with
   the webrtc-bridge; `CAM_ADVERTISE=1` default, `ZENOH_CONNECT=tcp/localhost:7447`). A fake camera is
   fine. Confirm the stream is on the bus *independently of the dashboard* (run from the camera-service
   repo):
   ```sh
   python3 plugins/webrtc-bridge/tools/discovery_probe.py --connect tcp/localhost:7447
   ```
   Expect `EVENT PUT fleet/<veh>/media/<sensor>` + `DESCRIPTOR_OK`.

## Bring up the dashboard sidecar (same host)

```sh
cd dashboard
docker compose -f deploy/docker-compose.yml up --build   # first build: zenoh-bridge-remote-api + web bundle (slow)
#   or: ./dash-up config/infra/dashboard.example.yaml up -d
```
- `dashboard-zenoh` → `ws://<host>:10000` (remote-api), a client of the router.
- `dashboard-web`   → `http://<host>:8080` (the bundle).

> The React bundle is **baked into the `dashboard-web` image** (`deploy/Dockerfile.web`) — `--build`
> produces it locally; `rig build` produces + pushes it. No bundle mount, nothing to vendor.

## Verify (browser on the mesh)

Open `http://<vehicle-ip>:8080`:
1. **status: connected** — transport reached the sidecar.
2. **Camera streams** lists the camera → **Play** → live WebRTC video.
3. **Bus debug** (expand) → **Liveliness** shows the live keyspace: the rmw_zenoh graph tokens + the
   `fleet/.../media/...` discovery token. Read the rmw_zenoh key format here — it's what we need to finish
   `parseRos2Key` + the ROS2 type-description fetch. (The data-subscription box can sample any keyexpr.)

## Fast UI iteration (no rebuild)

Point the Vite dev server at the vehicle's sidecar:
```sh
cd app && VITE_REMOTE_API_LOCATOR=ws/<vehicle-ip>:10000 npm run dev   # http://localhost:5173
```
Serve the page over http so it can open the `ws://` signalling socket (an https page needs `wss`).

## Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| status: **error** | sidecar down / locator unreachable. `docker compose -f deploy/docker-compose.yml logs dashboard-zenoh`; confirm `:10000` reachable and the router is up on `:7447`. |
| **no streams** | producer not advertising, or on a different bus. Re-run `discovery_probe.py`; check the webrtc-bridge logs for `advertising fleet/...`; confirm both use `tcp/localhost:7447`. |
| stream **won't play** | signalling reachability/scheme. The viewer rewrites the signalling host → the vehicle host (`vehicleHost()`), but `:8443` must be reachable from the browser, and an **http page needs a `ws://` signalling URL** (https ⇒ `wss`). Check the browser console. |
| vite **wasm** build/dev error | keep `vite-plugin-wasm` + `vite-plugin-top-level-await` (already in `app/vite.config.ts`). |

## After this passes

The transport + discovery + viewer foundation is proven. Then finish the ROS decode on top of it:
`parseRos2Key` (from the keys observed in Bus debug) → the ROS2 `get_type_description` fetch + CDR decode
(and the ROS1 md5→`full_text` path) → a ROS Explorer panel.
