# agent — `dashboard-rig-agent`

The vehicle-side producer of the rig-over-Zenoh contract in [docs/RIG_AGENT.md](../docs/RIG_AGENT.md):
polls `rig status --format json`, mirrors the run registry, and runs a whitelisted set of rig verbs as
detached jobs. Ships as the optional third compose service (`deploy/docker-compose.rig-agent.yml`,
applied by `dash-up` when the instance YAML sets `rig_agent: true`); nothing in it is dashboard-specific.

```
rig_agent/
  config.py     AgentConfig.from_env() — the env contract below
  keys.py       fleet/<vid>/rig/… key builders
  rigcmd.py     python3 -m rig_cli --root <root> … from the TREE's rig_cli (no rig in the image)
  status.py     parse `rig status --format json`
  vehicle.py    raw vehicle.yaml rows + which services declare the standby/activate/state trio
  registry.py   the run registry, rig's semantics without importing rig
  requests.py   submit payload → validated request → rig argv (the verb whitelist)
  guard.py      classify rig's stderr (guard-running / cannot-tell / bad-label / …)
  jobs.py       job records + the on-disk store
  runner.py     detached job runners (docker sibling container | subprocess) + the in-runner entry
  snapshot.py   state / descriptor documents
  docker_logs.py read-only Docker inventory + bounded timestamped log tails (Logs tab)
  agent.py      the Zenoh adapter, poll/watch/worker threads, job supervision
  __main__.py   serve | run-job <id> | status
tests/          stdlib unittest; the pure modules import with no zenoh binding and no docker
```

## Run

```sh
cd agent && python3 -m unittest discover -s tests -v                  # tests (needs pyyaml only)

# bench: natively, against a dev tree, jobs as child processes, talking to a vehicle's router
pip install -r requirements.txt
RIG_ROOT=/path/to/bringup RIG_AGENT_RUNNER=subprocess ZENOH_CONNECT=tcp/<vehicle>:7447 \
  python3 -m rig_agent serve
RIG_ROOT=/path/to/bringup python3 -m rig_agent status               # one poll, printed
```

On the vehicle the compose overlay runs `serve` in the `dashboard-rig-agent` image with the docker socket,
the deployment tree (read-only, at its host path) and its `var/` (read-write) mounted — see
[deploy/README.md](../deploy/README.md).

The optional Logs tab uses the same agent, including in read-only mode. Docker reads run on at
most two separate workers, with a three-second command deadline and bounded output; they never
queue behind rig jobs or block Zenoh callbacks. No `docker logs --follow` processes are left
running. See [the log query contract](../docs/RIG_AGENT.md#docker-logs).

Job supervision preserves active work when Docker cannot answer. Recovery retries before accepting
new commands; a lost launch reply is reconciled without rerunning the verb. Cleanup never force-removes
runners. Cancellation is acknowledged immediately and performed by supervision, including retries
after a failed stop. Read-only mode refuses both submit and cancel.

For the opt-in Docker bench, build an image containing the current code, then run from `agent/`:

```sh
RIG_AGENT_DOCKER_TEST_IMAGE=dashboard-rig-agent:local \
RIG_AGENT_TEST_RIG_SOURCE=/absolute/path/to/rig \
PYTHONPATH=tests python3 -m unittest -v test_docker_integration
```

This creates uniquely labeled disposable runners and scratch directories. It tests observation
outages, recovery after closing/recreating the agent, lost launch replies, failed-stop retries,
and real rig run creation/sealing in an empty deployment. It does not restart the Docker daemon
or operate vehicle services. Without the image variable the tests are skipped; without the rig
source variable only the real CLI test is skipped. The CLI check requires rig v0.2.70 or later,
which makes `rig down --end-run` seal even when no stacks are selected. Update the deployment's
rig CLI along with the agent image to include this fix.

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `RIG_ROOT` | the deployment tree (vehicle.yaml); must be an absolute HOST path (identity mount) | required |
| `RIG_DATA_DIR` | the run registry's host dir | unset → registry inert |
| `RIG_MOUNT` | the identity-mounted dir the runner must also mount (a dev catalog's `../sibling` checkouts) | `RIG_ROOT` |
| `RIG_VEHICLE_LOCAL` / `RIG_VEHICLE_LOCAL_HOST` | machine identity file inside the container / on the host | `/etc/rig/vehicle.local.yaml` / unset |
| `ZENOH_CONNECT` / `ZENOH_LISTEN` | endpoints (comma-separated; empty `ZENOH_CONNECT` = scout only) | `tcp/localhost:7447` / none |
| `RIG_AGENT_POLL_S` | `rig status` cadence | 10 |
| `RIG_AGENT_ACTUATE` | `0` = read-only agent (submit and cancel refused) | 1 |
| `RIG_AGENT_RUNNER` | `docker` (detached sibling container) or `subprocess` (bench) | docker |
| `RIG_AGENT_IMAGE` | the image `docker run` uses for jobs (the agent's own) | `dashboard-rig-agent:local` |
| `RIG_AGENT_PROJECT` | the compose project hosting the agent → the `self` row | unset |
| `RIG_AGENT_USER` / `RIG_AGENT_GROUPS` | uid:gid / extra gids mirrored onto runners | unset |
| `RIG_AGENT_STATE_DIR` | job records + logs | `<RIG_ROOT>/var/dashboard-rig-agent` |
| `RIG_AGENT_LOG` | log level | INFO |

## Why a detached runner

`rig down --end-run` (and any `down` that includes the dashboard's row) removes the agent's own
container part-way through the verb. A verb run in-process would die with it, leaving the remaining
stacks up and the run unsealed. So every job runs in a sibling `docker run` container without compose
labels: `compose down` cannot see it, it finishes and seals, and it writes the terminal record itself
(`run_job`); the agent, when it comes back after `rig up`, finds the record in the state dir.
