"""Job requests (docs/RIG_AGENT.md "Jobs"): parse + validate a submit payload against the current
snapshot, and turn it into rig's argv. The verb whitelist and the per-argument checks ARE the
security model: no free-form argv ever reaches rig."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Optional, Sequence

VERBS = ("standby", "activate", "up", "down", "new-run", "end-run")
ROW_VERBS = ("standby", "activate", "up", "down")
STATE_VERBS_ONLY = ("standby", "activate")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")   # rig_cli/runs.py _LABEL_RE
DEFAULT_TIMEOUT_S = {"standby": 300, "activate": 600, "new-run": 60, "end-run": 180, "up": 600, "down": 300}
DOWN_END_RUN_TIMEOUT_S = 900
TIMEOUT_MIN_S, TIMEOUT_MAX_S = 30, 1800
CLIENT_MAX = 120


@dataclass(frozen=True)
class SubmitRequest:
    verb: str
    names: tuple
    label: Optional[str]
    force: bool
    end_run: bool
    timeout_s: int
    client: Optional[str]

    def args(self) -> dict:
        out: dict = {"names": list(self.names), "force": self.force}
        if self.verb == "new-run":
            out["label"] = self.label
        if self.verb == "down":
            out["end_run"] = self.end_run
        return out


def _split_parameters(parameters: str) -> dict:
    out = {}
    for part in str(parameters or "").replace("&", ";").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _as_bool(value, key: str):
    if isinstance(value, bool):
        return value, None
    if isinstance(value, str) and value.strip().lower() in ("1", "true", "yes", "0", "false", "no", ""):
        return value.strip().lower() in ("1", "true", "yes"), None
    if value is None:
        return False, None
    return None, f"'{key}' must be true or false"


def default_timeout(verb: str, end_run: bool = False) -> int:
    if verb == "down" and end_run:
        return DOWN_END_RUN_TIMEOUT_S
    return DEFAULT_TIMEOUT_S[verb]


def parse_submit(payload: Optional[bytes], parameters: str = "", *,
                 known_names: Sequence[str] = (), state_verb_names: Sequence[str] = ()):
    """(request, error). A JSON object payload, or — for a payload-less get — selector parameters
    (`verb=standby;names=a,b;force=1`). Unknown keys are ignored (forward compat)."""
    if payload:
        try:
            req = json.loads(bytes(payload).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            return None, f"request is not JSON: {e}"
        if not isinstance(req, dict):
            return None, "request must be a JSON object"
    else:
        req = _split_parameters(parameters)

    verb = req.get("verb")
    if not isinstance(verb, str) or not verb:
        return None, "missing 'verb'"
    if verb not in VERBS:
        return None, f"unknown verb '{verb}' (verbs: {', '.join(VERBS)})"

    names_raw = req.get("names")
    if isinstance(names_raw, str):
        names_raw = [n.strip() for n in names_raw.split(",") if n.strip()]
    if names_raw is None:
        names_raw = []
    if not isinstance(names_raw, list) or not all(isinstance(n, str) and n for n in names_raw):
        return None, "'names' must be a list of row names"
    names = tuple(dict.fromkeys(names_raw))   # de-duplicated, order kept
    if names and verb not in ROW_VERBS:
        return None, "'names' is not accepted for new-run/end-run"
    for n in names:
        if n not in known_names:
            return None, f"unknown row '{n}' (rows: {', '.join(known_names) or 'none'})"
        if verb in STATE_VERBS_ONLY and n not in state_verb_names:
            return None, f"standby/activate: '{n}' declares no state verbs"

    label = req.get("label")
    if label is not None and label != "":
        if verb != "new-run":
            return None, "'label' is only accepted for new-run"
        if not isinstance(label, (str, int)):
            return None, "'label' must be a string"
        label = str(label)
        if not LABEL_RE.match(label):
            return None, "'label' must match [A-Za-z0-9][A-Za-z0-9_-]* (it becomes a directory name)"
    else:
        label = None

    force, err = _as_bool(req.get("force"), "force")
    if err:
        return None, err
    if force and verb in STATE_VERBS_ONLY:
        return None, "'force' is not accepted for standby/activate"
    end_run, err = _as_bool(req.get("end_run"), "end_run")
    if err:
        return None, err
    if end_run and verb != "down":
        return None, "'end_run' is only accepted for down"

    timeout_raw = req.get("timeout_s")
    if timeout_raw is None or timeout_raw == "":
        timeout_s = default_timeout(verb, end_run)
    else:
        try:
            timeout_s = int(float(timeout_raw))
        except (TypeError, ValueError):
            return None, "'timeout_s' must be a number"
        timeout_s = max(TIMEOUT_MIN_S, min(TIMEOUT_MAX_S, timeout_s))

    client = req.get("client")
    client = str(client)[:CLIENT_MAX] if client not in (None, "") else None

    return SubmitRequest(verb=verb, names=names, label=label, force=bool(force), end_run=bool(end_run),
                         timeout_s=timeout_s, client=client), None


def verb_argv(req: SubmitRequest) -> list:
    """The argv after `rig --root <root>` — exactly what the job record's `argv` shows."""
    argv = [req.verb]
    if req.verb == "new-run":
        if req.label:
            argv.append(req.label)
        if req.force:
            argv.append("--force")
        return argv
    if req.verb == "end-run":
        if req.force:
            argv.append("--force")
        return argv
    argv.extend(req.names)
    if req.verb == "down" and req.end_run:
        argv.append("--end-run")
    if req.force and req.verb in ("up", "down"):
        argv.append("--force")
    return argv


def self_terminating(req: SubmitRequest, self_name: Optional[str]) -> bool:
    """Does this verb take the agent's own compose project down? `down` over every row, `down`
    naming the self row, or `down --end-run` (always every row)."""
    if req.verb != "down":
        return False
    if req.end_run or not req.names:
        return True
    return self_name is not None and self_name in req.names
