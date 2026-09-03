# Rig deployment control (Zenoh)

A **vehicle-side agent** that exposes a [rig](https://github.com/christomaszewski/rig) deployment
over Zenoh: the deployment's rows and their live state, the run registry, and a small set of rig
verbs (standby/activate, up/down, new-run/end-run) run as **asynchronous jobs**. rig itself is a
one-shot CLI with no daemon and no network surface; this agent is the daemon half, so an operator
dashboard — or any Zenoh consumer — can see and drive the deployment without a shell on the vehicle.

> **This document is the source of truth, not any shared library.** Producers and consumers share
> *this contract*, not code. The reference producer is `agent/` in the dashboard repo
> (`dashboard-rig-agent`, an opt-in compose service); nothing in the contract is dashboard-specific.

The shape follows the service-lifecycle convention (camera-service `docs/LIFECYCLE.md`): a liveliness
token for presence at the same key as a descriptor queryable, JSON payloads, `{ok:false, error}`
refusals instead of Zenoh-level errors, and a peer-mode session that keeps retrying the router.
The two conventions are complementary, not alternatives: a service that **self-advertises** its
lifecycle (`fleet/<vid>/svc/<instance>/lifecycle`) is controlled through that key; the rig agent
covers what only rig knows — compose state per row, the run registry, and the launcher-level
`standby`/`activate` verbs of services that declare rig's operational-state trio instead.

## Key schema

One agent per vehicle; the **deployment** is the noun. `<vid>` is `str(vehicle_id)` — the same
segment every other `fleet/<vid>/…` key uses (rig exports it as `VEHICLE_ID`).

```
fleet/<vid>/rig               liveliness token + queryable → descriptor
fleet/<vid>/rig/state         publisher (on change + heartbeat) + queryable → state snapshot
fleet/<vid>/rig/runs          queryable → run registry rows
fleet/<vid>/rig/run/<run_id>  queryable (wildcard-declared) → one run: its manifest as JSON
fleet/<vid>/rig/jobs          queryable → recent job records, the running one first
fleet/<vid>/rig/jobs/submit   queryable, JSON payload → {ok, job_id, job} | {ok:false, error}
fleet/<vid>/rig/jobs/cancel   queryable, JSON payload {job_id} → {ok, job} | {ok:false, error}
fleet/<vid>/rig/jobs/events   publisher: a job record on every transition and progress tick
```

`run/<run_id>` and `jobs/…` are distinct prefixes on purpose: no wildcard queryable overlaps a fixed
one, so every `get` has exactly one answering queryable. A consumer watches `fleet/*/rig`
(liveliness, history) and subscribes to `fleet/*/rig/state` and `fleet/*/rig/jobs/events`.

| Zenoh primitive | Key | Role |
|---|---|---|
| **Liveliness token** | `…/rig` | presence — the agent is up and has a state snapshot |
| **Queryable** | `…/rig` | the **descriptor** (identity, versions, capabilities) |
| **Queryable + publisher** | `…/rig/state` | the **state snapshot**; the publication and the cold `get` are the same document |
| **Queryable** | `…/rig/runs`, `…/rig/run/<id>` | the run registry (filesystem-derived, rig's semantics) |
| **Queryable** | `…/rig/jobs`, `…/rig/jobs/submit`, `…/rig/jobs/cancel` | asynchronous verbs |
| **Publisher** | `…/rig/jobs/events` | job records as they change |

Every reply is UTF-8 JSON (`application/json`). Refusals are `{"ok": false, "error": "…"}` — never a
Zenoh-level error, never a missing reply. Every queryable answers within ~2 s from a cached snapshot
or the filesystem; **no queryable ever blocks on docker or rig**.

## Descriptor (`…/rig` reply)

```jsonc
{
  "schema_version": 1,                // REQUIRED
  "service": "rig-agent",             // REQUIRED
  "vehicle_id": "1",                  // REQUIRED. == the <vid> key segment
  "vehicle": "orin-dev",
  "agent_version": "0.1.0",
  "rig_version": "0.2.46",            // the rig the agent drives (the deployment tree's own copy)
  "root": "/home/uxv/ws/test1",       // the deployment tree (vehicle.yaml lives here)
  "data_dir": "/home/uxv/logs",       // the run registry's host dir, or null (registry inert)
  "capabilities": {
    "actuate": true,                  // false = read-only agent: submit refuses every verb
    "verbs": ["standby", "activate", "up", "down", "new-run", "end-run"],
    "jobs": true },
  "self_instance": "dashboard",       // the vehicle.yaml row whose compose project hosts the agent, or null
  "poll_s": 10,                       // status poll cadence; consumers treat a snapshot older than 3× as stale
  "since_unix_s": 1756700000.0,
  "job": { … } | null                 // the running job record, if any
}
```

## State snapshot (`…/rig/state`)

Published on every change (a stack's compose state, the open run, a job transition) and as a
heartbeat every 60 s; the same document answers a cold `get`.

```jsonc
{
  "schema_version": 1, "vehicle_id": "1", "vehicle": "orin-dev",   // REQUIRED
  "at_unix_s": 1756700010.2,          // REQUIRED. when `rig status` last answered
  "ok": true,                         // false = the last `rig status` failed; rows are the last good ones
  "error": null,                      // the failure, verbatim
  "rig_version": "0.2.46",
  "run": null | {                     // the OPEN run (registry `current`), or null
    "id": "20260902T143000Z_flight1", "label": "flight1" | null,
    "started": "2026-09-02T14:30:00+00:00",
    "stacks": ["zenoh-router", "bag_logger", "cam_front"],   // manifest `stacks:` (from `rig up`)
    "disk_kb": 123456 | null },       // du of the run dir, refreshed every 30 s
  "registry": { "data_dir": "/home/uxv/logs" | null, "free_kb": 987654 | null, "problem": null | "…" },
  "stacks": [                         // REQUIRED. rig's order: infra → sensors → autonomy, then `order`
    { "name": "cam_front", "service": "camera-service", "tier": "sensor", "order": 30,
      "enabled": true, "project": "cam_front-vehicle-1",
      "state": "running" | "partial" | "down",                 // `rig status` compose roll-up, verbatim
      "health": "healthy" | "unhealthy" | "starting" | "n/a" | "-",
      "op_state": "active" | "standby" | "transitioning" | "down" | "unknown" | null,  // null = no trio
      "running": 2, "total": 2,
      "state_verbs": false,           // declares rig's standby/activate/state trio
      "self": false } ],              // this row hosts the agent
  "job": { … } | null
}
```

`state`, `health` and `op_state` are passed through from `rig status --format json` **verbatim** —
the agent never re-interprets rig's roll-up (rig's own doctrine: state and health are read as a pair
by the consumer). Disabled rows are included with `state: "down"` so a consumer can show the whole
manifest; they accept no verbs.

## Runs

`…/rig/runs` — rig's `list_runs` semantics, derived from the documented registry layout
(`<data_dir>/runs/<id>/manifest.yaml`, `ended:` present ⇔ sealed; the relative `current` symlink ⇔
the open run):

```jsonc
{ "schema_version": 1, "ok": true,
  "data_dir": "/home/uxv/logs", "current": "20260902T143000Z_flight1" | null,
  "problem": null | "…",              // a broken `current` (not a symlink / points outside the registry)
  "runs": [ { "run": "20260902T143000Z_flight1", "label": "flight1" | null,
              "state": "OPEN" | "sealed" | "interrupted" | "corrupt" | "dangling",
              "started": "…" | null, "ended": "…" | null, "disk_kb": 4711 | null,
              "replay_of": null | "<run id>", "linked": false } ] }
```

`…/rig/run/<run_id>` → `{"schema_version": 1, "ok": true, "run": "<id>", "state": "sealed",
"dir": "<absolute path>", "manifest": {…manifest.yaml as JSON…}}`, or `{"ok": false, "error": "no
such run"}`. With no `data_dir` both reply `ok: true` with an empty list / `"error": "registry
inert (no data_dir)"` respectively.

**Files are not part of this contract.** A run directory's layout (`bags/`, `recordings/<instance>/`,
`graph/`, `.rig/…`) is rig's filesystem convention; a host that wants downloads serves `data_dir`
over HTTP (the dashboard does, at `/rig-data/`).

## Jobs — asynchronous verbs

rig verbs are slow (`activate` is O(minute) per device; `down --end-run` captures container logs
before teardown) and one of them — `down` including the agent's own row, or `down --end-run` —
**removes the agent's own container mid-verb**. So verbs are **jobs**: `submit` replies promptly
with a `job_id`; progress and the terminal record are published on `…/jobs/events` and persisted
on the vehicle; the verb runs in a **detached runner** outside any compose project, which finishes
(and seals the run) even after the agent is gone. One job runs at a time — rig verbs are not
concurrent-safe (registry symlink flips, compose calls).

### Request (`…/rig/jobs/submit`)

A JSON object payload on the `get` (or, for a payload-less get, selector parameters —
`…/submit?verb=standby;names=cam_front`):

```jsonc
{ "verb": "standby",                  // REQUIRED. standby | activate | up | down | new-run | end-run
  "names": ["cam_front"],             // standby/activate/up/down: row names; default = rig's "all enabled"
  "label": "flight1",                 // new-run only; [A-Za-z0-9][A-Za-z0-9_-]*
  "force": false,                     // new-run / end-run / up / down: `--force`
  "end_run": false,                   // down only: `rig down --end-run` (stop everything, then seal)
  "timeout_s": 600,                   // optional; clamped to [30, 1800]; per-verb defaults below
  "client": "dashboard 10.160.1.5" }  // free text, recorded on the job
```

Reply (≤ 2 s): `{"ok": true, "job_id": "j-20260902T143000Z-a1f2", "job": {…}}`, or `ok: false` with
one of: `busy: <job_id> (<verb>) is running` (with `job_id`), `unknown row '<name>' (rows: …)`,
`standby/activate: '<name>' declares no state verbs`, `'label' must match …`, `actuation disabled`.

### Job record (persisted; published on `…/jobs/events`; listed by `…/jobs`)

```jsonc
{ "schema_version": 1, "job_id": "j-20260902T143000Z-a1f2",
  "verb": "down", "args": { "names": [], "force": false, "end_run": true },
  "argv": ["down", "--end-run"],      // exactly what ran after `rig --root <root>`
  "client": "dashboard 10.160.1.5",
  "self_terminating": true,           // the verb tears down the agent's own compose project
  "state": "queued" | "running" | "succeeded" | "failed" | "killed" | "cancelled",   // REQUIRED
  "submitted_unix_s": …, "started_unix_s": …, "ended_unix_s": …, "deadline_unix_s": …,
  "exit_code": 0 | null,
  "error": null | "new-run: stacks are running (cam_front-vehicle-1) — …",   // rig's message, verbatim
  "error_kind": null | "guard-running" | "guard-cannot-tell" | "bad-label" | "no-data-dir"
                    | "timeout" | "other",
  "guard_projects": ["cam_front-vehicle-1"],   // when error_kind == guard-running
  "log_tail": ["==> cam_front [camera-service]: …", "rig: sealed run …"],   // last 40 lines, both streams
  "result": { "run_before": "20260902T…_flight1" | null, "run_after": null,
              "sealed": "20260902T…_flight1" | null, "opened": null } }
```

`result` is **re-read from the registry** after the verb — never parsed from rig's prose.
`error_kind` is a best-effort classification of rig's stderr so a consumer can offer the right next
step (`--force`, "stop the stacks first", "retry"); unknown wording degrades to `other` with the
verbatim `error`. Default deadlines (seconds): standby 300, activate 600, new-run 60, end-run 180,
up 600, down 300, down + `end_run` 900. Progress events fire while `log_tail` changes (≥ 2 s apart);
`cancel` stops the runner (`killed` → `cancelled`); the deadline stops it with `error_kind: timeout`.
Records survive agent restarts; a runner still finishing when the agent restarts is re-attached.

### The seal guard

rig refuses `new-run` and `end-run` while **any enabled row's compose project runs** — including the
project hosting the agent — unless `force` is set. From a live dashboard, therefore, "end the run"
is either `end-run` + `force` (seal now; still-running services keep writing to the sealed run's
directory) or `down` + `end_run` (stop everything, seal, and lose the agent — which is why the runner
is detached). The agent surfaces the refusal verbatim with `guard_projects` and leaves the choice to
the consumer.

## Liveliness / session (producer side)

Same rules as LIFECYCLE.md: one peer-mode session; queryables and publishers declared **before** the
token; the token declared only once the **first state snapshot exists** (a consumer reacting to the
token always finds a state to query); token undeclared on graceful stop; a crash withdraws it.
Endpoints from `ZENOH_CONNECT` (default `tcp/localhost:7447`; empty = scout only), finite
`connect/timeout_ms` (2000) with `exit_on_failure: false`, and a retry timer while the router is
unreachable. `ZENOH_LISTEN` (optional) makes the agent listen too — bench use, when no router runs.

## Security

The agent holds the host's docker socket and the deployment tree: it is **root-equivalent on the
vehicle**, and its verbs stop the whole stack. The mesh is the trust boundary today (no auth on any
`fleet/**` key), but this is a larger actuation surface than the ROS bus, so producers must:

- be **opt-in** (the dashboard: `rig_agent: true` in the instance YAML — absent = no agent, no socket);
- accept a **fixed verb whitelist with validated arguments** — row names must exist in the manifest,
  labels are regex-checked, no free-form argv ever reaches rig;
- offer a **read-only mode** (`capabilities.actuate: false`; the dashboard: `rig_actuate: false`)
  in which every `submit` is refused with `actuation disabled`;
- record `client` on every job. A key-scoped sidecar ACL (`deny` queries on `fleet/*/rig/jobs/**`)
  is a further option that does not break discovery.

## Consumer recipe

```python
# presence + cold snapshot
for token in session.liveliness().get("fleet/*/rig"):
    base = str(token.key_expr)
    descriptor = json.loads(session.get(base).next().ok.payload.to_bytes())
    state = json.loads(session.get(base + "/state").next().ok.payload.to_bytes())

# live
session.liveliness().declare_subscriber("fleet/*/rig", on_presence, history=True)
session.declare_subscriber("fleet/*/rig/state", on_state)
session.declare_subscriber("fleet/*/rig/jobs/events", on_job)

# a verb
for reply in session.get(base + "/jobs/submit", payload=b'{"verb":"standby","names":["cam_front"]}',
                         encoding=Encoding.APPLICATION_JSON, timeout=5.0):
    ack = json.loads(reply.ok.payload.to_bytes())    # {"ok": true, "job_id": "…", "job": {…}}
```

## Versioning

Fields are only ever **added**; `schema_version` bumps on a breaking change. Consumers must ignore
unknown fields and tolerate missing optional ones.

## Producers

| Producer | Status | Notes |
|---|---|---|
| dashboard `agent/` (`dashboard-rig-agent`) | **implemented** | Polls `rig status --format json` from the deployment tree's own `rig_cli`; runs jobs in detached `docker run` containers; see `deploy/README.md` for the mounts and the uid/gid rationale. |
