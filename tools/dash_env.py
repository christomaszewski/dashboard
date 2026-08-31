#!/usr/bin/env python3
"""Read a dashboard instance config -> `KEY=value` lines for dash-up to `export`.

Mirrors gige's sensor_env.py contract: stdout = export lines ONLY; errors -> stderr. Uses PyYAML if
present, else a minimal TOP-LEVEL-key parser so stock python3 is enough. The fallback must ignore
nested blocks (the `home:` tab layout): an indented `name:` inside a widget would otherwise clobber
DASH_NAME. Only the three flat scalars below are read either way.
"""
import sys


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


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: dash_env.py <dashboard-config.yaml>")
    cfg = load(sys.argv[1])
    print(f"DASH_NAME={cfg.get('name', 'dashboard')}")
    print(f"DASH_WEB_PORT={cfg.get('web_port', 8080)}")
    print(f"DASH_WS_PORT={cfg.get('ws_port', 10000)}")
    # Optional: a host dir of point-cloud files for the Clouds tab. Emitted only when set —
    # dash-up applies the clouds compose overlay only when this variable is non-empty.
    clouds = cfg.get("clouds_dir")
    if isinstance(clouds, str) and clouds:
        print(f"DASH_CLOUDS_HOST={clouds}")


if __name__ == "__main__":
    main()
