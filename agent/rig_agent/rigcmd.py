"""Running rig from inside the agent: `python3 -m rig_cli --root <root> …` with the deployment
tree's OWN rig_cli/ on PYTHONPATH (dev trees and baked artifacts both ship it, version-locked with
the tree — the agent image bundles no rig). Subprocess discipline: bounded by a timeout, killed as a
process group, both streams captured (rig's human lines go to stderr, machine output to stdout)."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence

from .config import AgentConfig

# Shell-tier values that must never leak from the agent's environment into rig: RIG_VAR_* would
# silently override vehicle vars, RIG_TARGET_STATE is the standby/activate fan-out's own channel.
STRIPPED_ENV_PREFIXES = ("RIG_VAR_",)
STRIPPED_ENV = {"RIG_TARGET_STATE", "RIG_AGENT_RUNNER"}
KILL_GRACE_S = 5.0
WAIT_SLICE_S = 0.25


def tree_has_rig(root: Path) -> bool:
    return (root / "rig_cli" / "__init__.py").is_file()


def check(cfg: AgentConfig) -> Optional[str]:
    """A human reason the agent cannot drive rig at all, or None."""
    if not (cfg.root / "vehicle.yaml").is_file():
        return f"no vehicle.yaml in {cfg.root} — is the deployment tree mounted at its host path?"
    if not tree_has_rig(cfg.root):
        return (f"no rig_cli/ in {cfg.root} — the agent runs the tree's own rig "
                f"(dev checkouts and baked artifacts both carry it)")
    return None


def rig_env(cfg: AgentConfig, base: Optional[Mapping[str, str]] = None) -> dict:
    env = {k: v for k, v in (os.environ if base is None else base).items()
           if k not in STRIPPED_ENV and not k.startswith(STRIPPED_ENV_PREFIXES)}
    root = str(cfg.root)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = root if not existing else f"{root}{os.pathsep}{existing}"
    env["RIG_VEHICLE_LOCAL"] = str(cfg.vehicle_local)
    env["PYTHONUNBUFFERED"] = "1"
    return env


def rig_argv(cfg: AgentConfig, args: Sequence[str]) -> list:
    return [sys.executable or "python3", "-m", "rig_cli", "--root", str(cfg.root), *args]


@dataclass
class RigResult:
    argv: list
    returncode: Optional[int]
    stdout: str
    stderr: str
    timed_out: bool = False
    stopped: bool = False          # the stop event fired (cancel / agent-side deadline)
    duration_s: float = 0.0
    lines: list = field(default_factory=list)   # both streams, interleaved as they arrived

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.stopped


def _pump(stream, sink: list, lines: list, on_line, lock) -> None:
    for raw in iter(stream.readline, ""):
        sink.append(raw)
        line = raw.rstrip("\n")
        with lock:
            lines.append(line)
        if on_line is not None:
            try:
                on_line(line)
            except Exception:   # noqa: BLE001 -- a logging sink must not break the verb
                pass
    stream.close()


def run_rig(cfg: AgentConfig, args: Sequence[str], timeout_s: float,
            on_line: Optional[Callable[[str], None]] = None,
            env: Optional[Mapping[str, str]] = None,
            stop: Optional[threading.Event] = None) -> RigResult:
    """Run one rig verb to completion, the timeout, or the stop event. `on_line` sees every line of
    either stream as it arrives — the job log tail. On timeout/stop the whole process group gets
    SIGTERM, then SIGKILL."""
    argv = rig_argv(cfg, args)
    started = time.monotonic()
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                env=rig_env(cfg, env), cwd=str(cfg.root), start_new_session=True)
    except OSError as e:
        return RigResult(argv, None, "", f"could not start rig: {e}", lines=[f"could not start rig: {e}"])
    out: list = []
    err: list = []
    lines: list = []
    lock = threading.Lock()
    pumps = [threading.Thread(target=_pump, args=(proc.stdout, out, lines, on_line, lock), daemon=True),
             threading.Thread(target=_pump, args=(proc.stderr, err, lines, on_line, lock), daemon=True)]
    for t in pumps:
        t.start()
    timed_out = stopped = False
    deadline = started + timeout_s
    while True:
        try:
            proc.wait(timeout=WAIT_SLICE_S)
            break
        except subprocess.TimeoutExpired:
            pass
        if stop is not None and stop.is_set():
            stopped = True
            _kill_group(proc)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _kill_group(proc)
            break
    for t in pumps:
        t.join(timeout=KILL_GRACE_S)
    return RigResult(argv, proc.returncode, "".join(out), "".join(err), timed_out, stopped,
                     time.monotonic() - started, lines)


def _kill_group(proc: subprocess.Popen) -> None:
    for sig, wait in ((signal.SIGTERM, KILL_GRACE_S), (signal.SIGKILL, KILL_GRACE_S)):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        except OSError:
            proc.kill()
        try:
            proc.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue
