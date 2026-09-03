"""`rig status --format json` — rig's one machine-readable status (rig_cli/status.py as_json):

    {"vehicle": "orin-dev", "vehicle_id": 1, "run": "<human line>" | null,
     "stacks": [{"sensor": "cam_front", "service": "camera-service", "state": "running|partial|down",
                 "health": "healthy|unhealthy|starting|n/a|-", "op_state": "active|standby|…|unknown"|null,
                 "running": 2, "total": 2}]}

`op_state` is additive (rig ≥ 0.2.35); older rigs omit it. Everything is validated, nothing is
re-interpreted: state/health/op_state reach the consumer verbatim."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional


class StatusError(ValueError):
    pass


@dataclass(frozen=True)
class StatusStack:
    sensor: str
    service: str
    state: str
    health: str
    op_state: Optional[str]
    running: int
    total: int


@dataclass(frozen=True)
class StatusDoc:
    vehicle: str
    vehicle_id: str
    run_line: Optional[str]
    stacks: tuple


def parse_status_json(text: str) -> StatusDoc:
    try:
        doc = json.loads(text)
    except (ValueError, TypeError) as e:
        raise StatusError(f"status is not JSON: {e}")
    if not isinstance(doc, dict):
        raise StatusError("status is not a JSON object")
    vehicle = doc.get("vehicle")
    vid = doc.get("vehicle_id")
    if not isinstance(vehicle, str) or not vehicle:
        raise StatusError("status lacks 'vehicle'")
    if vid is None or isinstance(vid, bool) or not isinstance(vid, (int, str)) or str(vid).strip() == "":
        raise StatusError("status lacks a usable 'vehicle_id'")
    run_line = doc.get("run")
    if run_line is not None and not isinstance(run_line, str):
        raise StatusError("'run' must be a string or null")
    raw_stacks = doc.get("stacks")
    if not isinstance(raw_stacks, list):
        raise StatusError("status lacks 'stacks'")
    stacks = []
    for i, row in enumerate(raw_stacks):
        if not isinstance(row, dict):
            raise StatusError(f"stacks[{i}] is not an object")
        try:
            sensor, service = str(row["sensor"]), str(row["service"])
            state, health = str(row["state"]), str(row.get("health", "-"))
            running, total = int(row["running"]), int(row["total"])
        except (KeyError, TypeError, ValueError) as e:
            raise StatusError(f"stacks[{i}] is malformed: {e}")
        op = row.get("op_state")
        if op is not None and not isinstance(op, str):
            raise StatusError(f"stacks[{i}].op_state must be a string or null")
        stacks.append(StatusStack(sensor, service, state, health, op, running, total))
    return StatusDoc(vehicle=vehicle, vehicle_id=str(vid).strip(), run_line=run_line, stacks=tuple(stacks))
