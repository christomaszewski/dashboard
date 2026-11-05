# Current-run feed

`dashboard-state` owns a small, read-only JSON feed at `fleet/<vid>/rig/current_run` for other
Zenoh-enabled services. The same key supports a query for the latest value and publications when
it changes, plus a 30-second heartbeat. This does not require `dashboard-rig-agent`, the Rig CLI,
a deployment tree, or Docker socket access. The dashboard header reads the same cached value
through the optimized vehicle-state view/poll protocol; it does not subscribe to this feed.

Rig already exports **`RIG_DATA_DIR`**, the registry root, to the dashboard launcher. `dash-up`
mounts that directory read-only into `dashboard-state` at its host path (or uses an explicit
`rig_data_dir:` override). The state service reads
`<data_dir>/current` to find the open run and follows changes to the symlink and manifest, including
changes made by the Rig CLI. No separate run-directory launcher argument is needed. The registry
watcher checks every two seconds and never scans run contents or computes disk usage.

When a registry directory is available, `dash-up` starts `dashboard-state` even if `vehicle_state`
is off. It shares the stock, uncapped `dashboard-zenoh` bridge over loopback at the configured
`ws_port`. If the effective `DASH_ZENOH_CONFIG` is nonempty (generated topic caps or an external
custom override), `dash-up` also selects the private stock bridge overlay so generic state APIs
retain uncapped ingestion. `state_ws_port` applies only in that private mode. In run-only mode,
only the current-run header uses the optimized path; other widgets retain their configured direct
transport. `/config/runtime.json` supplies
`current_run_state_key` for the header. With `vehicle_state: true`, the header shares the existing
view and poll connection with the other widgets. A stable run produces no repeated run payload in
browser polls; ordinary empty poll replies confirm the service is still reachable.
With no registry directory configured, no native current-run endpoint is declared and the header
is hidden. A manually requested vehicle-state current-run item reports that it is not configured.

```json
{
  "schema_version": 1,
  "vehicle_id": "1",
  "epoch": "b62a37f2e9f843c0a8beac4e6f295bb1",
  "revision": 3,
  "at_unix_s": 1793887200.0,
  "ok": true,
  "run_id": "20261105T140000Z_flight1",
  "run_dir": "/data/runs/20261105T140000Z_flight1",
  "label": "flight1",
  "started": "2026-11-05T14:00:00+00:00",
  "error": null
}
```

- `run_id` is the registry directory name. `run_dir` is its resolved path on the vehicle;
  another service can access it only if it has an appropriate mount.
- With no open run, `ok` is `true` and all four run fields (`run_id`, `run_dir`, `label`, `started`)
  are `null`. Opening, rotating, and closing a run all produce updates.
- With an unreadable registry or a corrupt current manifest, `ok` is `false`,
  the run fields are `null`, and `error` explains why. Consumers must distinguish this from a
  confirmed absence of an open run.
- `epoch` changes when the state service process restarts. `revision` starts at 1 and increases when the
  run identity, metadata, or error changes. Revision 1 can be an initial unavailable placeholder
  while the first registry read is pending. Unchanged reads and heartbeats keep the same revision.
- `at_unix_s` records the state service's registry observation time. Consumers should measure freshness
  from their own receipt time; their clocks need not agree with the vehicle.

The producer uses Rig's `VEHICLE_ID`, then dashboard `vehicle_id:`, then the host's short name.
Use one current-run producer per vehicle. To consume the feed, use your service's `VEHICLE_ID` to
form the exact key above. Subscribe first,
then query that key to obtain the initial value. Ignore a late query reply if a publication has
arrived since the query began, and ignore lower revisions within the current epoch. A new epoch
starts a new revision sequence; do not accept delayed messages from a retired epoch. Wildcard
queries reply on each producer's concrete key, and the payload's `vehicle_id` identifies the source.
The Rig agent liveliness token does not describe this producer. Requery after reconnect.
The 30-second heartbeat repairs missed updates; after 90 seconds without a fresh observation,
treat the value as unverified. Recording commands are never issued by this feed.

The dashboard header follows this feed without requiring the Rig tab to be visible. It shows the
full run ID (with overflow ellipsis and full details in the tooltip), no open run, or unavailable
state, labelled with the vehicle ID. It addresses this dashboard's configured state service,
so agents elsewhere on the mesh cannot change the displayed run.

This describes the **currently open registry run**. A recorder that pins its output directory at
process startup may still be writing to an earlier run after a forced rotation; this feed does not
retarget it.
