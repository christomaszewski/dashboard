"""python3 -m rig_agent serve            the agent (the compose service's command)
python3 -m rig_agent run-job <job_id>  the in-runner entry point (what the agent `docker run`s)
python3 -m rig_agent status            one status poll, printed as the state document (bench check)
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys

from . import __version__
from .config import AgentConfig, ConfigError


def _logging() -> None:
    level = (os.environ.get("RIG_AGENT_LOG") or "INFO").upper()
    logging.basicConfig(level=getattr(logging, level, logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    verb = argv[0] if argv else "serve"
    if verb in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    if verb == "--version":
        print(f"rig-agent {__version__}")
        return 0
    _logging()
    try:
        cfg = AgentConfig.from_env()
    except ConfigError as e:
        print(f"rig-agent: {e}", file=sys.stderr)
        return 2

    if verb == "run-job":
        if len(argv) < 2:
            print("usage: python3 -m rig_agent run-job <job_id>", file=sys.stderr)
            return 2
        from .jobs import JobStore
        from .runner import run_job
        return run_job(cfg, JobStore(cfg.state_dir), argv[1])

    from .agent import RigAgent
    agent = RigAgent(cfg)
    if verb == "status":
        agent._read_version()
        agent.poll_once()
        print(json.dumps(agent.state_doc(), indent=2, default=str))
        return 0 if agent.state_doc().get("ok") else 1
    if verb != "serve":
        print(__doc__.strip(), file=sys.stderr)
        return 2

    def _stop(*_):
        agent.close()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _stop)
    logging.getLogger("rig_agent").info("rig-agent %s: root=%s data_dir=%s runner=%s actuate=%s",
                                        __version__, cfg.root, cfg.data_dir, cfg.runner, cfg.actuate)
    agent.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
