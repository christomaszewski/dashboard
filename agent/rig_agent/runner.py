"""Where a job's rig verb actually runs, and the in-runner entry point.

A verb like `down --end-run` tears down the compose project that hosts the agent, so a job never
runs inside the agent's own container: the `docker` runner starts a sibling container from the
agent's image — NO compose labels, so `compose down` cannot touch it — that outlives the agent,
finishes the verb, and writes the terminal record itself. The `subprocess` runner is the bench/dev
form (same in-runner code, a child process instead of a container).

Record ownership: from spawn until the record is terminal the RUNNER owns the JSON file; the agent
only reads it (log tail, progress) and merges at finalize. That is what keeps two processes from
racing on one file."""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable, Optional

from . import registry as registry_mod, rigcmd
from .config import AgentConfig
from .guard import classify_rig_error, error_message
from .jobs import LOG_TAIL_LINES, Job, JobStore

log = logging.getLogger("rig_agent.runner")

CONTAINER_PREFIX = "rig-agent-job-"
LABEL_JOB = "dashboard.rig-agent.job"
LABEL_VEHICLE = "dashboard.rig-agent.vehicle"
DOCKER_TIMEOUT_S = 30.0
STOP_GRACE_S = 15
RECORD_SAVE_INTERVAL_S = 2.0


class RunnerError(RuntimeError):
    pass


def container_name(job_id: str) -> str:
    return CONTAINER_PREFIX + job_id


def _within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def docker_run_argv(cfg: AgentConfig, job: Job, vehicle_id: str) -> list:
    """`docker run -d …` for one job: the agent's own mounts, identity paths, uid/gid, no compose
    labels, `run-job <id>` as the command."""
    argv = ["docker", "run", "-d", "--name", container_name(job.job_id),
            "--label", f"{LABEL_JOB}={job.job_id}", "--label", f"{LABEL_VEHICLE}={vehicle_id}",
            "--network", "host"]
    if cfg.user:
        argv += ["--user", cfg.user]
    for g in cfg.groups:
        argv += ["--group-add", g]
    argv += ["-v", "/var/run/docker.sock:/var/run/docker.sock",
             "-v", f"{cfg.mount}:{cfg.mount}:ro",
             "-v", f"{cfg.root / 'var'}:{cfg.root / 'var'}"]   # rig renders + mints under var/
    if cfg.data_dir:
        argv += ["-v", f"{cfg.data_dir}:{cfg.data_dir}"]
    if cfg.vehicle_local_host:
        argv += ["-v", f"{cfg.vehicle_local_host}:{cfg.vehicle_local}:ro"]
    if not _within(cfg.state_dir, cfg.root / "var") and not (cfg.data_dir and _within(cfg.state_dir, cfg.data_dir)):
        argv += ["-v", f"{cfg.state_dir}:{cfg.state_dir}"]
    env = dict(cfg.runner_env())
    env["HOME"] = str(cfg.state_dir / "home")
    for k in sorted(env):
        argv += ["-e", f"{k}={env[k]}"]
    argv += ["--entrypoint", "python3", cfg.image, "-m", "rig_agent", "run-job", job.job_id]
    return argv


class DockerRunner:
    """Jobs as detached sibling containers. `run` is subprocess.run (injectable)."""

    kind = "docker"

    def __init__(self, cfg: AgentConfig, vehicle_id: str, run: Callable = subprocess.run):
        self.cfg = cfg
        self.vehicle_id = vehicle_id
        self._run = run

    def _docker(self, args: list, timeout_s: float = DOCKER_TIMEOUT_S):
        return self._run(["docker", *args], capture_output=True, text=True, timeout=timeout_s)

    def spawn(self, job: Job) -> dict:
        proc = self._run(docker_run_argv(self.cfg, job, self.vehicle_id), capture_output=True, text=True,
                         timeout=DOCKER_TIMEOUT_S)
        if proc.returncode != 0:
            raise RunnerError(f"docker run failed (exit {proc.returncode}): {(proc.stderr or '').strip()[:300]}")
        return {"kind": self.kind, "container": container_name(job.job_id), "id": (proc.stdout or "").strip()[:12]}

    def poll(self, info: dict):
        """(running, exit_code). A vanished container reads as exited with no code."""
        proc = self._docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", info["container"]])
        if proc.returncode != 0:
            return False, None
        parts = (proc.stdout or "").split()
        running = bool(parts) and parts[0].lower() == "true"
        try:
            code = int(parts[1]) if len(parts) > 1 else None
        except ValueError:
            code = None
        return running, (None if running else code)

    def stop(self, info: dict) -> None:
        self._docker(["stop", "-t", str(STOP_GRACE_S), info["container"]], timeout_s=STOP_GRACE_S + DOCKER_TIMEOUT_S)

    def cleanup(self, info: dict) -> None:
        self._docker(["rm", "-f", info["container"]])

    def sweep(self) -> list:
        """Every job container of this vehicle still known to docker: [{job_id, info, running}]."""
        proc = self._docker(["ps", "-a", "--filter", f"label={LABEL_VEHICLE}={self.vehicle_id}",
                             "--format", "{{.Names}}\t{{.Label \"" + LABEL_JOB + "\"}}\t{{.State}}"])
        if proc.returncode != 0:
            return []
        out = []
        for line in (proc.stdout or "").splitlines():
            parts = line.split("\t")
            if len(parts) < 3 or not parts[1]:
                continue
            out.append({"job_id": parts[1], "info": {"kind": self.kind, "container": parts[0]},
                        "running": parts[2].strip().lower() == "running"})
        return out


class SubprocessRunner:
    """Jobs as child processes of the agent (bench/dev). They do not survive the agent."""

    kind = "subprocess"

    def __init__(self, cfg: AgentConfig, vehicle_id: str, popen: Callable = subprocess.Popen):
        self.cfg = cfg
        self.vehicle_id = vehicle_id
        self._popen = popen
        self._procs: dict = {}

    def spawn(self, job: Job) -> dict:
        env = dict(os.environ)
        env.update(self.cfg.runner_env())
        pkg_parent = str(Path(__file__).resolve().parent.parent)
        env["PYTHONPATH"] = pkg_parent + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        try:
            proc = self._popen([sys.executable or "python3", "-m", "rig_agent", "run-job", job.job_id],
                               env=env, cwd=str(self.cfg.root), start_new_session=True)
        except OSError as e:
            raise RunnerError(f"could not start the runner process: {e}")
        self._procs[job.job_id] = proc
        return {"kind": self.kind, "pid": proc.pid, "job_id": job.job_id}

    def poll(self, info: dict):
        proc = self._procs.get(info.get("job_id"))
        if proc is None:
            return False, None
        rc = proc.poll()
        return rc is None, rc

    def stop(self, info: dict) -> None:
        pid = info.get("pid")
        if pid:
            try:
                os.killpg(pid, signal.SIGTERM)
            except OSError:
                pass

    def cleanup(self, info: dict) -> None:
        self._procs.pop(info.get("job_id"), None)

    def sweep(self) -> list:
        return []


def make_runner(cfg: AgentConfig, vehicle_id: str):
    return DockerRunner(cfg, vehicle_id) if cfg.runner == "docker" else SubprocessRunner(cfg, vehicle_id)


# ---- the in-runner entry point ------------------------------------------------------------------
def _current_id(cfg: AgentConfig) -> Optional[str]:
    if not cfg.data_dir:
        return None
    try:
        cur = registry_mod.current_run(cfg.data_dir)
    except registry_mod.RegistryError:
        return None
    return cur.id if cur else None


def run_result(before: Optional[str], after: Optional[str]) -> dict:
    """What the verb did to the registry, from two reads of `current` — never from rig's prose."""
    return {"run_before": before, "run_after": after,
            "sealed": before if before and before != after else None,
            "opened": after if after and after != before else None}


def run_job(cfg: AgentConfig, store: JobStore, job_id: str, *, run_rig: Callable = rigcmd.run_rig,
            clock: Callable[[], float] = time.time, install_signals: bool = True) -> int:
    """`python3 -m rig_agent run-job <id>`: own the record, run the verb, write the terminal record.
    SIGTERM (docker stop / the agent's cancel or deadline) stops rig and records `killed`; the agent
    then re-labels it cancelled / timeout, since only the agent knows which it asked for."""
    job = store.load(job_id)
    if job is None:
        log.error("run-job: no record for %s under %s", job_id, store.dir)
        return 2
    if job.terminal:
        return 0
    now = clock()
    job.state = "running"
    job.started_unix_s = now
    job.deadline_unix_s = now + job.timeout_s
    job.runner = {**job.runner, "pid": os.getpid()}
    store.save(job)

    stop = threading.Event()
    if install_signals:
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())

    before = _current_id(cfg)
    tail: deque = deque(maxlen=LOG_TAIL_LINES)
    last_save = {"at": now}
    log_path = store.log_path(job_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as fh:
        def on_line(line: str) -> None:
            fh.write(line + "\n")
            fh.flush()
            tail.append(line)
            if clock() - last_save["at"] >= RECORD_SAVE_INTERVAL_S:
                job.log_tail = list(tail)
                store.save(job)
                last_save["at"] = clock()

        res = run_rig(cfg, job.argv, job.timeout_s, on_line=on_line, stop=stop)

    after = _current_id(cfg)
    job.ended_unix_s = clock()
    job.exit_code = res.returncode
    job.log_tail = list(tail) if tail else list(res.lines[-LOG_TAIL_LINES:])
    job.result = run_result(before, after)
    if res.stopped:
        job.state, job.error, job.error_kind = "killed", "stopped by the agent", None
    elif res.timed_out:
        job.state, job.error, job.error_kind = "killed", f"timed out after {job.timeout_s} s", "timeout"
    elif res.returncode == 0:
        job.state, job.error, job.error_kind = "succeeded", None, None
    else:
        job.state = "failed"
        job.error = error_message(res.stderr, res.stdout) or f"rig exited {res.returncode}"
        job.error_kind, job.guard_projects = classify_rig_error(res.returncode, res.stderr)
    store.save(job)
    log.info("run-job %s: %s (%s) → %s", job_id, " ".join(job.argv), job.state, job.error or "ok")
    if job.state == "succeeded":
        return 0
    return res.returncode if isinstance(res.returncode, int) and res.returncode > 0 else 1
