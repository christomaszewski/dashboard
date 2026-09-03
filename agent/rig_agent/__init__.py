"""dashboard-rig-agent — exposes a rig deployment over Zenoh (docs/RIG_AGENT.md).

rig is a one-shot CLI; this is its daemon half: it polls `rig status --format json`, mirrors the run
registry, and runs a whitelisted set of verbs as detached jobs. Every module except `agent.py`
(the Zenoh adapter) and `runner.py`'s docker calls is pure and importable with no binding, no
docker and no deployment tree, so the request/guard/registry logic is unit-tested in CI.
"""
__version__ = "0.1.0"
