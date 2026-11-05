#!/usr/bin/env python3
"""Read a dashboard instance config -> `KEY=value` lines for dash-up to `export`.

Mirrors gige's sensor_env.py contract: stdout = export lines ONLY; errors -> stderr. Uses PyYAML if
present; stock python3 supports the mapping/list/flow forms used by dashboard configs too. Advanced
YAML requires PyYAML and fails explicitly rather than silently losing a service dependency.
"""
import json
import os
import re
import socket
import sys

KEY_SEGMENT = re.compile(r"[^A-Za-z0-9_-]+")
TAB_IDS = ("home", "health", "cameras", "ros", "ros3d", "rig", "logs", "clouds", "debug")


def _parts(text: str, delimiter: str) -> list[str]:
    """Split outside quoted strings and flow collections; also strip YAML comments."""
    out, start, stack, quote, i = [], 0, [], None, 0
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                if quote == "'" and text[i:i + 2] == "''":
                    i += 2
                    continue
                quote = None
        elif c in "\"'" and (i == 0 or text[i - 1] in " \t[{,:-"):
            quote = c
        elif c == "#" and (i == 0 or text[i - 1].isspace()):
            text = text[:i]
            break
        elif c in "[{":
            stack.append(c)
        elif c in "]}":
            if not stack or stack.pop() != ("]" == c and "[" or "{"):
                raise ValueError("unbalanced flow collection")
        elif c == delimiter and not stack:
            out.append(text[start:i].strip())
            start = i + 1
        i += 1
    if quote or stack:
        raise ValueError("multiline quoted/flow values require PyYAML")
    return out + [text[start:].strip()]


def _scalar(text: str):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return [_scalar(p) for p in _parts(text[1:-1], ",") if p]
    if text.startswith("{") and text.endswith("}"):
        result = {}
        for part in _parts(text[1:-1], ","):
            if not part:
                continue
            pair = _parts(part, ":")
            if len(pair) < 2:
                raise ValueError("flow mapping needs key: value")
            result[str(_scalar(pair[0]))] = _scalar(":".join(pair[1:]))
        return result
    if text.startswith('"'):
        return json.loads(text)
    if text.startswith("'") and text.endswith("'"):
        return text[1:-1].replace("''", "'")
    if text.startswith(("&", "*", "!", "|", ">")) or text == "<<":
        raise ValueError("anchors, tags and block scalars require PyYAML")
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    if text.lower() in ("null", "~", ""):
        return None
    if re.fullmatch(r"[-+]?\d+", text):
        return int(text)
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][-+]?\d+)?", text):
        return float(text)
    return text


def load_basic(text: str) -> dict:
    """The config's ordinary YAML subset, including nested widgets and both tabs spellings."""
    lines = []
    raw_lines = text.splitlines()
    number = 0
    while number < len(raw_lines):
        raw = raw_lines[number]
        number += 1
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            raise ValueError(f"line {number}: tabs cannot indent YAML")
        clean = _parts(raw, "\0")[0]
        if not clean or clean in ("---", "..."):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        literal = re.fullmatch(r"(.*:\s*)([|>])([+-]?)([1-9]?)", clean)
        if literal:
            body = []
            while number < len(raw_lines):
                line = raw_lines[number]
                if line.strip() and len(line) - len(line.lstrip(" ")) <= indent:
                    break
                body.append(line)
                number += 1
            margin = indent + int(literal[4]) if literal[4] else min(
                (len(line) - len(line.lstrip(" ")) for line in body if line.strip()), default=indent + 1)
            value = "\n".join(line[margin:] for line in body) + ("\n" if body else "")
            if literal[2] == ">":
                value = re.sub(r"(?<=\S)\n(?=\S)", " ", value)
            if literal[3] == "-":
                value = value.rstrip("\n")
            elif literal[3] != "+" and value:
                value = value.rstrip("\n") + "\n"
            clean = literal[1] + json.dumps(value)
        # Expand '- key: value' to a list entry containing an ordinary nested mapping.
        item = re.match(r"^-(\s+)(.*)$", clean)
        if item and re.match(r"[^\[{}]+:\s|[^\[{}]+:$", item[2]):
            lines.append((indent, "-"))
            lines.append((indent + 1 + len(item[1]), item[2]))
        else:
            lines.append((indent, clean))

    def block(index: int, indent: int):
        sequence = lines[index][1] == "-" or lines[index][1].startswith("- ")
        result = [] if sequence else {}
        while index < len(lines) and lines[index][0] == indent:
            line = lines[index][1]
            if sequence:
                if line != "-" and not line.startswith("- "):
                    break  # an indentless list ended; its parent mapping resumes here
                value = line[1:].strip()
            else:
                pair = _parts(line, ":")
                if len(pair) < 2:
                    raise ValueError("mapping needs key: value")
                key, value = str(_scalar(pair[0])), ":".join(pair[1:]).strip()
            index += 1
            if not value and index < len(lines) and (lines[index][0] > indent or
                    (not sequence and lines[index][0] == indent and lines[index][1].startswith("-"))):
                parsed, index = block(index, lines[index][0])
            else:
                parsed = _scalar(value)
            if sequence:
                result.append(parsed)
            else:
                result[key] = parsed
        return result, index

    if not lines:
        return {}
    if len(lines) == 1 and lines[0][1].startswith("{"):
        result = _scalar(lines[0][1])
        return result if isinstance(result, dict) else {}
    result, end = block(0, lines[0][0])
    if end != len(lines) or not isinstance(result, dict):
        raise ValueError("unsupported YAML indentation or root; install PyYAML")
    return result


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        import yaml  # type: ignore
        # Match the browser's YAML 1.2 booleans (yes/no/on/off remain strings in tab maps).
        class Loader(yaml.SafeLoader):
            pass
        Loader.yaml_implicit_resolvers = {k: [(tag, rx) for tag, rx in v if tag != "tag:yaml.org,2002:bool"]
                                          for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
        Loader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))
        data = yaml.load(text, Loader=Loader)
        return data if isinstance(data, dict) else {}
    except ModuleNotFoundError:
        try:
            return load_basic(text)
        except ValueError as e:
            raise SystemExit(f"dash_env: {e}; install PyYAML to read this config") from e


def truthy(value) -> bool:
    """`true` from PyYAML is a bool; from the fallback parser it is the string 'true'."""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "on")


def falsy(value) -> bool:
    if isinstance(value, bool):
        return not value
    return str(value).strip().lower() in ("false", "0", "no", "off")


def rig_agent_required(cfg: dict) -> bool:
    """Mirror schema.ts: only rendered Rig/Logs tabs or valid Rig widgets require the agent."""
    override = cfg.get("rig_agent")
    if truthy(override):
        return True
    if falsy(override):
        return False
    raw_tabs = cfg.get("tabs")
    tabs = {t: True for t in raw_tabs if isinstance(t, str) and t in TAB_IDS} if isinstance(raw_tabs, list) else \
        {t: v for t, v in raw_tabs.items() if t in TAB_IDS and isinstance(v, bool)} if isinstance(raw_tabs, dict) else {}
    visible = [t for t in TAB_IDS if tabs.get(t, t == "home")] or ["home"]
    if "rig" in visible or "logs" in visible:
        return True
    home = cfg.get("home")
    if "home" not in visible or not isinstance(home, dict):
        return False
    version = home.get("version") if home.get("version") is not None else 1
    if type(version) not in (int, float) or version != 1:
        return False
    widgets = home.get("widgets")
    if not isinstance(widgets, list):
        return False

    def is_rig(widget):
        if not isinstance(widget, dict) or widget.get("type") != "rig":
            return False
        # This is the only rejecting field in the built-in Rig widget's parser.
        stacks = widget.get("stacks")
        return "stacks" not in widget or isinstance(stacks, list) and all(isinstance(s, str) and s for s in stacks)

    for widget in widgets:
        if is_rig(widget):
            return True
        # Panels support Rig items, but nested panels are rejected by the browser.
        if isinstance(widget, dict) and widget.get("type") == "panel" and isinstance(widget.get("items"), list):
            if any(is_rig(item) for item in widget["items"]):
                return True
    return False


def key_segment(value: str, what: str) -> str:
    """One Zenoh key segment (no wildcards, no '/'); anything else becomes '-', with a warning."""
    pattern = re.compile(r"[^A-Za-z0-9_.-]+") if what == "vehicle_id" else KEY_SEGMENT
    clean = pattern.sub("-", value).strip("-")
    if clean != value:
        print(f"dash_env: {what} {value!r} used as {clean!r} in the vehicle state key", file=sys.stderr)
    return clean or "vehicle"


def vehicle_id(cfg: dict) -> str:
    """Rig's launcher identity wins; standalone configs fall back to the short hostname."""
    authoritative = os.environ.get("VEHICLE_ID")
    if authoritative is not None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", authoritative):
            raise SystemExit("dash_env: VEHICLE_ID must be one plain key segment ([A-Za-z0-9_.-]+)")
        return authoritative
    vehicle = cfg.get("vehicle_id")
    vehicle = str(vehicle) if vehicle not in (None, "") else socket.gethostname().split(".")[0]
    return key_segment(vehicle, "vehicle_id")


def state_key(cfg: dict) -> str:
    """fleet/<vehicle>/dash/<name>/state, scoped to the launching vehicle."""
    name = str(cfg.get("name", "dashboard"))
    return f"fleet/{vehicle_id(cfg)}/dash/{key_segment(name, 'name')}/state"


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
    # Resolve dependencies from the same tabs/widgets the browser renders; explicit flags win.
    print(f"DASH_RIG_AGENT={int(rig_agent_required(cfg))}")
    print(f"DASH_RIG_ACTUATE={int(truthy(cfg.get('rig_actuate')))}")
    for key, var in (("rig_root", "DASH_RIG_ROOT"), ("rig_data_dir", "DASH_RIG_DATA"), ("rig_mount", "DASH_RIG_MOUNT")):
        value = cfg.get(key)
        if isinstance(value, str) and value:
            print(f"{var}={value}")
    # Optional: vehicle state (docs/VEHICLE_STATE.md) — dashboard-state and its loopback-only bridge.
    # Identity is also needed when dash-up enables the lightweight run feed from RIG_DATA_DIR.
    print(f"DASH_VEHICLE_STATE={int(truthy(cfg.get('vehicle_state')))}")
    print(f"DASH_VEHICLE_ID={vehicle_id(cfg)}")
    print(f"DASH_STATE_KEY={state_key(cfg)}")
    port = cfg.get("state_ws_port", 10001)
    try:
        print(f"DASH_STATE_WS_PORT={int(port)}")
    except (TypeError, ValueError):
        print(f"dash_env: state_ws_port is not a port number: {port!r} (using 10001)", file=sys.stderr)
        print("DASH_STATE_WS_PORT=10001")
    poll = cfg.get("rig_poll_s")
    if poll is not None and not isinstance(poll, bool):
        try:
            print(f"DASH_RIG_POLL_S={float(poll):g}")
        except (TypeError, ValueError):
            print(f"dash_env: rig_poll_s is not a number: {poll!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
