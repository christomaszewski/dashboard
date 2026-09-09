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

## Unit + component tests (no vehicle)

`cd app && npx vitest run` — 43 files. Pure logic (schema, discovery, the stream pool, playback
control, ROS graph parsing) runs in node; the **component tests** (`src/**/*.test.tsx`: the tab bar,
tile controls, the playback card, the `camera` / `cameras` / `bag_recorders` / `services` widgets, the Cameras
console) opt into
jsdom per file (`// @vitest-environment jsdom`) and render through `src/test/harness.tsx`: the
app's contexts provided with plain values around a REAL `StreamSessionPool` with fake sources, so a
tile's acquire/attach/release runs for real and only media negotiation is stubbed. `npx tsc
--noEmit -p .` typechecks tests too.

## Verify (browser on the mesh)

Open `http://<vehicle-ip>:8080`. The app is tabbed (Home / Cameras / ROS / Rig / Clouds / Bus debug,
hash-routed — `#/ros` deep-links). Tabs beyond Home are OPT-IN — `tabs: [cameras, ros, clouds, debug]`
in the instance YAML; Rig comes with `rig_agent: true` — and all opted-in tabs stay mounted, so
switching never drops video or subscriptions:
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
5. **Clouds** (lazy — its chunk loads on first click): drag & drop a `.bpf` or `.las` onto the tab
   (drops on other tabs must do nothing), or set `clouds_dir:` in the instance YAML → the tab lists
   the vehicle's `/clouds/` files. **Runs…** (and the idle overlay) browses the rig run registry
   whenever it is served at `/rig-data/` (dash-up mounts it when rig's RIG_DATA_DIR or
   `rig_data_dir:` is known — agent or not): runs newest first, any subdirectory expands lazily,
   a `.bpf`/`.las` opens in the viewer, other files are only counted. A `.laz` must fail with the
   conversion hint, never hang. Orbit/color (+legend: editable range, auto, γ)/alpha+blend/opacity/EDL/size/ortho/view controls; switching tabs and back keeps
   the loaded cloud (no re-parse). `?cloud=<url>` deep-loads one.
6. **Map widget** (`type: map` on Home): with an internet-connected browser the OSM default shows
   tiles (fetched by the BROWSER — the vehicle serves nothing); marker + trail appear on the first
   fix from the configured topic and "waiting for fix…" before it. Offline operator PC: serve a
   z/x/y tile tree locally (`python3 -m http.server 8000` → `tiles: http://localhost:8000/...`).
   Tab away/back must re-render the map full-size (no gray half-tiles). Panning pauses follow;
   ⌖ resumes.
6b. **Camera widgets**: a `camera` tile with no `stream` shows the picker when several streams are
   discovered (the only one auto-selects) and remembers the pick across reloads; `cameras` shows one
   feed in focus with a carousel — click a thumbnail to swap, ⊞/▣ toggles the grid, ✕ removes a
   feed, "add a feed…" adds one; `lock: true` removes all of that.
7. **Tabs config**: no `tabs:` = Home alone, no tab bar, and the built-in Home offers no Cameras/ROS
   shortcuts; `tabs: [cameras, debug]` adds exactly those; `#/ros` (not listed) falls back to the
   first visible tab; `tabs: { debug: false }` (map form) is still honoured.
8. **Bus debug** → **Liveliness** shows the raw keyspace: the rmw_zenoh graph tokens + the
   `fleet/.../media/...` discovery token. The data-subscription box can sample any keyexpr; its
   **attachment** column decodes each sample's rmw attachment (`rmw ✓ seq N · plain` = the nodes
   speak the layout this page sends, so service calls are safe; `⚠ nodes speak the labelled layout…`
   = set `rmw_attachment:` to what it names BEFORE any service call — a server given the wrong
   layout crashes).

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
  — the `DASH_*` lines must be identical and junk-free (nested keys must not leak). With
  `rig_agent: true` + `rig_root/rig_data_dir/rig_actuate: false/rig_poll_s` set, both runs must also
  emit `DASH_RIG_AGENT=1`, `DASH_RIG_ROOT`, `DASH_RIG_DATA`, `DASH_RIG_ACTUATE=0`, `DASH_RIG_POLL_S`
  (verified identical on the bench 2026-09-02).

## Service calls / shared sessions (on-vehicle acceptance)

1. **Attachment wire format** (do this FIRST on a new fleet — a mismatch KILLS the server node):
   Bus debug → subscribe `**` while any topic publishes → the attachment column must show
   `rmw ✓ seq N · plain`. rmw_zenoh 0.10 (Lyrical) attaches 33 unlabelled bytes (`plain`, the
   default); Jazzy's 0.2 attaches 77 labelled bytes (`labelled`). `⚠ nodes speak the labelled
   layout…` → set `rmw_attachment: labelled` in the instance config and reload before any call.
   Measured on the bench: a rosbag2 recorder on 0.10.5 terminated with `zenoh::ZException:
   Incorrect sequence size` on the first labelled query (rmw_zenoh parses the attachment in its
   query callback and the exception is uncaught). A layout neither decodes as → fix
   `app/src/services/attachment.ts` against the vehicle's `rmw_zenoh` before trusting calls.
2. **Bundled-type call**: a `service_button` for any `std_srvs/srv/Trigger` service → click → the
   button flashes the response (`success — ...`). `timeout: ...` against a stopped server.
3. **Dynamic typing**: `ros2 service list | grep get_type_description` (Jazzy nodes serve it per
   node); a `service_button` for a vendor-typed service must resolve + call with no bundled schema.
4. **Services widget**: a `services` widget listing a rosbag2 recorder's `…/pause` and
   `…/resume` → both rows `ready` with their types (resolved dynamically — neither is bundled);
   `resume` shows `resume_time` as JSON (`{"sec":0,"nanosec":0}`), `resume_mode`, and
   `tracking_topic_name` inputs, `pause` no form. Type `x` into `resume_mode` → call → the row
   says `request: resume_mode: an integer (int32)` and nothing was sent. Fix it → call → the
   reply (`return_code: 0`) stays on the row with its round-trip time; stop the recorder → the
   pill flips to `no server`, the button disables, the last reply stays.
5. **Shared sessions**: put the same camera on Home (`type: video`) and subscribe it in Cameras →
   `chrome://webrtc-internals` shows **one** peer connection for that camera. Switch tabs during
   playback → no renegotiation events. Producer restart → tile goes offline → auto-resumes. Freeze
   the producer (SIGSTOP) → recovery within ~15 s of unfreeze.

## Bag recorders (rosbag2 — bench or on-vehicle acceptance)

A `bag_recorders` Home widget drives every rosbag2 recorder's WRITING through the recorder's own
services (`…/pause`, `…/resume`, `…/is_paused`, `…/split_bagfile`, `…/snapshot`) — not the
session: where a run starts and ends stays rig's call. Any recorder on the mesh will do:

1. Start one (`ros2 bag record -a` in a `fleet-ros` container on the router's domain, or a rig
   run's `bag_logger`) → the widget lists it by namespace with a `recording` pill within `poll_s`
   (3 s default). A node serving `/pause` without `/is_paused` must NOT be listed.
2. **pause** → pill `paused`, `ros2 service call …/is_paused` agrees, the bag stops growing; the
   row now offers **resume** instead of pause. **resume** → `recording`, growth resumes.
3. **split** → a new bag file appears in the bag directory; a recorder with no bag open answers
   with a non-zero `return_code` and the row shows its `error_string` as an error note.
4. `recorders: [/bag_logger/rosbag2_recorder]` lists only that one; a base not on the graph shows
   "none of … is on the graph". `confirm: true` arms pause / split / snapshot on the first click.
5. Stop the recorder → the row disappears with its liveliness tokens; nothing is polled for it.

## Lifecycle control plane (camera-service recording — on-vehicle acceptance)

Needs a camera-service core with the zenoh control plane (`feat/zenoh-control-plane`, PR 2 —
`control.enabled: true`, same router or a scoutable peer). Contract: camera-service
`docs/LIFECYCLE.md`.
1. **Discovery**: the core's token appears in Bus debug liveliness as
   `fleet/<vehicle>/svc/<instance>/lifecycle`; the Cameras tab grows a **Recording control** card
   with that instance, its state pill (`inactive`/`active`), boot reason chip, and a button per
   accepted transition. No config needed. A `type: lifecycle` home widget (`service: <instance>`)
   shows the same card wherever it is placed; `not advertised` until the token lands.
2. **activate** → button reads `calling…` until the reply (sub-second) → pill `active`, the
   recording run prefix/encoder/frames appear (frames climb via the `…/state` publications, which
   also update every other open dashboard). A `run_id` in the widget config shows up in the prefix.
3. **deactivate** → `calling…` for the file finalization (≤5 s, ≤10 s worst case; the client
   timeout is 20 s) → `inactive`; the files are finalized on the vehicle.
4. **Refusal path**: `recording.enabled: false` in the sensor YAML → activate flashes
   `activate refused: recording disabled by config` (an `ok:false` reply, not an error).
5. **Concurrent control**: `docker kill -s USR1 <core>` from a shell → the dashboard pill flips
   without any click (state publication). Kill the core → pill shows `… · offline`, card survives
   the 15 s grace, and a restart resumes the last commanded state (`resumed` chip).

## Rig control surface (rig agent — bench + on-vehicle acceptance)

Contract: [docs/RIG_AGENT.md](docs/RIG_AGENT.md). Producer: `agent/` (`dashboard-rig-agent`, opt-in
via `rig_agent: true`). Unit tests: `cd agent && python3 -m unittest -v` (no binding, no docker) and
the `app/src/rig/*.test.ts` vitest files.

**Bench (verified 2026-09-02 on the Mac, no vehicle):** run the agent natively against a dev tree with
jobs as child processes and let it stand in for the router (`ZENOH_LISTEN`); a scratch
`vehicle.local.yaml` supplies a scratch `data_dir` through `RIG_VEHICLE_LOCAL` so nothing in the tree
changes:
```sh
python3 -m venv /tmp/rig-venv && /tmp/rig-venv/bin/pip install -r agent/requirements.txt
mkdir -p /tmp/rig-data && echo "data_dir: /tmp/rig-data" > /tmp/vehicle.local.yaml
cd agent && RIG_ROOT=~/ws/bringup RIG_MOUNT=~/ws RIG_DATA_DIR=/tmp/rig-data \
  RIG_VEHICLE_LOCAL=/tmp/vehicle.local.yaml RIG_AGENT_STATE_DIR=/tmp/rig-agent-state \
  RIG_AGENT_RUNNER=subprocess ZENOH_CONNECT="" ZENOH_LISTEN=tcp/0.0.0.0:7447 \
  /tmp/rig-venv/bin/python -m rig_agent serve
```
A consumer written from the doc's recipe (`liveliness().get("fleet/*/rig")`, `get` of the
descriptor / `state` / `runs`, a `submit`, subscribe `jobs/events`) must see: the token; the
descriptor with `rig_version` = the tree's; every vehicle.yaml row in the state (disabled rows as
`down`); refusals as `ok:false` (`standby` of a row without the trio, an unknown row, a bad label);
`new-run bench1` → `queued` then `succeeded` events with `result.opened` = the new id, `runs` showing
it `OPEN`, `run/<id>` returning its manifest, a `state` publication carrying `run`; a second submit
while it runs → `busy`; `end-run` → `result.sealed`, `runs` showing `sealed`. Then the browser: the
dashboard's own sidecar (`docker compose -f deploy/docker-compose.yml build dashboard-zenoh`). Docker
Desktop's `--network host` is NOT effective on the Mac, so run it in bridge mode pointed at the host:
```sh
echo '{ mode: "client", connect: { endpoints: ["tcp/host.docker.internal:7447"] }, scouting: { multicast: { enabled: false } } }' > /tmp/zenohd-bench.json5
docker run -d --name dash-zenoh-bench -p 10000:10000 -v /tmp/zenohd-bench.json5:/config/z.json5:ro dashboard-zenoh:local -c /config/z.json5 --ws-port 10000
```
then `npm run dev` with `VITE_REMOTE_API_LOCATOR=ws/localhost:10000` and `rig_agent: true` in
`app/public/config/dashboard.yaml` → the Rig tab shows `advertising`, the six rows, the run card and
the job history (verified 2026-09-03). The agent IMAGE's rig path is checked the same way without a
vehicle: `docker build -f deploy/Dockerfile.rig-agent -t dashboard-rig-agent:local .`, then a one-shot
poll inside the container with the tree identity-mounted and the socket —
`docker run --rm -v ~/ws:~/ws:ro -v ~/ws/bringup/var:~/ws/bringup/var -v /var/run/docker.sock:/var/run/docker.sock -e RIG_ROOT=~/ws/bringup -e RIG_MOUNT=~/ws -e ZENOH_CONNECT= dashboard-rig-agent:local status`
(expand `~`) → `"ok": true` with every row (verified 2026-09-03: rig 0.2.46 ran inside the image).

**On the vehicle** (`rig_agent: true` in the dashboard instance YAML, `rig up`):
1. **Discovery**: Bus debug liveliness shows `fleet/<vid>/rig`; the Rig tab header reads
   `advertising`, rig version = the tree's, `root`/`data_dir` as mounted; `docker compose ps` in the
   dashboard project shows `dashboard-rig-agent` running as the operator's uid (Linux).
2. **Deployment table** matches `rig status` (compose state + n/m, health, op/lifecycle pill,
   tier grouping, disabled rows dimmed, the dashboard row marked). `docker kill` a container of
   some stack → its row flips within one poll (10 s); `docker compose start` it → back.
3. **Run banner** matches `rig runs`; a shell `rig new-run bench` (with the stacks down, or
   `--force`) → the banner updates within ~2 s (registry watch, no status poll needed).
4. **Lifecycle-advertised row** (camera-service): its pill is the lifecycle state and its buttons
   are `activate`/`deactivate` over zenoh (not agent jobs); `activate` carries the open run's label
   into the recording prefix (`use_run_label`).
5. **Trio row** (ouster / jetson-manager): `standby` → a job appears in the Jobs card with the log
   tail streaming rig's `==>` lines; `op_state` flips to `standby` on the next poll; `activate` back.
6. **Guard**: `new run…` / `end run (seal)` while stacks run → the refusal shows rig's message
   verbatim with the blocking projects and the two follow-ups; `force` seals/rotates; `stop
   everything & seal` asks twice, tears the stack down (the dashboard drops), and after `rig up` the
   Jobs card shows the terminal record with `result.sealed` (the detached runner survived).
7. **Run browser**: states match `rig runs`; a selected run shows its manifest, `ups[]`, and — with
   data_dir mounted — its files: `.rig/logs/<sensor>/*.log`, `recordings/<instance>/*` with the
   sidecar chips; a download link streams an `.mkv`; `curl -I http://<vehicle>:8080/rig-data/runs/<id>/manifest.yaml` → 200.
8. **Read-only**: `rig_actuate: false` → no buttons anywhere; a hand-made submit answers
   `actuation disabled`. **No agent** (`rig_agent` absent): no Rig tab, `type: rig` widgets show
   `no rig agent`, nothing errors.
9. **Restart**: kill the agent container mid-job → the tab shows `offline · grace`; after restart the
   job record is still listed (re-attached or `failed: runner exited while the agent was down`).

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
