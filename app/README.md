# app — dashboard frontend (Vite + React + TS)

Tabbed operator frontend (Home / Cameras / ROS / Bus debug). Talks Zenoh from the browser via
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

By default the locator is derived from the page host (`ws/<host>:10000`) — correct for the
vehicle-served deployment. Override with `VITE_REMOTE_API_LOCATOR` for dev.

> zenoh-ts pulls a wasm keyexpr module; `vite-plugin-wasm` + `vite-plugin-top-level-await` are wired
> in `vite.config.ts` to handle it. Drop them if a clean build shows they're unneeded.

## Build

```sh
npm run build      # tsc + vite → app/dist  (the dashboard-web image bakes this; for the UI, prefer `npm run dev`)
```

## Layout / seams

```
src/
  App.tsx                   # provider stack: Config > Transport > Streams > RosGraph > Shell
  shell/                    # tab shell: useHashRoute (#/cameras deep links), TabBar, Shell
                            #   (all tab panels stay MOUNTED; inactive ones hidden with CSS only)
  config/                   # runtime instance config: schema.ts (parse/validate the home: block),
                            #   load.ts (GET /config/dashboard.yaml), ConfigContext
  home/                     # config-driven Home tab: HomeTab, DefaultHome, widgets/ (status,
                            #   service_button, video, topic_value + error card/boundary),
                            #   rate.ts, pluck.ts, resolveStream.ts (pure helpers)
  transport/
    types.ts                # Transport interface (the UI codes against this, never zenoh-ts)
    zenohRemoteApi.ts       # impl: zenoh-ts over the remote-api WebSocket (get: payload/attachment/timeout)
    locator.ts              # remote-api locator (env override > config ws_port > page-derived)
    useTransport.ts         # opens/holds the Transport for the app
    TransportContext.tsx    # app-wide session
  services/                 # ROS2 service calls over zenoh (rmw_zenoh wire format)
    attachment.ts           # rmw client attachment encode/decode (seq/timestamp/gid)
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
    RosGraphContext.tsx     # ONE graph + decoder cache app-wide (Home widgets + ROS tab share it)
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
