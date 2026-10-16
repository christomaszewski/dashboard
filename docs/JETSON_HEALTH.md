# Jetson temperatures and power profile

`jetson-manager` publishes standard ROS `DiagnosticArray` on `/diagnostics`.
The existing Home/compact Health widget and Health tab show its temperatures,
input watts and **Power profile** (the observed nvpmodel name and numeric ID).
No custom ROS message package, Jetson library or new frontend dependency is needed.

Identity follows [SERVICE_HEALTH.md](SERVICE_HEALTH.md): `health.vehicle_id`,
`health.instance`, `health.service=jetson-manager`. For example:

```yaml
- type: health
  label: Platform health
  services: ["1/jetson"]       # actual vehicle ID / rig instance; omit for discovery
  history_s: 300
  precision: 1
```

The ROS adapter recognizes `temp.<zone>_c`, `supply.power_w`, numeric
`power.mode_id`, string `power.mode_name`, and boolean `power.switching`.
Rows are `<instance>: temperature/<zone>` and `<instance>: power_mode`.
Names and IDs come from the observed hardware state, never the requested target.
Switching keeps the last observed mode visible until read-back changes it.
Silence, disconnects and old samples show **last known**; unknown names show a
dash. A valid mode ID of zero is preserved. Mode is not estimated from watts.
Standby still reports health; component filters and existing health-picker
selection apply. If a saved manual selection hides Jetson, choose it or select
**All reporters**. Use the same ROS domain/router as the service.

`app/src/health/jetson-fixture.json` is explicitly synthetic MockBackend data,
serialized by Lyrical rclpy using the real Jetson diagnostic producer. Regenerate
in a built jetson-manager ROS workspace:

```bash
python3 tools/generate_health_fixture.py > jetson-fixture.json
```

`JetsonSummary.test.tsx` decodes the CDR with the normal browser decoder, routes
it through the fleet health store and tests all three UI views, missing/stale
readings, disconnects, component filters and switching semantics. Hardware
verification is separate; this fixture is not a real Orin capture.
