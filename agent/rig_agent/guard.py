"""Classify a failed rig verb from its stderr — best-effort, so a consumer can offer the right next
step. rig's messages are human prose, not a contract: unknown wording degrades to `other` with the
verbatim text, never to a wrong classification (every pattern is anchored on a distinctive phrase).
The phrases come from rig_cli/runs.py (_guard, new_run) and cli.py."""
from __future__ import annotations

import re
from typing import Optional

KINDS = ("guard-running", "guard-cannot-tell", "bad-label", "no-data-dir", "timeout", "other")

_RUNNING = re.compile(r"stacks are running \(([^)]*)\)")
_CANNOT_TELL = re.compile(r"cannot tell whether|retry, or --force")
_BAD_LABEL = re.compile(r"must match \[A-Za-z0-9\]")
_NO_DATA_DIR = re.compile(r"needs? `?data_dir`?")


def error_message(stderr: str, stdout: str = "") -> Optional[str]:
    """rig's last line — errors print as `rig: <msg>` on stderr; a `rig:` line wins over launcher
    chatter, and the trailing ` (exit N)` decoration is left as is."""
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    for ln in reversed(lines):
        if ln.startswith("rig:") or ln.startswith("rig "):
            return ln[4:].strip() if ln.startswith("rig:") else ln
    if lines:
        return lines[-1]
    out = [ln.strip() for ln in (stdout or "").splitlines() if ln.strip()]
    return out[-1] if out else None


def classify_rig_error(returncode: Optional[int], stderr: str, *, timed_out: bool = False):
    """(error_kind, guard_projects). (None, []) for a success."""
    if timed_out:
        return "timeout", []
    if returncode == 0:
        return None, []
    text = stderr or ""
    m = _RUNNING.search(text)
    if m:
        projects = [p.strip() for p in m.group(1).split(",") if p.strip()]
        return "guard-running", projects
    if _CANNOT_TELL.search(text):
        return "guard-cannot-tell", []
    if _BAD_LABEL.search(text):
        return "bad-label", []
    if _NO_DATA_DIR.search(text):
        return "no-data-dir", []
    return "other", []
