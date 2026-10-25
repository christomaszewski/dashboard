#!/usr/bin/env python3
"""Read a dashboard instance config -> `KEY=value` lines for dash-up to `export`.

Mirrors gige's sensor_env.py contract: stdout = export lines ONLY; errors -> stderr. Uses PyYAML if
present, else a minimal TOP-LEVEL-key parser so stock python3 is enough. The fallback must ignore
nested blocks (the `home:` tab layout): an indented `name:` inside a widget would otherwise clobber
DASH_NAME. Only flat top-level scalars are read either way (values are simple tokens — no spaces).
"""
import re
import socket
import sys

KEY_SEGMENT = re.compile(r"[^A-Za-z0-9_-]+")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        import yaml  # type: ignore
        return yaml.safe_load(text) or {}
    except ModuleNotFoundError:
        data: dict = {}
        for raw in text.splitlines():
            # Top-level scalars only: skip indented lines (nested keys) and list items.
            if not raw or raw[0] in " \t" or raw.lstrip().startswith("-"):
                continue
            line = raw.split("#", 1)[0].rstrip()
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            val = val.strip().strip('"').strip("'")
            if val == "":
                continue  # block opener (e.g. `home:`) — no top-level scalar value
            data[key.strip()] = val
        return data


def truthy(value) -> bool:
    """`true` from PyYAML is a bool; from the fallback parser it is the string 'true'."""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "on")


def falsy(value) -> bool:
    if isinstance(value, bool):
        return not value
    return str(value).strip().lower() in ("false", "0", "no", "off")


def key_segment(value: str, what: str) -> str:
    """One Zenoh key segment (no wildcards, no '/'); anything else becomes '-', with a warning."""
    clean = KEY_SEGMENT.sub("-", value).strip("-")
    if clean != value:
        print(f"dash_env: {what} {value!r} used as {clean!r} in the vehicle state key", file=sys.stderr)
    return clean or "vehicle"


def state_key(cfg: dict) -> str:
    """fleet/<vehicle>/dash/<name>/state: vehicle_id, else this host's short hostname (dash-up runs on
    the vehicle), so a browser on a shared mesh reaches its own vehicle's state service."""
    vehicle = cfg.get("vehicle_id")
    vehicle = str(vehicle) if vehicle not in (None, "") else socket.gethostname().split(".")[0]
    name = str(cfg.get("name", "dashboard"))
    return f"fleet/{key_segment(vehicle, 'vehicle_id')}/dash/{key_segment(name, 'name')}/state"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: dash_env.py <dashboard-config.yaml>")
    cfg = load(sys.argv[1])
    print(f"DASH_NAME={cfg.get('name', 'dashboard')}")
    print(f"DASH_WEB_PORT={cfg.get('web_port', 8080)}")
    print(f"DASH_WS_PORT={cfg.get('ws_port', 10000)}")
    # Memory guard for the remote-api bridges: zenoh-ts 1.9's plugin queues without bound for a
    # browser that cannot keep up (bench: +16 MB/s for one raw camera over a 128 kbit/s link). Past
    # this the kernel restarts the bridge, not the vehicle's other services. 0 = no limit.
    limit = str(cfg.get("bridge_mem_limit", "512m")).strip()
    if not re.fullmatch(r"\d+[bkmg]?", limit, re.IGNORECASE):
        print(f"dash_env: bridge_mem_limit is not a size like 512m: {limit!r} (using 512m)", file=sys.stderr)
        limit = "512m"
    print(f"DASH_BRIDGE_MEM_LIMIT={limit}")
    # Optional: a host dir of point-cloud files for the Clouds tab. Emitted only when set —
    # dash-up applies the clouds compose overlay only when this variable is non-empty.
    clouds = cfg.get("clouds_dir")
    if isinstance(clouds, str) and clouds:
        print(f"DASH_CLOUDS_HOST={clouds}")
    # Optional: the rig agent (Rig tab). `rig_agent: true` opts in; dash-up resolves the tree and
    # data_dir itself (rig_root / rig_data_dir / rig_mount only override that resolution).
    if "rig_agent" in cfg and truthy(cfg.get("rig_agent")):
        print("DASH_RIG_AGENT=1")
    for key, var in (("rig_root", "DASH_RIG_ROOT"), ("rig_data_dir", "DASH_RIG_DATA"), ("rig_mount", "DASH_RIG_MOUNT")):
        value = cfg.get(key)
        if isinstance(value, str) and value:
            print(f"{var}={value}")
    # Optional: vehicle state (docs/VEHICLE_STATE.md) — dashboard-state and its loopback-only bridge.
    if "vehicle_state" in cfg and truthy(cfg.get("vehicle_state")):
        print("DASH_VEHICLE_STATE=1")
        print(f"DASH_STATE_KEY={state_key(cfg)}")
        port = cfg.get("state_ws_port", 10001)
        try:
            print(f"DASH_STATE_WS_PORT={int(port)}")
        except (TypeError, ValueError):
            print(f"dash_env: state_ws_port is not a port number: {port!r} (using 10001)", file=sys.stderr)
            print("DASH_STATE_WS_PORT=10001")
    if "rig_actuate" in cfg and falsy(cfg.get("rig_actuate")):
        print("DASH_RIG_ACTUATE=0")
    poll = cfg.get("rig_poll_s")
    if poll is not None and not isinstance(poll, bool):
        try:
            print(f"DASH_RIG_POLL_S={float(poll):g}")
        except (TypeError, ValueError):
            print(f"dash_env: rig_poll_s is not a number: {poll!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
