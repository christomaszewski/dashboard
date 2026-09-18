"""Job records + the on-disk store (docs/RIG_AGENT.md "Job record"). Records live as one JSON file
each under <state_dir>/jobs/, written atomically, so the detached runner (a separate process, maybe
outliving the agent) and the agent share them through the filesystem alone."""
from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

SCHEMA_VERSION = 1
STATES = ("queued", "running", "succeeded", "failed", "killed", "cancelled")
TERMINAL = ("succeeded", "failed", "killed", "cancelled")
LOG_TAIL_LINES = 40
KEEP = 50


def new_job_id(now: Optional[float] = None) -> str:
    stamp = datetime.fromtimestamp(now if now is not None else time.time(), timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"j-{stamp}-{secrets.token_hex(2)}"


@dataclass
class Job:
    job_id: str
    verb: str
    args: dict
    argv: list
    client: Optional[str]
    self_terminating: bool
    timeout_s: int
    state: str = "queued"
    submitted_unix_s: float = 0.0
    started_unix_s: Optional[float] = None
    ended_unix_s: Optional[float] = None
    deadline_unix_s: Optional[float] = None
    exit_code: Optional[int] = None
    error: Optional[str] = None
    error_kind: Optional[str] = None
    guard_projects: list = field(default_factory=list)
    log_tail: list = field(default_factory=list)
    result: dict = field(default_factory=dict)
    runner: dict = field(default_factory=dict)   # {"kind": "docker"|"subprocess", "container"|"pid": …}

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL

    def to_json(self) -> dict:
        doc = asdict(self)
        doc["schema_version"] = SCHEMA_VERSION
        return doc

    @classmethod
    def from_json(cls, doc: dict) -> "Job":
        fields = {f for f in cls.__dataclass_fields__}   # type: ignore[attr-defined]
        known = {k: v for k, v in doc.items() if k in fields}
        for req in ("job_id", "verb"):
            if not isinstance(known.get(req), str):
                raise ValueError(f"job record lacks '{req}'")
        known.setdefault("args", {})
        known.setdefault("argv", [])
        known.setdefault("client", None)
        known.setdefault("self_terminating", False)
        known.setdefault("timeout_s", 0)
        job = cls(**known)
        if job.state not in STATES:
            job.state = "failed"
        return job


def tail_lines(path: Path, n: int = LOG_TAIL_LINES, max_bytes: int = 256 * 1024) -> list:
    """The last n lines of a log file (reads at most max_bytes from its end)."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            data = f.read()
    except OSError:
        return []
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]   # the first line is probably cut
    return lines[-n:]


def write_json_atomic(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class JobStore:
    def __init__(self, state_dir: Path, keep: int = KEEP):
        self.dir = Path(state_dir) / "jobs"
        self.keep = keep

    def path(self, job_id: str) -> Path:
        return self.dir / f"{job_id}.json"

    def log_path(self, job_id: str) -> Path:
        return self.dir / f"{job_id}.log"

    def save(self, job: Job) -> None:
        write_json_atomic(self.path(job.job_id), job.to_json())

    def load(self, job_id: str) -> Optional[Job]:
        try:
            with open(self.path(job_id), encoding="utf-8") as f:
                return Job.from_json(json.load(f))
        except (OSError, ValueError, TypeError):
            return None

    def list(self) -> list:
        """All records, newest first (ids embed a UTC stamp, so name order is time order)."""
        if not self.dir.is_dir():
            return []
        jobs = []
        for p in sorted(self.dir.glob("j-*.json"), reverse=True):
            job = self.load(p.stem)
            if job is not None:
                jobs.append(job)
        return jobs

    def running(self) -> Optional[Job]:
        for job in self.list():
            if not job.terminal:
                return job
        return None

    def sweep(self) -> int:
        """Drop the oldest records (and logs) beyond `keep`. Never a non-terminal one."""
        jobs = self.list()
        removed = 0
        for job in jobs[self.keep:]:
            if not job.terminal:
                continue
            for p in (self.path(job.job_id), self.log_path(job.job_id)):
                try:
                    p.unlink()
                except OSError:
                    pass
            removed += 1
        return removed
