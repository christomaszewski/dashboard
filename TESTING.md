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

Open `http://<vehicle-ip>:8080`. The app is tabbed (Home / Cameras / ROS / Bus debug, hash-routed —
`#/ros` deep-links); all tabs stay mounted, so switching never drops video or subscriptions:
1. **status: connected** (topbar) — transport reached the sidecar.
2. **Home** with no config mounted = the built-in default (connection, discovered-stream and graph
   summaries, config hint). With a `home:` block mounted, the configured widgets render — a
   deliberately malformed widget must show an inline error card while the rest render.
3. **Cameras** lists discovered streams in the rail → click one to subscribe → live WebRTC video.
   Maximize (⤢) focuses a feed full-width with the others as live thumbnails (click to swap, Esc/⤡
   back to grid, ←/→ cycle). Subscriptions persist across reloads (localStorage).
4. **ROS** shows the vehicle's nodes/topics/services (from `@ros2_lv` liveliness) with QoS
   chips. Click a topic → live decoded messages + Hz/bytes. To prove decode without sensors flowing,
   pub from any ROS container on the vehicle:
   `ros2 topic pub -w 0 -r 5 /dash_test std_msgs/msg/String "{data: hello}"` → topic appears in the
   graph, click → `data: "hello"` at ~5 Hz. (Camera `image_raw*` topics are image_transport-gated —
   they publish only with a matching *ROS* subscriber, so "no data yet" there is expected.)
5. **Clouds** (lazy — its chunk loads on first click): drag & drop a `.bpf` onto the tab (drops on
   other tabs must do nothing), or set `clouds_dir:` in the instance YAML → the tab lists the
   vehicle's `/clouds/` files. Orbit/color/size/ortho/view controls; switching tabs and back keeps
   the loaded cloud (no re-parse). `?cloud=<url>` deep-loads one.
6. **Map widget** (`type: map` on Home): with an internet-connected browser the OSM default shows
   tiles (fetched by the BROWSER — the vehicle serves nothing); marker + trail appear on the first
   fix from the configured topic and "waiting for fix…" before it. Offline operator PC: serve a
   z/x/y tile tree locally (`python3 -m http.server 8000` → `tiles: http://localhost:8000/...`).
   Tab away/back must re-render the map full-size (no gray half-tiles). Panning pauses follow;
   ⌖ resumes.
7. **Tabs config**: `tabs: { debug: false }` removes the tab and `#/debug` falls back to the first
   visible tab.
8. **Bus debug** → **Liveliness** shows the raw keyspace: the rmw_zenoh graph tokens + the
   `fleet/.../media/...` discovery token. The data-subscription box can sample any keyexpr; its
   **attachment** column decodes each sample's rmw attachment (`rmw ✓ seq N` = the service-call
   wire format is confirmed against live traffic; `⚠` = the attachment layout assumption is wrong).

## Home tab / config delivery

- **Vehicle-served**: `dash-up <config> up -d` bind-mounts the instance YAML into `dashboard-web`;
  the app fetches it at `/config/dashboard.yaml`. Edit the YAML on the host, then
  `docker compose restart dashboard-web` (single-file binds track the inode — rename-on-save
  editors need the restart) and refresh the page.
- **Dev**: drop a config at `app/public/config/dashboard.yaml` (gitignored — never commit; it would
  bake into `dist`) and `npm run dev`. Widget schema reference: the commented `home:` block in
  `config/infra/dashboard.example.yaml` — including the `layout:` grid (named areas + `area:` per
  widget) and `panel` widgets (grouped readout rows with `name:`/`unit:`, statuses, buttons).
- Layout checks: widget placement matches the `areas:` ASCII grid; a bogus/duplicate `area:` shows
  a ⚠ line on its cell and auto-flows; an invalid `areas:` block shows one warning banner and the
  page auto-flows; narrow window (<560px) collapses to one column. All topic rows/widgets on one
  topic share a single bus subscription (Bus debug or the sidecar logs confirm).
- `curl -i http://<vehicle-ip>:8080/config/dashboard.yaml` → 200 with the YAML when mounted, and a
  clean **404** (not index.html) when not — the app's "no config → default Home" signal.
- **dash_env.py acceptance** (any config with a `home:` block): run
  `python3 tools/dash_env.py <config>` twice — once normally, once with PyYAML blocked
  (`python3 -c "import sys,builtins; r=builtins.__import__; builtins.__import__=lambda n,*a,**k: (_ for _ in ()).throw(ModuleNotFoundError(n)) if n=='yaml' else r(n,*a,**k); sys.argv=['x','<config>']; exec(open('tools/dash_env.py').read())"`)
  — the three `DASH_*` lines must be identical and junk-free (nested keys must not leak).

## Service calls / shared sessions (on-vehicle acceptance)

1. **Attachment wire format** (highest-risk assumption): Bus debug → subscribe `**` while any topic
   publishes → the attachment column must show `rmw ✓ seq N`. If it shows `⚠`, fix
   `app/src/services/attachment.ts` against the vehicle's `rmw_zenoh` version before trusting calls.
2. **Bundled-type call**: a `service_button` for any `std_srvs/srv/Trigger` service → click → the
   button flashes the response (`success — ...`). `timeout: ...` against a stopped server.
3. **Dynamic typing**: `ros2 service list | grep get_type_description` (Jazzy nodes serve it per
   node); a `service_button` for a vendor-typed service must resolve + call with no bundled schema.
4. **Shared sessions**: put the same camera on Home (`type: video`) and subscribe it in Cameras →
   `chrome://webrtc-internals` shows **one** peer connection for that camera. Switch tabs during
   playback → no renegotiation events. Producer restart → tile goes offline → auto-resumes. Freeze
   the producer (SIGSTOP) → recovery within ~15 s of unfreeze.

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

Transport + discovery + viewer + ROS explorer/decode are proven (decode = bundled common-interface
defs; verified live against a lyrical vehicle 2026-06-09), plus the tabbed shell, the config-driven
Home tab, shared WebRTC sessions, and ROS2 service calls over zenoh with dynamic
`get_type_description` typing (wire-format assumptions carry the on-vehicle acceptance list above).
Next: telemetry plots/GNSS map as new tabs on top of the decoded streams, wiring the same dynamic
type resolution into topic decode (FlavorResolver backend), and the camera-side fixes (H.264
level/profile redeploy; per-camera `sensor_id` so both cameras advertise).
