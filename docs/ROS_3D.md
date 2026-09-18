# ROS point clouds and TF

The `pointcloud` Home widget and opt-in **3D** tab show live ROS 2 PointCloud2 topics in a
chosen fixed frame. Both use the same decoder, TF buffer, and renderer. The existing
**Clouds** file viewer remains available separately.

The primary workflow is **passive visualization**. Neither 3D surface has playback controls
or calls playback services. They follow externally published `/clock`, `/tf`, `/tf_static`,
and point clouds. An optional, separate `rosbag_playback` widget provides central controls.

## Enable the view

Add this to the deployment's dashboard YAML, merging it with the existing tabs and Home widgets:

```yaml
tabs: [ros, ros3d]
ros3d:
  # Select a frame actually present in the robot's TF tree.
  fixed_frame: map
  # domain_id: 0            # required if more than one domain is discovered
  tf_topics: [/tf]
  tf_static_topics: [/tf_static]
  time_source: live        # ros_clock for externally controlled bag playback
  clock_topic: /clock
  show_frames: true
  displays:
    - id: ouster
      topic: /ouster/points
      history_s: 0         # latest scan; e.g. 3 for a three-second history
      color: {mode: height}
      point_size: 2
      opacity: 1
home:
  version: 1
  widgets:
    - type: pointcloud
      label: Lidar
      # Any ros3d setting can be overridden for this widget.
```

The frame selector uses discovered TF names. Add cloud topics in **Displays & settings**;
each layer has independent visibility, history, size, opacity, and coloring. Color by fixed-frame
height, intensity, any decoded scalar field (such as Ouster reflectivity/ring), packed RGB/RGBA,
or a solid color. Missing fields produce a visible diagnostic. Topic names do not imply a sensor
frame or a particular point layout.

Orbit, pan, zoom, **Fit**, **Top**, and **Ortho** control the camera. Follow a frame to move the
camera with the robot while retaining clouds in a world frame. **Clear scans** only clears local
history. Changing the fixed frame clears history and rebuilds from new clouds. Camera and display
preferences are remembered locally, separately for each widget/tab and YAML configuration.

Each cloud uses its header timestamp and frame. Dynamic TF interpolates translation and rotation;
it never silently extrapolates. Late TF waits in a bounded queue; missing/expired/disconnected
transforms produce diagnostics instead of misplaced points. Accumulated scans retain their original
transforms, so subsequent vehicle motion does not move old points. This is rigid scan visualization;
per-point motion compensation, SLAM, URDF, markers, and point editing are outside this version.

## Externally controlled playback

Set `time_source: ros_clock` and have exactly one playback clock publisher in the selected domain.
The clock need not be recorded in the bag. With ordinary Lyrical rosbag2, for example:

```sh
source /opt/ros/lyrical/setup.bash
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
ros2 bag play /path/to/bag --clock-topics-all --loop
```

Use the deployment's existing Zenoh router/session configuration. `--clock-topics-all` publishes
a clock before each replayed message; it is an alternative to `--clock`, not an additional flag.
The viewer freezes history decay when ROS time stops and clears on backward clock jumps/loops.
Forward discontinuities exceeding elapsed time at the known playback rate plus two seconds also
clear the scene. An arbitrary small external forward seek cannot be distinguished from ordinary
message timing through `/clock` alone; the snapshot adapter below supplies explicit epochs.

An ordinary player cannot republish TF from before an arbitrary seek just because a browser needs
it. Seeking while paused may leave the view waiting for TF/cloud publication. This was reproduced
with the pinned Lyrical player. For immediate reconstruction, run the optional adapter **instead
of the other player for these cloud/TF topics**:

```sh
python3 tools/ros3d_replay.py /path/to/bag --start-paused --loop --points /ouster/points
```

The adapter uses the existing Lyrical `rclpy`, `rosbag2_py`, and standard message/service packages.
It indexes only TF on temporary disk and streams cloud data. A seek publishes an atomic, validated
TF snapshot on `/ros3d/replay_state`, a clock, and the first cloud at or after the requested bag
timestamp. Static transforms are restored as of that record; dynamic transforms bracket the
cloud's acquisition timestamp. The paused preview is one cloud; other configured cloud topics
continue when replay resumes. It does not rebuild the entire pre-seek accumulation window.
Snapshots refresh during playback and on pause so late-joining/reconnected views can recover;
refreshes within the same epoch preserve already-connected views' scan histories.

Control this source externally with its ROS services (`/ros3d_replay/pause`, `/resume`, `/seek`,
`/set_rate`, `/is_paused`, `/get_rate`, `/set_loop`), or opt into the central widget below. The
adapter republishes selected PointCloud2 topics and TF, not unrelated video or other bag topics.
`--tf`, `--tf-static`, and `--state-topic` support alternative topic names; configure the viewer
to match. `playback_state_topic: ""` disables snapshot discovery. Use `playback_service` to bind
a view to a particular adapter name when needed. Multiple clock or snapshot publishers are
diagnosed as ambiguous.

## Optional central controls

This widget is independent of the 3D tab and is never added automatically:

```yaml
# Under home.widgets:
- type: rosbag_playback
  label: Replay controls
  # domain_id: 0
  # service: /ros3d_replay   # otherwise select a discovered player
  # state_topic: /ros3d/replay_state
```

It discovers native rosbag2 service schemas through the existing service client. Pause/resume,
rate, and absolute ROS-time seek appear for advertised capabilities. Restart and a runtime loop
toggle are available with the adapter. Native players can still loop through their launch options.
No camera playback contract or dependency pins were changed.

## Limits and transport behavior

Defaults are 500,000 sampled points per incoming cloud, 2 million retained points per scene,
128 MiB for conservatively estimated retained CPU/GPU data and pending scans across views,
10 seconds of dynamic TF, and 500 ms of live TF wait. YAML also accepts `max_cloud_points`,
`max_points`, `max_memory_mb`, `tf_history_s`, and `tf_wait_ms`; the shared application budget
still applies. Incoming messages and parsed output are each limited to 64 MiB. The shared worker
has at most eight queued messages (64 MiB aggregate), with one active message; latest decoded
cloud caches have a separate 64 MiB budget. These bound application data, not total browser/driver
memory. Visible canvases have a 30 FPS ceiling; hidden views stop uploads/drawing and release
their GPU scans. All views continue bounded shared ingestion.

Sampling reduces browser/GPU work, not network bandwidth. High-rate sensors may need producer-side
rate limiting or downsampling. The status shows delivered rate, dropped work, pending transforms,
point counts, and available TF edges. Lyrical INT64/UINT64 fields outside JavaScript's exact numeric
range are omitted with a warning. Header times stay integer nanoseconds.

The raw stream pool shares one subscription per domain/topic/type/hash key, including existing
readouts. For Lyrical buffer-aware clouds it announces a CPU ROS subscriber and excludes accelerated
descriptor channels. Static history queries explicitly address Zenoh's `@adv` cache namespace,
accept original topic-key replies, query all publishers without consolidation, and merge them with
live traffic. These behaviors were verified against rmw_zenoh 0.10.5 and zenoh-ts 1.9.0 without
upgrading the dashboard's working dependencies. Relevant upstream details:
[rmw_zenoh publisher implementation](https://github.com/ros2/rmw_zenoh/blob/0.10.5/rmw_zenoh_cpp/src/detail/rmw_publisher_data.cpp),
[Zenoh advanced subscriber](https://github.com/eclipse-zenoh/zenoh/blob/main/zenoh-ext/src/advanced_subscriber.rs).

## Reproduce validation

In the pinned Lyrical environment:

```sh
# Deterministic moving sensor observing stationary ground and two walls.
python3 tools/ros3d_fixture.py --points 30000

# Or generate a bag containing /tf_static, /tf, /ouster/points (no recorded clock).
python3 tools/ros3d_fixture.py --bag /tmp/ros3d-bag --duration 12 --hz 10 --points 30000
python3 tools/ros3d_replay.py /tmp/ros3d-bag --start-paused --loop

# Native reader/index/paused seek/rate/loop tests (use a separate domain).
ROS_DOMAIN_ID=37 python3 -m unittest discover -s tools -p test_ros3d_replay.py

# Regenerate the committed small native CDR fixtures and native tf2 oracle.
python3 tools/ros3d_fixture.py --cdr app/src/ros3d/fixtures
```

In `app/`, run `npm test` and `npm run build`. `node tools/ros3d_dev.mjs` (from the repository
root) serves a test dashboard on port 5178 pointing at a remote-api sidecar on port 11000;
it does not overwrite deployment config. Automated tests cover native Lyrical CDR/TF agreement,
endian/stride/field parsing, transform direction/interpolation, shared subscriptions, static
late joining, worker generations/overload, history decay and resets, and budgets. Browser checks
used 30,000-point scans at 10 Hz with roughly 900,000 accumulated points, two static publishers,
overlays, field coloring, tab switching, external paused seeking, and looping. Real Ouster hardware
and a complete user recording remain to be validated.
