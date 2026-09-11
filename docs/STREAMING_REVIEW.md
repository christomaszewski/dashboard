# Camera playback and dashboard review — 2026-09-11

Reviewed dashboard `82f446a` and camera-service `332ffdb`, including the preceding held-preview
timestamp fix. The fixes below are local working-tree changes; they require rebuilding the
dashboard and camera images before they affect a vehicle.

## Findings addressed

1. **Playback preview clocks could drift after a gap or speed change.** Held frames advanced
   transport PTS by elapsed wall time, then the next frame added the historical capture gap again.
   A speed change also changed the rate of the RTP media clock. Playback transport now uses
   elapsed monotonic time for both real and held frames. The headered-shm bridge independently
   uses arrival time, since shm does not carry the core's transport PTS. Capture timestamps and
   the recording feed retain their original timing. Files: `camera-service/core-driver/cam_driver/pipeline.py`,
   `camera-service/plugins/webrtc-bridge/tools/header_transport.py` and `bridge_stream.py`.

2. **The new short GOP was overwritten by GStreamer.** The encoder callback ran before
   `webrtcsink`'s default handler. In the real runtime, requesting a 20-frame GOP produced
   `key-int-max=2560`. Registering the policy with `connect_after` leaves the sink's initial
   bitrate/congestion setup in place and applies the requested GOP afterwards. The software
   preset defaults to `ultrafast`, retaining the sink's former effective behavior; an explicit
   `superfast` or slower preset now takes effect, so budget CPU accordingly. File:
   `camera-service/plugins/webrtc-bridge/tools/bridge_stream.py`.

3. **NVENC's I-frame setting did not configure its separate IDR interval.** The preview policy
   now sets both `iframeinterval` and `idrinterval`. These are distinct encoder properties in
   [NVIDIA's plugin documentation](https://docs.nvidia.com/metropolis/deepstream/dev-guide/text/DS_plugin_gst-nvvideo4linux2.html).
   The property policy is tested; actual hardware IDR emission still needs vehicle validation.

4. **Decimated native transport advertised the recording frame rate.** At 24 fps capped to
   10 Hz, every-third-frame publishing delivers 8 fps, but caps advertised 24 fps. A GOP derived
   from those caps lasted three times as long. Native transport now advertises the decimated
   rate for both mono and Bayer; recording caps remain unchanged. Headered/raw shm still needs
   the plugin's `fps` / `CAM_FPS` hint configured to the effective published rate. The keyframe
   setting is a frame-count policy, so holds, slow playback and overload can lengthen its wall
   duration; it is not a guaranteed two-second loss recovery bound.

5. **Dashboard stream diagnostics discarded real browser reports.** `RTCStatsReport` is
   [maplike](https://www.w3.org/TR/webrtc/#rtcstatsreport-object); its default iterator yields
   key/value pairs. The parser expected stats objects. `GstWebRtcSource.stats()` now passes
   `.values()`, with a regression test through the public method. File:
   `dashboard/app/src/streams/source/gstwebrtc.ts`.

## File order and remaining synchronization limits

The replay reader sorts numeric segment names within each session and orders sessions by their
first capture timestamp. Real FFV1 fixtures with session names deliberately out of chronological
order replayed in the correct pixel/timestamp order. There is no evidence here of an out-of-order
chunk bug; this does not validate the user's particular files.

Each camera still decodes and encodes independently and has its own WebRTC connection and browser
jitter buffer. A slow disk, decoder, encoder or link can delay one feed independently. Correcting
the preview clock removes artificial drift, but does not make the displayed capture timestamps
identical or catch a slow decoder up to its peer.

For frame-accurate comparison, add a vehicle-side compositor that pairs frames by their original
capture timestamps and streams a combined view, or carry capture timestamps to a browser renderer
that explicitly buffers and aligns frames. Both need a policy for missing/late frames. Moving the
dashboard's Zenoh bridge to the laptop does not synchronize independent video decoders.

On-vehicle validation should replay two feeds through a recorded gap, pause/resume, restart and
speed changes while comparing capture timestamps. Inspect the now-working receive stats for
packet loss, decoder freezes and jitter-buffer delay, and bridge/source logs for dropped frames
or processing overload. NVIDIA hardware and a two-camera lossy-link replay were not available for
this local check.

## Basemaps

The Home map widget now supports Streets, Satellite, Terrain, None and an optional Custom XYZ
layer. Set `basemap:` on the map widget for its startup default; use the widget's selector during
operation. A reload restores the configured default. Switching preserves zoom, position, follow
mode and trail. Existing `tiles:` defaults remain compatible. See
[configuration examples](../config/infra/dashboard.example.yaml) and [frontend documentation](../app/README.md).

Online tiles are requested by the viewing laptop. For offline operation, select None or configure
a reachable local tile server through `tiles:`.

## Validation

- Dashboard: 364 tests passed, plus TypeScript/production build. Browser verified all five choices,
  loaded online tiles, correct attribution, preserved marker, and configured default after reload.
- Camera: preview clock, source PTS, session lifecycle, publish-rate, header transport and encoder
  policy regressions passed; six real-file replay tests passed.
- Real GStreamer checks: mono/Bayer native caps advertise 8 fps while recording keeps 24 fps;
  `webrtcsink` honors the configured GOP/preset on both existing WebRTC runtime images.

The two checks requiring actual media plugins run explicitly outside the minimal unit runner:

```sh
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo --entrypoint python3 \
  webrtc-bridge:dev core-driver/tests/check_transport_caps.py
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo --entrypoint python3 \
  webrtc-bridge:dev plugins/webrtc-bridge/tools/check_encoder_setup.py
```

Run these from the camera-service repository. Production build still reports the existing
Foxglove dependency `eval` and bundle-size warnings.
