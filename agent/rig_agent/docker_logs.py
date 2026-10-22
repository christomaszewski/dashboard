"""Read-only Docker inventory and bounded log snapshots. No shell, follow process, or disk spool."""
from __future__ import annotations

import json
import os
import re
import selectors
import subprocess
import time

LOG_BYTES = 64 * 1024
INVENTORY_BYTES = 512 * 1024
COMMAND_TIMEOUT_S = 3.0
MAX_READ_BYTES = 4 * 1024 * 1024
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
CONTAINER_FORMAT = (
    '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},'
    '"state":{{json .State}},"status":{{json .Status}},'
    '"project":{{json (.Label "com.docker.compose.project")}},'
    '"service":{{json (.Label "com.docker.compose.service")}}}'
)


def capture(argv: list[str], limit: int, timeout_s: float = COMMAND_TIMEOUT_S) -> tuple[str, bool]:
    """Drain both streams, keeping only the last `limit` bytes, and always reap the process.

    A huge single log line cannot consume unbounded memory; total work also has a byte/time cap.
    This runs on a separate, concurrency-limited worker, never a Zenoh callback thread.
    """
    deadline = time.monotonic() + timeout_s
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL) as proc:
        try:
            assert proc.stdout is not None
            os.set_blocking(proc.stdout.fileno(), False)
            tail = bytearray()
            total = 0
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError("Docker request timed out")
                    if not selector.select(remaining):
                        raise ValueError("Docker request timed out")
                    chunk = os.read(proc.stdout.fileno(), 16 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_READ_BYTES:
                        raise ValueError("Docker output is too large; select fewer tail lines")
                    tail.extend(chunk)
                    del tail[:-limit]
            try:
                rc = proc.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as exc:
                raise ValueError("Docker request timed out") from exc
            text = tail.decode("utf-8", errors="replace")
            if rc:
                raise ValueError(text.strip()[-2000:] or f"Docker exited with status {rc}")
            return text, total > limit
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()


class DockerLogs:
    def __init__(self, run=capture):
        self.run = run

    def containers(self) -> dict:
        text, truncated = self.run(["docker", "ps", "--all", "--no-trunc", "--format", CONTAINER_FORMAT], INVENTORY_BYTES)
        if truncated:
            raise ValueError("Docker container inventory exceeds 512 KiB")
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        fields = ("id", "name", "image", "state", "status", "project", "service")
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(row.get(k), str) for k in fields):
                raise ValueError("Invalid Docker container inventory")
            if not CONTAINER_ID.fullmatch(row["id"]):
                raise ValueError("Invalid Docker container ID")
        rows.sort(key=lambda row: (row["state"] != "running", row["project"], row["service"], row["name"]))
        return {"schema_version": 1, "ok": True, "containers": rows}

    @staticmethod
    def parse_request(raw: bytes | None) -> tuple[str, int]:
        if not raw or len(raw) > 1024:
            raise ValueError("Expected a JSON payload with container_id and optional tail")
        doc = json.loads(raw)
        if not isinstance(doc, dict) or set(doc) - {"container_id", "tail"}:
            raise ValueError("Expected only container_id and optional tail")
        container = doc.get("container_id")
        tail = doc.get("tail", 200)
        if not isinstance(container, str) or not CONTAINER_ID.fullmatch(container):
            raise ValueError("container_id must be a full 64-character Docker ID")
        if type(tail) is not int or not 1 <= tail <= 500:
            raise ValueError("tail must be an integer from 1 to 500")
        return container, tail

    def logs(self, container: str, tail: int) -> dict:
        text, truncated = self.run(["docker", "logs", "--timestamps", "--tail", str(tail), container], LOG_BYTES)
        return {"schema_version": 1, "ok": True, "container_id": container, "tail": tail,
                "text": text, "truncated": truncated, "at_unix_s": time.time()}
