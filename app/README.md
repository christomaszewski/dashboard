# app — dashboard frontend (Vite + React + TS)

Phase-1 frontend. Talks Zenoh from the browser via `zenoh-ts` → the `dashboard-zenoh` remote-api
sidecar. Builds to `app/dist`; `deploy/Dockerfile.web` bakes it into the `dashboard-web` image.

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
  config.ts                 # remote-api locator (page-derived, env-overridable)
  transport/
    types.ts                # Transport interface (the UI codes against this, never zenoh-ts)
    zenohRemoteApi.ts       # Phase-1 impl: zenoh-ts over the remote-api WebSocket
  schema/
    types.ts                # TypeIdentity, Decoder, SchemaResolver
    keyParser.ts            # data keyexpr → {topicName, identity} (ROS2 rmw_zenoh + ROS1 bridge)
    typeName.ts             # DDS-mangled ↔ ROS type-name forms
    resolver.ts             # fingerprint-cached resolver → decoders/staticDefs (bundled defs + CDR/ROS1 readers)
  ros/
    graph.ts                # @ros2_lv liveliness tokens → RosGraph (topics/nodes/services + QoS)
    useRosGraph.ts          # live graph hook (liveliness sub with history)
    RosExplorer.tsx         # topic table + drill-down; nodes/services lists
    TopicInspector.tsx      # subscribe→decode→render one topic (Hz/bytes, latched get)
    MessageTree.tsx         # decoded-message tree (bigint/TypedArray-safe)
  streams/                  # WebRTC camera streams: fleet media discovery + viewer
    types.ts                # StreamDescriptor (docs/DISCOVERY.md) + parse/validate
    discovery.ts            # liveliness sub on fleet/<v>/media/<s> + descriptor get → DiscoveredStream[]
    useStreams.ts           # React hook over StreamDiscovery
    signalling.ts           # resolve the descriptor's signalling URL (host rewrite, single-vehicle)
    source/                 # protocol-keyed players: gstwebrtc-api now (whep/… later)
    StreamGrid.tsx/StreamTile.tsx   # list + per-stream <video> with Play/Stop
  transport/useTransport.ts # opens/holds the Transport for the app
  App.tsx                   # status + <StreamGrid>
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
  tiles); per-stream `ConsumerSession`s open/close with Play/Stop.
- Add protocols (WHEP, …) by registering a factory in `streams/source/registry.ts`.

## ROS explorer / decode

The ROS graph is rebuilt client-side from rmw_zenoh's `@ros2_lv/**` liveliness tokens (`ros/graph.ts`
— token + QoS formats verified against rmw_zenoh jazzy `liveliness_utils.cpp` and live against a
`lyrical` vehicle). Clicking a topic subscribes to its data keyexpr
(`<domain>/<topic>/<dds-type>/<RIHS hash>`) and decodes CDR with readers built from
`@foxglove/rosmsg-msgs-common` bundled definitions (`schema/decoders/staticDefs.ts`, loaded as an
async chunk). Unit tests cover the parsers and a write→decode round-trip: `npm test`.

Known behaviors:

- **Bundled defs only**: vendor types (novatel/sbg/vectornav…) aren't in the bundle and show a
  "not in the bundled message definitions" error in the inspector. The fix is the dynamic
  `get_type_description` backend (resolver.ts doc comment) — needs attachment support on
  `Transport.get` to satisfy rmw_zenoh's service-call protocol.
- **Version skew**: defs are jazzy-era; if a decode leaves trailing bytes the inspector shows a ⚠
  warning instead of failing (CDR ignores trailing bytes).
- **image_transport gating**: camera topics publish only when a *ROS* subscriber matches; a raw
  zenoh subscriber declares no `MS` graph token, so such topics show "no data yet". (Future trick:
  declare a mimic `@ros2_lv` MS token to nudge lazy publishers.)
- **transient_local**: the inspector also `get`s the keyexpr once on open (publication cache); on
  the lyrical vehicle the advanced publisher already replays history to late-joining subscribers,
  so latched values show up either way. `/rosout` is latched but has a 10 s lifespan — empty on an
  idle vehicle is normal.
