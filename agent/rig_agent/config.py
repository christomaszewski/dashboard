"""AgentConfig — everything the agent needs, read once from the environment (the compose overlay's
contract, deploy/docker-compose.rig-agent.yml). Pure: no I/O beyond reading env."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

DEFAULT_CONNECT = "tcp/localhost:7447"
DEFAULT_VEHICLE_LOCAL = "/etc/rig/vehicle.local.yaml"   # rig's manifest.MACHINE_LOCAL_DEFAULT
DEFAULT_IMAGE = "dashboard-rig-agent:local"
DEFAULT_POLL_S = 10.0
MIN_POLL_S = 2.0
# Inside the deployment tree's `var/` (already writable — rig renders configs there), so no named
# volume is needed and the detached runner reaches it through the same identity mount.
STATE_SUBDIR = "var/dashboard-rig-agent"
RUNNERS = ("docker", "subprocess")


class ConfigError(ValueError):
    pass


def split_endpoints(raw: Optional[str], default: Optional[str]) -> tuple:
    """Comma-separated endpoints. Unset → the default; an EMPTY string means none (scout only) —
    the same convention as camera-service's ZENOH_CONNECT."""
    if raw is None:
        raw = default or ""
    return tuple(e.strip() for e in str(raw).split(",") if e.strip())


def parse_bool(raw: Optional[str], default: bool) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class AgentConfig:
    root: Path                     # RIG_ROOT: the deployment tree (vehicle.yaml)
    data_dir: Optional[Path]       # RIG_DATA_DIR: the run registry's host dir (None = inert)
    vehicle_local: Path            # RIG_VEHICLE_LOCAL: machine identity file (rig reads the same env)
    vehicle_local_host: Optional[Path]   # RIG_VEHICLE_LOCAL_HOST: its HOST path, for the runner's mount
    mount: Path                    # RIG_MOUNT: the identity-mounted host dir runners must also mount
    connect: tuple                 # ZENOH_CONNECT endpoints
    listen: tuple                  # ZENOH_LISTEN endpoints (bench: stand in for a router)
    poll_s: float                  # RIG_AGENT_POLL_S
    actuate: bool                  # RIG_AGENT_ACTUATE: False = read-only agent
    runner: str                    # RIG_AGENT_RUNNER: docker (detached container) | subprocess (bench/dev)
    image: str                     # RIG_AGENT_IMAGE: what `docker run` for a job
    project: Optional[str]         # RIG_AGENT_PROJECT: the compose project hosting the agent (→ self row)
    user: Optional[str]            # RIG_AGENT_USER "uid:gid", mirrored onto runners
    groups: tuple                  # RIG_AGENT_GROUPS, mirrored as --group-add
    state_dir: Path                # RIG_AGENT_STATE_DIR: job records + logs

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "AgentConfig":
        e = os.environ if env is None else env
        root_raw = (e.get("RIG_ROOT") or "").strip()
        if not root_raw:
            raise ConfigError("RIG_ROOT is required (the deployment tree containing vehicle.yaml)")
        root = Path(root_raw)
        if not root.is_absolute():
            raise ConfigError(f"RIG_ROOT must be absolute (identity mounts): {root}")
        data_raw = (e.get("RIG_DATA_DIR") or "").strip()
        mount_raw = (e.get("RIG_MOUNT") or "").strip()
        local_host_raw = (e.get("RIG_VEHICLE_LOCAL_HOST") or "").strip()
        runner = (e.get("RIG_AGENT_RUNNER") or "docker").strip().lower()
        if runner not in RUNNERS:
            raise ConfigError(f"RIG_AGENT_RUNNER must be one of {', '.join(RUNNERS)}, not '{runner}'")
        try:
            poll_s = float(e.get("RIG_AGENT_POLL_S") or DEFAULT_POLL_S)
        except ValueError:
            raise ConfigError(f"RIG_AGENT_POLL_S is not a number: {e.get('RIG_AGENT_POLL_S')!r}")
        state_raw = (e.get("RIG_AGENT_STATE_DIR") or "").strip()
        return cls(
            root=root,
            data_dir=Path(data_raw) if data_raw else None,
            vehicle_local=Path((e.get("RIG_VEHICLE_LOCAL") or "").strip() or DEFAULT_VEHICLE_LOCAL),
            vehicle_local_host=Path(local_host_raw) if local_host_raw else None,
            mount=Path(mount_raw) if mount_raw else root,
            connect=split_endpoints(e.get("ZENOH_CONNECT"), DEFAULT_CONNECT),
            listen=split_endpoints(e.get("ZENOH_LISTEN"), None),
            poll_s=max(MIN_POLL_S, poll_s),
            actuate=parse_bool(e.get("RIG_AGENT_ACTUATE"), True),
            runner=runner,
            image=(e.get("RIG_AGENT_IMAGE") or "").strip() or DEFAULT_IMAGE,
            project=(e.get("RIG_AGENT_PROJECT") or "").strip() or None,
            user=(e.get("RIG_AGENT_USER") or "").strip() or None,
            groups=tuple(g.strip() for g in (e.get("RIG_AGENT_GROUPS") or "").split(",") if g.strip()),
            state_dir=Path(state_raw) if state_raw else root / STATE_SUBDIR,
        )

    def runner_env(self) -> dict:
        """The env a detached runner needs to rebuild this config (a runner never spawns runners,
        so RIG_AGENT_RUNNER and the zenoh endpoints are irrelevant to it)."""
        return {
            "RIG_ROOT": str(self.root),
            "RIG_DATA_DIR": str(self.data_dir) if self.data_dir else "",
            "RIG_VEHICLE_LOCAL": str(self.vehicle_local),
            "RIG_MOUNT": str(self.mount),
            "RIG_AGENT_STATE_DIR": str(self.state_dir),
            "RIG_AGENT_PROJECT": self.project or "",
            "PYTHONUNBUFFERED": "1",
        }
