"""The key schema (docs/RIG_AGENT.md) — one place that spells every key."""
from __future__ import annotations

from typing import Optional


def vehicle_segment(vehicle_id) -> str:
    """`str(vehicle_id)` as a single key segment. rig's vehicle_id is an int or a string."""
    seg = str(vehicle_id).strip()
    if not seg or "/" in seg or "*" in seg or seg in ("$", "#", "?"):
        raise ValueError(f"vehicle_id {vehicle_id!r} is not a usable key segment")
    return seg


def key_base(vehicle_id) -> str:
    return f"fleet/{vehicle_segment(vehicle_id)}/rig"


def state_key(base: str) -> str:
    return base + "/state"


def runs_key(base: str) -> str:
    return base + "/runs"


def run_pattern(base: str) -> str:
    """The wildcard the run-detail queryable is declared on."""
    return base + "/run/*"


def run_key(base: str, run_id: str) -> str:
    return f"{base}/run/{run_id}"


def jobs_key(base: str) -> str:
    return base + "/jobs"


def submit_key(base: str) -> str:
    return base + "/jobs/submit"


def cancel_key(base: str) -> str:
    return base + "/jobs/cancel"


def events_key(base: str) -> str:
    return base + "/jobs/events"


def parse_run_key(base: str, key: str) -> Optional[str]:
    """`<base>/run/<run_id>` → run_id (one segment), else None."""
    prefix = base + "/run/"
    if not key.startswith(prefix):
        return None
    rest = key[len(prefix):]
    if not rest or "/" in rest:
        return None
    return rest
