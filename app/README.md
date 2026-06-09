# app — dashboard frontend (Vite + React + TS)

Phase-1 frontend. Talks Zenoh from the browser via `zenoh-ts` → the `dashboard-zenoh` remote-api
sidecar. Built straight into `../deploy/www` (what the `dashboard-web` service serves).

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
npm run build      # tsc + vite → ../deploy/www  (overwrites the placeholder index.html)
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
    keyParser.ts            # keyexpr → {topicName, identity}; ROS1 done, ROS2 TODO
    resolver.ts             # fingerprint-cached resolver; decode backends STUBBED (next increment)
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

- **Reachability**: the viewer rewrites the descriptor's signalling *host* to the page host
  (`signalling.ts`) — correct for single-vehicle/vehicle-served; a fleet deployment needs per-vehicle
  resolution.
- **Scheme must align**: an https page can't open a `ws://` signalling socket — serve the page over http
  (Phase-1 Caddy `:8080`) or run the bridge with `wss`.
- `gstwebrtc-api` has no `close()`, so signalling connections are **pooled per URL** (shared across
  tiles); per-stream `ConsumerSession`s open/close with Play/Stop.
- Add protocols (WHEP, …) by registering a factory in `streams/source/registry.ts`.

## Next increment (decode)

Add the codecs and fill in `schema/resolver.ts`:

```sh
npm install @foxglove/rosmsg @foxglove/rosmsg-serialization @foxglove/rosmsg2-serialization
```

- ROS2: `get` the `get_type_description` queryable (payload = CDR `GetTypeDescription` req keyed by
  RIHS) → CDR reader from the returned `TypeDescription`.
- ROS1: `get` the companion md5→`full_text` advertiser → parse `.msg` → ROS1-wire reader.

Then a ROS Explorer panel subscribes to a topic, `parseKey` → `resolve` → `decode` → render.
