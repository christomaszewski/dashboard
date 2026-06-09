#!/usr/bin/env python3
"""Read a dashboard instance config -> `KEY=value` lines for dash-up to `export`.

Mirrors gige's sensor_env.py contract: stdout = export lines ONLY; errors -> stderr. Uses PyYAML if
present, else a minimal flat-key parser so stock python3 is enough (the config is flat key: value).
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
        for line in text.splitlines():
            line = line.split("#", 1)[0].rstrip()
            if not line or ":" not in line:
                continue
            key, _, val = line.partition(":")
            data[key.strip()] = val.strip().strip('"').strip("'")
        return data


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: dash_env.py <dashboard-config.yaml>")
    cfg = load(sys.argv[1])
    print(f"DASH_NAME={cfg.get('name', 'dashboard')}")
    print(f"DASH_WEB_PORT={cfg.get('web_port', 8080)}")
    print(f"DASH_WS_PORT={cfg.get('ws_port', 10000)}")


if __name__ == "__main__":
    main()
