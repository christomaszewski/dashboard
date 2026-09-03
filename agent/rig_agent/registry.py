"""The run registry, read the way rig reads it (rig_cli/runs.py: current_run, list_runs) but
WITHOUT importing rig — the registry is a documented filesystem contract:

    <data_dir>/runs/<UTCstamp>_<label|auto>[-N]/manifest.yaml   flat YAML; `ended:` present ⇔ sealed
    <data_dir>/current -> runs/<id>                            RELATIVE symlink ⇔ the open run

States: OPEN (current points at it) | sealed (ended:) | interrupted (no ended:, not current) |
corrupt (manifest unparseable) | dangling (a symlinked registry entry whose target is gone)."""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

STATES = ("OPEN", "sealed", "interrupted", "corrupt", "dangling")
DU_TIMEOUT_S = 20.0


class RegistryError(ValueError):
    pass


@dataclass(frozen=True)
class RunRow:
    run: str
    label: Optional[str]
    state: str
    started: Optional[str]
    ended: Optional[str]
    disk_kb: Optional[int]
    replay_of: Optional[str]
    linked: bool

    def to_json(self) -> dict:
        return {"run": self.run, "label": self.label, "state": self.state, "started": self.started,
                "ended": self.ended, "disk_kb": self.disk_kb, "replay_of": self.replay_of,
                "linked": self.linked}


@dataclass(frozen=True)
class OpenRun:
    id: str
    dir: Path
    manifest: dict


def runs_dir(data: Path) -> Path:
    return data / "runs"


def current_path(data: Path) -> Path:
    return data / "current"


def load_manifest(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except OSError as e:
        raise RegistryError(f"{path}: {e}")
    except yaml.YAMLError as e:
        raise RegistryError(f"{path}: not valid YAML ({e})")
    if doc is None:
        return {}
    if not isinstance(doc, dict):
        raise RegistryError(f"{path}: top level must be a mapping")
    return doc


def current_run(data: Path) -> Optional[OpenRun]:
    """The OPEN run, or None. A dangling `current` reads as None; a `current` that is not a symlink
    or points anywhere but a direct child of runs/ is a loud error — rig's own rules."""
    cur = current_path(data)
    if not cur.is_symlink():
        if cur.exists():
            raise RegistryError(f"{cur} exists but is not a symlink — remove it (the registry owns this path)")
        return None
    target = cur.resolve()
    if not target.is_dir():
        return None
    if target.parent != runs_dir(data).resolve():
        raise RegistryError(f"{cur} points outside the registry ({target}) — remove or fix it")
    mpath = target / "manifest.yaml"
    doc: dict = {"run": target.name}
    if mpath.exists():
        try:
            doc = load_manifest(mpath)
        except RegistryError:
            doc = {"run": target.name, "corrupt": True}
    return OpenRun(target.name, target, doc)


def current_run_id(data: Path):
    """(open run id or None, problem or None) — the fail-soft form for listings."""
    try:
        cur = current_run(data)
    except RegistryError as e:
        return None, str(e)
    return (cur.id if cur else None), None


def run_dir(data: Path, run_id: str) -> Optional[Path]:
    """The run's directory iff `run_id` names a direct child of runs/ (no path tricks)."""
    if not run_id or "/" in run_id or run_id in (".", "..") or run_id.startswith("."):
        return None
    d = runs_dir(data) / run_id
    return d if d.is_dir() else None


def _opt_str(value) -> Optional[str]:
    return str(value) if value not in (None, "") else None


def list_runs(data: Path):
    """(rows, problem) — rig's list_runs semantics, newest last (ids sort by their UTC stamp)."""
    open_id, problem = current_run_id(data)
    rows = []
    runs = runs_dir(data)
    for d in sorted(runs.iterdir()) if runs.is_dir() else []:
        if d.is_symlink() and not d.is_dir():   # a linked archive whose target moved
            rows.append(RunRow(d.name, None, "dangling", None, None, None, None, True))
            continue
        if not d.is_dir():
            continue
        mpath = d / "manifest.yaml"
        try:
            doc = load_manifest(mpath) if mpath.exists() else {}
        except RegistryError:   # open-ness outranks corruption
            rows.append(RunRow(d.name, None, "OPEN" if d.name == open_id else "corrupt",
                               None, None, None, None, d.is_symlink()))
            continue
        ended = _opt_str(doc.get("ended"))
        state = "OPEN" if d.name == open_id else ("sealed" if ended else "interrupted")
        replay = doc.get("replay")
        replay_of = str(replay["of"]) if isinstance(replay, dict) and replay.get("of") else None
        disk = doc.get("disk_kb")
        disk_kb = int(disk) if isinstance(disk, (int, float)) and not isinstance(disk, bool) else None
        rows.append(RunRow(d.name, _opt_str(doc.get("label")), state, _opt_str(doc.get("started")),
                           ended, disk_kb, replay_of, d.is_symlink()))
    return rows, problem


def run_state(data: Path, run_id: str) -> Optional[str]:
    for row in list_runs(data)[0]:
        if row.run == run_id:
            return row.state
    return None


def run_manifest(data: Path, run_id: str) -> Optional[dict]:
    d = run_dir(data, run_id)
    if d is None:
        return None
    mpath = d / "manifest.yaml"
    if not mpath.exists():
        return {"run": run_id}
    try:
        return load_manifest(mpath)
    except RegistryError:
        return {"run": run_id, "corrupt": True}


def open_run_summary(cur: OpenRun) -> dict:
    doc = cur.manifest
    stacks = doc.get("stacks")
    return {
        "id": cur.id,
        "label": _opt_str(doc.get("label")),
        "started": _opt_str(doc.get("started")),
        "stacks": [str(s) for s in stacks] if isinstance(stacks, list) else [],
        "config": _opt_str(doc.get("config")),
        "corrupt": bool(doc.get("corrupt", False)),
    }


def du_kb(path: Path, timeout_s: float = DU_TIMEOUT_S) -> Optional[int]:
    try:
        proc = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, timeout=timeout_s)
        return int(proc.stdout.split()[0])
    except Exception:   # noqa: BLE001 -- size is best-effort
        return None


def free_kb(path: Path) -> Optional[int]:
    try:
        return shutil.disk_usage(str(path)).free // 1024
    except OSError:
        return None


def signature(data: Path) -> tuple:
    """Cheap change detector for the watcher: what `current` points at, the open manifest's mtime,
    and the runs/ directory's mtime (an entry added or removed)."""
    cur = current_path(data)
    try:
        link = os.readlink(cur)
    except OSError:
        link = None
    try:
        mtime = (cur / "manifest.yaml").stat().st_mtime_ns if link is not None else None
    except OSError:
        mtime = None
    try:
        runs_mtime = runs_dir(data).stat().st_mtime_ns
    except OSError:
        runs_mtime = None
    return link, mtime, runs_mtime
