# app — dashboard frontend (Vite + React + TS)

Tabbed operator frontend (Home / Cameras / ROS / Rig / Clouds / Bus debug). Talks Zenoh from the browser via
`zenoh-ts` → the `dashboard-zenoh` remote-api sidecar. Builds to `app/dist`;
`deploy/Dockerfile.web` bakes it into the `dashboard-web` image. The Home tab is laid out from the
instance config YAML served at `/config/dashboard.yaml` (see `config/infra/dashboard.example.yaml`);
without one it renders a built-in default.

## Dev

```sh
cd app
npm install
npm run dev                        # http://localhost:5173 (host:true → also on the LAN)
# point at a remote vehicle's sidecar:
VITE_REMOTE_API_LOCATOR=ws/<vehicle-ip>:10000 npm run dev
```

The vehicle locator is derived from the page host (`ws/<host>:10000`). The app first tries a
verified laptop bridge on `127.0.0.1:10000`, falling back to the vehicle. `VITE_REMOTE_API_LOCATOR`
explicitly pins a single endpoint. To test automatic selection while serving the page locally,
use `VITE_VEHICLE_HOST=<vehicle-ip> npm run dev`. See [local bridge setup](../docs/LOCAL_BRIDGE.md).

`npm install` / `npm ci` runs `patches/zenoh-ts.mjs` to make the pinned 1.9.0 SDK connection attempts
bounded and cancellable. This is required for fallback; production image builds also apply it.

> zenoh-ts pulls a wasm keyexpr module; `vite-plugin-wasm` + `vite-plugin-top-level-await` are wired
> in `vite.config.ts` to handle it. Drop them if a clean build shows they're unneeded.

## Build

```sh
npm run build      # tsc + vite → app/dist  (the dashboard-web image bakes this; for the UI, prefer `npm run dev`)
```

## Layout / seams

Home map widgets accept `basemap: streets | satellite | terrain | none | custom`. Streets is the
default (OpenStreetMap); satellite and terrain use Esri imagery and topographic tiles. Each map has
a Basemap selector that changes only its tiles, preserving zoom, position, follow mode and trail.
The selection lasts until page reload, when the configured default applies again.

```yaml
home:
  widgets:
    - type: map
      label: Position
      topic: /gnss/fix
      orientation_topic: /imu/data   # optional; omit to keep the dot marker
      basemap: satellite
```

A `tiles:` XYZ URL adds a Custom option; `basemap: custom` requires that URL. Existing `tiles:`
configurations still default to Custom, and `tiles: "none"` still starts without tiles. Use
`attribution:` for your custom provider's credits. Online tiles are fetched by the laptop browser;
for offline use choose None or point Custom at a reachable local tile server. Switching to None
keeps the marker and trail and stops requesting tiles.

For heading, the map reads the quaternion at `orientation` (override with a dot-path in
`orientation_field`). It converts ROS ENU yaw to a clockwise bearing from north, following
[REP-103](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst).
Set `orientation_frame: ned` for a north/east/down source. `heading_offset_deg` adds a clockwise
angle correction. Use an earth-referenced orientation aligned to the vehicle's forward axis;
the widget does not resolve TF or integrate angular velocity. A relative IMU yaw cannot by
itself supply a geographic heading. Missing/invalid orientation, a zero quaternion, or an IMU
[`orientation_covariance[0] == -1`](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/Imu.msg)
leaves the dot marker. Position and heading update independently using their latest samples.

To compare position sources, replace the single `topic:` and its orientation/field options with
`feeds:`. Feed IDs must be unique. Labels and colors are optional (colors default to a palette):

```yaml
home:
  widgets:
    - type: map
      label: Position sources
      basemap: satellite
      default_feed: fused
      trail: 500                 # points per feed
      feeds:
        - id: gnss
          label: GNSS
          topic: /gnss/fix
          color: "#38bdf8"
        - id: fused
          label: Fused position
          topic: /localization/fix
          orientation_topic: /imu/data
          color: "#fbbf24"
          # orientation_field: orientation
          # orientation_frame: enu
          # heading_offset_deg: 0
        - id: reference
          label: Reference
          topic: /reference/fix
          visible: false
```

Checkboxes show/hide each feed's marker and trail. The Follow selector switches the tracked feed;
selecting a hidden feed also shows it. Panning pauses follow and the ⌖ button resumes it. With
`follow: false`, the selector is labeled Focus and centers once without tracking subsequent moves.
Hidden feeds continue receiving data and retaining their bounded trails. All operator choices
reset to the config on reload. `default_feed` must identify an initially visible feed; if omitted,
the first visible feed is selected. `lat_field` / `lon_field` and heading options are per feed.

The overall dashboard width is controlled by `--page-max-width` and `.page` in `src/index.css`.
It now expands up to `90rem` (1440 px at the default root font size), while remaining fluid on
smaller displays. The individual Home grid's columns and areas remain controlled by `home.layout`.

```
src/
  App.tsx                   # provider stack: Config > Transport > Streams > RosGraph > Shell
  shell/                    # tab shell: useHashRoute (#/cameras deep links), TabBar, Shell
                            #   (all tab panels stay MOUNTED; inactive ones hidden with CSS only)
  config/                   # runtime instance config: schema.ts (parse/validate the home: block),
                            #   load.ts (GET /config/dashboard.yaml), ConfigContext
  widgets/                  # the widget REGISTRY: registry.ts (spec + component per type — the one
                            #   door built-ins and extensions share), parse.ts (YAML accessors),
                            #   builtins.tsx (attaches built-in components), sdk.ts (the stable
                            #   surface extensions import)
  extensions/               # project widgets — index.ts registers them; example/CompassWidget.tsx;
                            #   README.md = "writing a widget"
  home/                     # config-driven Home tab: HomeTab (grid-area layout, registry-rendered),
                            #   DefaultHome, widgets/specs.ts (built-in specs, pure), widgets/
                            #   (status, service_button, services, video, camera, cameras, bag_recorders, topic_value,
                            #   map, lifecycle, panel;
                            #   primitives/: gauge, sparkline, indicator, text + rules.ts/series.ts),
                            #   rate.ts, pluck.ts, value.ts, geo.ts, resolveStream.ts (pure helpers)
  lifecycle/                # service lifecycle control plane (camera-service recording standby/active):
                            #   types.ts (keys + descriptor contract), discovery.ts (liveliness +
                            #   descriptor get + state publications), changeState.ts (change_state
                            #   query client), useLifecycleAction (the button state machine, shared
                            #   with the Rig tab), LifecycleContext/useLifecycle, LifecycleCard
                            #   (+compact), LifecycleServicesCard (zero-config card on the Cameras tab)
  rig/                      # the rig deployment via the vehicle-side agent (docs/RIG_AGENT.md — the
                            #   same shape as lifecycle/): types.ts (keys + documents + parsers),
                            #   discovery.ts (liveliness + descriptor/state/jobs gets + state and
                            #   job-event publications), client.ts (submit/cancel/runs/run queries),
                            #   RigContext/useRig, actions.ts (PURE: lifecycle-vs-rig-trio button rule
                            #   per row), useRigSubmit (verb button state machine), RigTab + parts
                            #   (OpenRunBanner, DeploymentTable/RowActions, JobPanel, RunBrowser +
                            #   DirTree over Caddy's /rig-data listing: runsData.ts), format.ts
  clouds/                   # Clouds tab: React chrome (CloudsTab/CloudsList/useCloudLoader) over a
                            #   VENDORED framework-free point-cloud viewer core (vendor/ — see
                            #   vendor/VENDORED.md for provenance/deltas/re-sync). Lazy-loaded:
                            #   three.js ships in its own chunk, downloaded on first tab visit.
  transport/
    types.ts                # Transport interface (the UI codes against this, never zenoh-ts)
    zenohRemoteApi.ts       # impl: zenoh-ts over the remote-api WebSocket (get: payload/attachment/timeout)
    locator.ts              # remote-api locator (env override > config ws_port > page-derived)
    useTransport.ts         # opens/holds the Transport for the app
    TransportContext.tsx    # app-wide session
  services/                 # ROS2 service calls over zenoh (rmw_zenoh wire format)
    attachment.ts           # rmw attachment encode/decode (seq/timestamp/gid): plain (rmw_zenoh 0.10)
                            #   default, labelled (Jazzy) via rmw_attachment:; decode sniffs the layout
    keyexpr.ts              # SS token → service query keyexpr; gtd server picker
    srvDefs.ts              # hand-bundled schemas: GetTypeDescription bootstrap + std_srvs
    typeDescription.ts      # TypeDescription → foxglove MessageDefinitions
    client.ts / resolveSrv.ts / callService.ts   # per-session identity, RIHS-cached codec
                            #   resolution (static → dynamic gtd), public callService API
  schema/
    types.ts                # TypeIdentity, Decoder, SchemaResolver
    keyParser.ts            # data keyexpr → {topicName, identity} (ROS2 rmw_zenoh + ROS1 bridge)
    typeName.ts             # DDS-mangled ↔ ROS type-name forms
    resolver.ts             # fingerprint-cached resolver → decoders/staticDefs (bundled defs + CDR/ROS1 readers)
  ros/
    graph.ts                # @ros2_lv liveliness tokens → RosGraph (topics/nodes/services + QoS)
    useRosGraph.ts          # live graph hook (liveliness sub with history)
    RosGraphContext.tsx     # ONE graph + decoder cache + TopicStore app-wide
    topicStore.ts           # refcounted shared topic subs: N watchers = 1 zenoh sub + 1 decode/flush
    useTopic.ts             # React glue over the store (used by readouts, hz statuses, inspector)
    RosExplorer.tsx         # topic table + drill-down; nodes/services lists
    TopicInspector.tsx      # subscribe→decode→render one topic (Hz/bytes, latched get)
    MessageTree.tsx         # decoded-message tree (bigint/TypedArray-safe)
  streams/                  # WebRTC camera streams: fleet media discovery + viewer
    types.ts                # StreamDescriptor (docs/DISCOVERY.md) + parse/validate
    discovery.ts            # liveliness sub on fleet/<v>/media/<s> + descriptor get → DiscoveredStream[]
    useStreams.ts           # React hook over StreamDiscovery
    StreamsContext.tsx      # ONE discovery + ONE session pool app-wide
    pool/                   # refcounted per-stream WebRTC sessions (sessionPool.ts state machine:
                            #   backoff/stall-watchdog/liveliness flap + linger grace; useStreamSession glue)
    signalling.ts           # resolve the descriptor's signalling URL (host rewrite, single-vehicle)
    source/                 # protocol-keyed players: gstwebrtc-api now (whep/… later); hand out MediaStreams
    CameraConsole.tsx       # available-streams rail + subscribe set + grid/focus layouts
    StreamView.tsx          # thin tile view over the pool (mode = chrome only)
```

## Camera streams (WebRTC)

Discovers streams your producers advertise per the camera-service `docs/DISCOVERY.md`
(`fleet/<vehicle>/media/<sensor>` — liveliness presence + a JSON descriptor) over the existing
`Transport`, and plays them with the `gstwebrtc-api` client (descriptor `protocol: gstwebrtc-api`).
Opening a stream matches the descriptor's `producer_id` (= webrtcsink `meta.name`) to a producer on the
signalling server, then consumes it by that producer's signalling `id`.

- **Reachability**: the viewer rewrites the descriptor's signalling *host* to the vehicle host
  (`signalling.ts` → `vehicleHost()`: the page host when vehicle-served, the `VITE_REMOTE_API_LOCATOR`
  host in dev) — single-vehicle; a fleet deployment needs per-vehicle resolution.
- **Scheme must align**: an https page can't open a `ws://` signalling socket — serve the page over http
  (Phase-1 Caddy `:8080`) or run the bridge with `wss`.
- `gstwebrtc-api` has no `close()`, so signalling connections are **pooled per URL** (shared across
  tiles). On top of that, `ConsumerSession`s are **pooled per stream key** (refcounted,
  `streams/pool/sessionPool.ts`): the Home video widget and the Cameras tab showing the same camera
  share ONE session (one vehicle-side encode), grid/focus/thumbnail and tab switches are CSS-only,
  and a 3 s linger grace after the last tile releases absorbs StrictMode double-mounts and
  re-parenting without renegotiation. All self-healing (backoff retries, stall watchdog,
  liveliness-flap resume) lives in the pool, not the tiles.
- Add protocols (WHEP, …) by registering a factory in `streams/source/registry.ts` — a source
  negotiates and hands out a `MediaStream`; it never touches video elements.

## ROS explorer / decode

The ROS graph is rebuilt client-side from rmw_zenoh's `@ros2_lv/**` liveliness tokens (`ros/graph.ts`
— token + QoS formats verified against rmw_zenoh jazzy `liveliness_utils.cpp` and live against a
`lyrical` vehicle). Clicking a topic subscribes to its data keyexpr
(`<domain>/<topic>/<dds-type>/<RIHS hash>`) and decodes CDR with readers built from
`@foxglove/rosmsg-msgs-common` bundled definitions (`schema/decoders/staticDefs.ts`, loaded as an
async chunk). Unit tests cover the parsers and a write→decode round-trip: `npm test`.

Known behaviors:

- **Bundled defs only (topics)**: vendor types (novatel/sbg/vectornav…) aren't in the bundle and
  show a "not in the bundled message definitions" error in the inspector. The machinery to fix this
  now exists — `services/` implements rmw_zenoh service calls incl. dynamic `get_type_description`
  typing (used by home-tab service buttons); wiring the same resolution into `schema/resolver.ts`
  as a topic-decode backend is the remaining step.
- **Version skew**: defs are jazzy-era; if a decode leaves trailing bytes the inspector shows a ⚠
  warning instead of failing (CDR ignores trailing bytes).
- **image_transport gating**: camera topics publish only when a *ROS* subscriber matches; a raw
  zenoh subscriber declares no `MS` graph token, so such topics show "no data yet". (Future trick:
  declare a mimic `@ros2_lv` MS token to nudge lazy publishers.)
- **transient_local**: the inspector also `get`s the keyexpr once on open (publication cache); on
  the lyrical vehicle the advanced publisher already replays history to late-joining subscribers,
  so latched values show up either way. `/rosout` is latched but has a 10 s lifespan — empty on an
  idle vehicle is normal.
