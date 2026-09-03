"""Raw reads of the deployment tree — vehicle.yaml rows and which services declare rig's
operational-state trio — WITHOUT loading rig (loading interpolates, validates configs and may
render; the agent needs only names, tiers, order and the enabled flag). Precedent: rig's own
completions.py raw-reads vehicle.yaml for the same reason.

Rows whose name is templated (`{{…}}`) are dropped: the agent never interpolates."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import yaml

# rig_cli/manifest.py TIER_RANK + the vehicle.yaml keys each tier lives under.
TIER_RANK = {"infra": 0, "sensor": 1, "autonomy": 2}
TIER_KEYS = (("infra", "infra"), ("sensors", "sensor"), ("autonomy", "autonomy"))
# rig_cli/descriptor.py STATE_VERBS: all-three-or-none is the support claim.
STATE_VERBS = ("standby", "activate", "state")
DESCRIPTOR_NAMES = ("rigging.yaml", "deploy.yaml")


class VehicleError(ValueError):
    pass


@dataclass(frozen=True)
class VehicleRow:
    name: str
    service: str
    tier: str
    order: int
    enabled: bool


def load_yaml(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except OSError as e:
        raise VehicleError(f"{path}: {e}")
    except yaml.YAMLError as e:
        raise VehicleError(f"{path}: not valid YAML ({e})")
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise VehicleError(f"{path}: top level must be a mapping")
    return data


def read_vehicle_rows(root: Path) -> list:
    data = load_yaml(root / "vehicle.yaml")
    rows = []
    for key, tier in TIER_KEYS:
        entries = data.get(key) or []
        if not isinstance(entries, list):
            raise VehicleError(f"vehicle.yaml: `{key}` must be a list")
        for index, entry in enumerate(entries):
            entry = entry or {}
            if not isinstance(entry, dict):
                continue
            name, service = entry.get("name"), entry.get("service")
            if not isinstance(name, str) or not isinstance(service, str) or not name or not service:
                continue
            if "{{" in name:
                continue
            try:
                order = int(entry.get("order", (index + 1) * 10))
            except (TypeError, ValueError):
                order = (index + 1) * 10
            rows.append(VehicleRow(name=name, service=service, tier=tier, order=order,
                                   enabled=bool(entry.get("enabled", True))))
    return sorted(rows, key=lambda r: (TIER_RANK[r.tier], r.order))


def project_name(name: str, vehicle_id) -> str:
    """rig_cli/manifest.py project_name: '<name>-vehicle-<id>' (or '<name>' with no vehicle id)."""
    return f"{name}-vehicle-{vehicle_id}" if vehicle_id not in (None, "") else name


def self_instance(rows, vehicle_id, project: Optional[str]) -> Optional[str]:
    """The row whose compose project hosts the agent (COMPOSE_PROJECT_NAME as rig exported it)."""
    if not project:
        return None
    for row in rows:
        if project_name(row.name, vehicle_id) == project:
            return row.name
    return None


def read_state_verb_services(root: Path) -> set:
    """Services whose rigging.yaml declares the full standby/activate/state trio. Reads
    services.yaml for the catalog (paths relative to the tree root) and each repo's descriptor.
    Missing repos / unreadable descriptors simply don't count — status must render regardless."""
    try:
        catalog = load_yaml(root / "services.yaml").get("services") or {}
    except VehicleError:
        return set()
    if not isinstance(catalog, dict):
        return set()
    out = set()
    for service, spec in catalog.items():
        path = spec.get("path") if isinstance(spec, dict) else None
        if not isinstance(path, str) or not path:
            continue
        repo = Path(path)
        repo = repo if repo.is_absolute() else (root / repo)
        for dname in DESCRIPTOR_NAMES:
            desc_path = repo / dname
            if not desc_path.is_file():
                continue
            try:
                verbs = load_yaml(desc_path).get("verbs") or {}
            except VehicleError:
                break
            if isinstance(verbs, dict) and all(v in verbs for v in STATE_VERBS):
                out.add(str(service))
            break
    return out
