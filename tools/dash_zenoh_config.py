#!/usr/bin/env python3
"""Render the sidecar's zenoh config with the instance's topic rate limits, for dash-up.

The browser hop is one WebSocket: every subscribed ROS topic crosses it sample by sample at the
publisher's rate, and on a spotty wireless link that volume queues behind TCP retransmits and
reaches the page late, in bursts. The instance config can cap it BEFORE the air, in the sidecar,
with zenoh's downsampling interceptor on the sidecar's ingress from the router:

  topic_rate_hz: 5                # every ROS topic of this domain at most 5 Hz to the browser
  # -- or --
  topic_rates:                    # explicit per-topic caps (needs PyYAML on the host)
    /imu/data: 10
    /ouster/points: 1

  ros_domain_id: 1                # scopes the rules to `<domain>/**` (rmw_zenoh's topic keys);
                                  #   default: rig's ROS_DOMAIN_ID, exported to every launcher

Global XOR per-topic, on purpose: zenoh applies the FIRST rule whose key expression intersects a
key, not the most specific one, so a `<domain>/**` cap and a per-topic rule cannot be layered
predictably. Scoping to the domain keeps the control plane (fleet/<vehicle>/svc/... lifecycle and
playback state, the rig agent) at full rate: a dropped state publication would be a missed
transition, not a stale readout. `put` messages only: service queries/replies and liveliness are
never rate-limited. Rate widgets (`topic_hz`) read the capped rate -- set their min_hz accordingly.

Usage: dash_zenoh_config.py <config.yaml> <out.json5> [<template.json5>]
Prints the rendered file's path when the config carries rate limits, nothing otherwise (dash-up
then mounts the stock template). Errors -> stderr, exit 1.
"""
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from dash_env import load  # noqa: E402  (the same parser dash-up's env comes from)

DEFAULT_TEMPLATE = pathlib.Path(__file__).resolve().parent.parent / "deploy" / "zenohd-dashboard.json5"


def _hz(value, where: str) -> float:
    if isinstance(value, bool):
        raise SystemExit(f"dash_zenoh_config: {where} must be a rate in Hz (got {value!r})")
    try:
        hz = float(value)
    except (TypeError, ValueError):
        raise SystemExit(f"dash_zenoh_config: {where} must be a rate in Hz (got {value!r})") from None
    if not hz > 0:
        raise SystemExit(f"dash_zenoh_config: {where} must be > 0 Hz (got {hz:g})")
    return hz


def rules(cfg: dict, env: dict) -> list[dict]:
    """The downsampling rules the config asks for: [] when none. Pure."""
    rate = cfg.get("topic_rate_hz")
    per = cfg.get("topic_rates")
    if rate is None and per is None:
        return []
    if rate is not None and per is not None:
        raise SystemExit("dash_zenoh_config: topic_rate_hz and topic_rates are exclusive -- zenoh applies "
                         "the first matching rule, so a global cap and per-topic caps cannot be layered")
    domain = cfg.get("ros_domain_id", env.get("ROS_DOMAIN_ID"))
    if domain is None or str(domain).strip() == "" or not str(domain).strip().isdigit():
        raise SystemExit("dash_zenoh_config: topic rate limits need the ROS domain to scope their keys -- "
                         "set ros_domain_id (rig exports ROS_DOMAIN_ID to every launcher)")
    domain = str(domain).strip()
    if rate is not None:
        return [{"key_expr": f"{domain}/**", "freq": _hz(rate, "topic_rate_hz")}]
    if not isinstance(per, dict) or not per:
        raise SystemExit("dash_zenoh_config: topic_rates must be a non-empty mapping of topic -> Hz")
    out = []
    for topic, hz in per.items():
        name = str(topic).strip()
        if not name.startswith("/") or "//" in name or name.endswith("/"):
            raise SystemExit(f"dash_zenoh_config: topic_rates key {name!r} is not a ROS topic name (/a/b)")
        out.append({"key_expr": f"{domain}/{name[1:]}/**", "freq": _hz(hz, f"topic_rates[{name}]")})
    return out


def render(template: str, rule_list: list[dict]) -> str:
    """The template with a `downsampling:` block spliced in before its closing brace."""
    end = template.rstrip().rfind("}")
    if end < 0:
        raise SystemExit("dash_zenoh_config: the template has no closing brace")
    lines = ["  // Rendered by dash-up (tools/dash_zenoh_config.py) from the instance config: ROS topics reach",
             "  // the browser at most this often -- zenoh's downsampling interceptor on this sidecar's ingress",
             "  // from the router (put messages only: queries, replies and liveliness are untouched).",
             "  downsampling: [",
             "    {",
             "      flows: [\"ingress\"],",
             "      messages: [\"put\"],",
             "      rules: ["]
    for r in rule_list:
        lines.append(f"        {{ key_expr: \"{r['key_expr']}\", freq: {r['freq']:g} }},")
    lines += ["      ],", "    },", "  ],", ""]
    head = template[:end].rstrip()
    if not head.endswith(","):
        head += ","
    return head + "\n" + "\n".join(lines) + template[end:]


def main() -> int:
    if len(sys.argv) not in (3, 4):
        sys.stderr.write("usage: dash_zenoh_config.py <config.yaml> <out.json5> [<template.json5>]\n")
        return 2
    cfg = load(sys.argv[1])
    if "topic_rates" not in cfg:
        try:
            with open(sys.argv[1], encoding="utf-8") as f:
                text = f.read()
        except OSError:
            text = ""
        if any(line.startswith("topic_rates:") for line in text.splitlines()):
            sys.stderr.write("dash_zenoh_config: warning: topic_rates is a mapping and needs PyYAML on this "
                             "host (the stdlib fallback reads flat keys only) -- no per-topic limits applied\n")
    rule_list = rules(cfg, dict(os.environ))
    if not rule_list:
        return 0
    template_path = pathlib.Path(sys.argv[3]) if len(sys.argv) == 4 else DEFAULT_TEMPLATE
    out = pathlib.Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(template_path.read_text(encoding="utf-8"), rule_list), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
