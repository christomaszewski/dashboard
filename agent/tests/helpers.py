"""Shared fakes for the agent tests: a config over a temp tree, a canned `run_rig`, fake zenoh
session/query objects (the shape camera-service's tests use), and a scripted runner."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from rig_agent.config import AgentConfig  # noqa: E402
from rig_agent.rigcmd import RigResult  # noqa: E402

STATUS_JSON = {
    "run": None,
    "stacks": [
        {"health": "healthy", "op_state": None, "running": 1, "sensor": "zenoh-router", "service": "zenoh-router", "state": "running", "total": 1},
        {"health": "-", "op_state": None, "running": 0, "sensor": "dashboard", "service": "dashboard", "state": "down", "total": 0},
        {"health": "healthy", "op_state": None, "running": 2, "sensor": "cam_front", "service": "camera-service", "state": "running", "total": 2},
        {"health": "healthy", "op_state": "standby", "running": 1, "sensor": "lidar", "service": "ouster", "state": "running", "total": 1},
    ],
    "vehicle": "orin-dev",
    "vehicle_id": 1,
}

VEHICLE_YAML = """\
vehicle: orin-dev
vehicle_id: 1
infra:
  - { name: zenoh-router, service: zenoh-router, config: config/infra/zenoh-router.yaml, order: 0 }
  - { name: dashboard, service: dashboard, config: config/infra/dashboard.yaml, order: 5 }
sensors:
  - { name: cam_front, service: camera-service, config: config/sensors/cam_front.yaml, order: 30 }
  - { name: lidar, service: ouster, config: config/sensors/lidar.yaml, order: 20 }
  - { name: "{{vehicle}}_gps", service: novatel, config: config/sensors/gps.yaml }
autonomy:
  - { name: bag_player, service: ros2-bag-player, config: config/autonomy/player.yaml, enabled: false }
"""

SERVICES_YAML = """\
services:
  zenoh-router: { path: ../rig-infra/zenoh-router }
  dashboard: { path: ../dashboard }
  camera-service: { path: ../camera-service }
  ouster: { path: ../ouster }
  novatel: { path: ../novatel }
  ros2-bag-player: { path: ../rig-infra/ros2-bag-player }
"""

OUSTER_RIGGING = """\
service: ouster
launcher: ouster-up
verbs: { up: "up -d", down: "down", standby: "standby", activate: "activate", state: "state" }
"""

CAMERA_RIGGING = """\
service: camera-service
launcher: cam-up
verbs: { up: "up -d", down: "down" }
"""

PARTIAL_RIGGING = """\
service: novatel
verbs: { standby: "standby", activate: "activate" }
"""


def make_tree(base: Path, *, data_dir: bool = True, rig: bool = True) -> Path:
    """A deployment tree under base/ws/bringup with sibling service checkouts, like a dev workspace."""
    ws = base / "ws"
    root = ws / "bringup"
    root.mkdir(parents=True)
    (root / "vehicle.yaml").write_text(VEHICLE_YAML)
    (root / "services.yaml").write_text(SERVICES_YAML)
    if rig:
        (root / "rig_cli").mkdir()
        (root / "rig_cli" / "__init__.py").write_text("__version__ = '0.2.46'\n")
    (ws / "ouster").mkdir()
    (ws / "ouster" / "rigging.yaml").write_text(OUSTER_RIGGING)
    (ws / "camera-service").mkdir()
    (ws / "camera-service" / "rigging.yaml").write_text(CAMERA_RIGGING)
    (ws / "novatel").mkdir()
    (ws / "novatel" / "rigging.yaml").write_text(PARTIAL_RIGGING)
    if data_dir:
        (base / "data").mkdir()
    return root


def make_config(root: Path, **overrides) -> AgentConfig:
    env = {
        "RIG_ROOT": str(root),
        "RIG_DATA_DIR": str(root.parent.parent / "data") if (root.parent.parent / "data").is_dir() else "",
        "RIG_MOUNT": str(root.parent),
        "RIG_AGENT_RUNNER": "subprocess",
        "RIG_AGENT_PROJECT": "dashboard-vehicle-1",
        "ZENOH_CONNECT": "tcp/localhost:7447",
    }
    env.update({k: str(v) for k, v in overrides.items()})
    return AgentConfig.from_env(env)


def result(args, *, rc=0, stdout="", stderr="", timed_out=False, stopped=False) -> RigResult:
    return RigResult(list(args), rc, stdout, stderr, timed_out=timed_out, stopped=stopped,
                     lines=[ln for ln in (stdout + stderr).splitlines() if ln])


def scripted_run_rig(script):
    """A run_rig whose replies come from `script(args) -> RigResult`; records every call."""
    calls = []

    def run_rig(cfg, args, timeout_s, on_line=None, env=None, stop=None):
        calls.append((list(args), timeout_s))
        res = script(list(args))
        if on_line is not None:
            for line in res.lines:
                on_line(line)
        return res

    run_rig.calls = calls
    return run_rig


def status_run_rig(doc=STATUS_JSON):
    def script(args):
        if args[:1] == ["--version"]:
            return result(args, stdout="rig 0.2.46\n")
        if args[:2] == ["status", "--format"]:
            return result(args, stdout=json.dumps(doc) + "\n")
        return result(args, rc=1, stderr=f"rig: unexpected verb {args}\n")
    return scripted_run_rig(script)


# ---- fake zenoh -----------------------------------------------------------------------------
class Declared:
    def __init__(self, key):
        self.key = key
        self.undeclared = 0

    def undeclare(self):
        self.undeclared += 1


class Publisher(Declared):
    def __init__(self, key):
        super().__init__(key)
        self.puts = []

    def put(self, payload, encoding=None):
        self.puts.append(json.loads(payload))


class Liveliness:
    def __init__(self, session):
        self._s = session

    def declare_token(self, key):
        t = Declared(key)
        self._s.tokens.append(t)
        return t


class Session:
    def __init__(self, connect, listen):
        self.connect = list(connect)
        self.listen = list(listen)
        self.queryables = {}
        self.publishers = {}
        self.tokens = []
        self.closed = 0
        self.order = []   # declaration order: "q:<key>", "p:<key>", "t:<key>"

    def declare_queryable(self, key, cb):
        q = Declared(key)
        self.queryables[key] = (cb, q)
        self.order.append("q:" + key)
        return q

    def declare_publisher(self, key):
        p = Publisher(key)
        self.publishers[key] = p
        self.order.append("p:" + key)
        return p

    def liveliness(self):
        self.order.append("t")
        return Liveliness(self)

    def close(self):
        self.closed += 1


class Payload:
    def __init__(self, b):
        self._b = b

    def to_bytes(self):
        return self._b


class Query:
    def __init__(self, key, payload=None, parameters=""):
        self.key_expr = key
        self.payload = Payload(payload) if payload is not None else None
        self.parameters = parameters
        self.replies = []

    def reply(self, key, payload, encoding=None):
        self.replies.append((str(key), json.loads(payload)))

    @property
    def last(self):
        return self.replies[-1][1]


class FakeRunner:
    """Scripted runner: `spawn` either runs `on_spawn(job)` synchronously (write a terminal record
    like the real runner would) or leaves the job 'running' until `stop` is called."""

    kind = "fake"

    def __init__(self, on_spawn=None, fail_spawn=None):
        self.on_spawn = on_spawn
        self.fail_spawn = fail_spawn
        self.spawned = []
        self.stopped = []
        self.cleaned = []
        self.running = {}
        self.leftovers = []

    def spawn(self, job):
        if self.fail_spawn:
            raise RuntimeError(self.fail_spawn)
        self.spawned.append(job.job_id)
        info = {"kind": self.kind, "job_id": job.job_id}
        if self.on_spawn is not None:
            self.running[job.job_id] = (False, self.on_spawn(job))
        else:
            self.running[job.job_id] = (True, None)
        return info

    def poll(self, info):
        return self.running.get(info["job_id"], (False, None))

    def stop(self, info):
        self.stopped.append(info["job_id"])
        self.running[info["job_id"]] = (False, 143)

    def cleanup(self, info):
        self.cleaned.append(info["job_id"])

    def sweep(self):
        return list(self.leftovers)


def tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="rig-agent-test-"))
