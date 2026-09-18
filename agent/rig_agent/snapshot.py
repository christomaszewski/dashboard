"""Assembling the documents the contract publishes (docs/RIG_AGENT.md): the state snapshot from
`rig status` + the raw vehicle.yaml rows + the registry, and the descriptor. Pure."""
from __future__ import annotations

import copy
from typing import Optional, Sequence

from . import __version__
from .requests import VERBS
from .status import StatusDoc
from .vehicle import project_name

SCHEMA_VERSION = 1
SERVICE = "rig-agent"


def build_stacks(status: Optional[StatusDoc], rows: Sequence, trio: set, vehicle_id,
                 self_name: Optional[str]) -> list:
    """vehicle.yaml rows (tiered, ordered, disabled included) merged with rig's live roll-up.
    `rig status` only lists enabled rows; a disabled row shows as down. A status row for a name the
    raw read dropped (templated) is appended so nothing rig reports goes missing."""
    by_sensor = {s.sensor: s for s in status.stacks} if status else {}
    out = []
    seen = set()
    for row in rows:
        s = by_sensor.get(row.name)
        seen.add(row.name)
        out.append({
            "name": row.name, "service": row.service, "tier": row.tier, "order": row.order,
            "enabled": row.enabled, "project": project_name(row.name, vehicle_id),
            "state": s.state if s else "down", "health": s.health if s else "n/a",
            "op_state": s.op_state if s else None,
            "running": s.running if s else 0, "total": s.total if s else 0,
            "state_verbs": row.service in trio, "self": row.name == self_name,
        })
    for s in (status.stacks if status else ()):
        if s.sensor in seen:
            continue
        out.append({
            "name": s.sensor, "service": s.service, "tier": "sensor", "order": 10_000,
            "enabled": True, "project": project_name(s.sensor, vehicle_id),
            "state": s.state, "health": s.health, "op_state": s.op_state,
            "running": s.running, "total": s.total,
            "state_verbs": s.service in trio, "self": s.sensor == self_name,
        })
    return out


def build_state(*, vehicle: str, vehicle_id: str, at_unix_s: float, ok: bool, error: Optional[str],
                rig_version: Optional[str], run: Optional[dict], registry: dict, stacks: list) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "vehicle_id": vehicle_id,
        "vehicle": vehicle,
        "at_unix_s": at_unix_s,
        "ok": ok,
        "error": error,
        "rig_version": rig_version,
        "run": run,
        "registry": registry,
        "stacks": stacks,
    }


def build_descriptor(cfg, *, vehicle: str, vehicle_id: str, rig_version: Optional[str],
                     since_unix_s: float, self_instance: Optional[str], job: Optional[dict]) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "service": SERVICE,
        "vehicle_id": vehicle_id,
        "vehicle": vehicle,
        "agent_version": __version__,
        "rig_version": rig_version,
        "root": str(cfg.root),
        "data_dir": str(cfg.data_dir) if cfg.data_dir else None,
        "capabilities": {"actuate": bool(cfg.actuate), "verbs": list(VERBS), "jobs": True},
        "self_instance": self_instance,
        "poll_s": cfg.poll_s,
        "since_unix_s": since_unix_s,
        "job": job,
    }


def _comparable(doc: dict) -> dict:
    """The state minus the fields that change without meaning a change: timestamps, disk sizes, and
    the job (job changes travel on the events publisher)."""
    d = copy.deepcopy(doc)
    d.pop("at_unix_s", None)
    d.pop("job", None)
    if isinstance(d.get("run"), dict):
        d["run"].pop("disk_kb", None)
    if isinstance(d.get("registry"), dict):
        d["registry"].pop("free_kb", None)
    return d


def state_changed(previous: Optional[dict], current: Optional[dict]) -> bool:
    if previous is None or current is None:
        return previous is not current
    return _comparable(previous) != _comparable(current)
