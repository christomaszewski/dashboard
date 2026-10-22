"""The agent: `rig status` polling, the registry watch, the Zenoh adapter (docs/RIG_AGENT.md keys)
and job supervision, shaped after camera-service's control_zenoh.py — one peer-mode session, every
zenoh interaction wrapped, best-effort advertising retried on a timer, the binding imported lazily
(and injectable) so this module unit-tests without it.

Threads: poller (`rig status` every poll_s), watcher (registry signature every 2 s), worker (the
one thread that starts jobs), one supervisor per running job, and zenoh's own callback threads.
Cached documents are replaced whole under a lock; state/job handlers reply from them directly.
Docker inventory/log reads use separate concurrency-limited workers with short deadlines."""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from typing import Callable, Optional

from . import keys, registry as registry_mod, rigcmd, snapshot as snap, vehicle as vehicle_mod
from .config import AgentConfig
from .docker_logs import DockerLogs
from .guard import error_message
from .jobs import Job, JobStore, new_job_id, tail_lines
from .requests import parse_submit, self_terminating, verb_argv
from .runner import RunnerStartUncertain, make_runner
from .status import StatusError, parse_status_json

log = logging.getLogger("rig_agent")

STATUS_TIMEOUT_S = 30.0
VERSION_TIMEOUT_S = 15.0
# Unchanged snapshots are re-published every HEARTBEAT_POLLS poll periods: consumers flag a
# snapshot older than 3 poll periods as stale, so one missed heartbeat is still fresh.
HEARTBEAT_POLLS = 2
REGISTRY_TICK_S = 2.0
DISK_TICK_S = 30.0
SUPERVISE_TICK_S = 1.0
EVENT_MIN_INTERVAL_S = 2.0
RETRY_S = 5.0
CONNECT_TIMEOUT_MS = 2000
DEADLINE_SLACK_S = 5.0


def encode_json(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), default=str).encode("utf-8")


def _query_bytes(query) -> Optional[bytes]:
    payload = getattr(query, "payload", None)
    if payload is None:
        return None
    return payload.to_bytes() if hasattr(payload, "to_bytes") else bytes(payload)


def _query_parameters(query) -> str:
    params = getattr(query, "parameters", "")
    return str(params) if params is not None else ""


class RigAgent:
    def __init__(self, cfg: AgentConfig, *, session_factory: Optional[Callable] = None,
                 run_rig: Optional[Callable] = None, runner_factory: Optional[Callable] = None,
                 dispatch: Optional[Callable] = None, clock: Optional[Callable[[], float]] = None,
                 store: Optional[JobStore] = None):
        self.cfg = cfg
        self._open = session_factory or self._open_zenoh
        self._run_rig = run_rig or rigcmd.run_rig
        self._runner_factory = runner_factory or make_runner
        self._threaded = dispatch is None          # tests inject a synchronous dispatch + drive ticks
        self._dispatch = dispatch or self._enqueue
        self._clock = clock or time.time
        self.store = store or JobStore(cfg.state_dir)
        self._lock = threading.RLock()
        self._queue: queue.Queue = queue.Queue()
        self._closed = False
        self._threads: list = []
        self._poll_now = threading.Event()
        self._docker_logs = DockerLogs()
        self._docker_slots = threading.BoundedSemaphore(2)

        self._zenoh = None
        self._session = None
        self._token = None
        self._queryables: list = []
        self._pub_state = None
        self._pub_events = None

        self.base: Optional[str] = None
        self.vehicle: Optional[str] = None
        self.vehicle_id: Optional[str] = None
        self.rig_version: Optional[str] = None
        self.self_instance: Optional[str] = None
        self.state: Optional[dict] = None
        self._published: Optional[dict] = None
        self._last_publish = 0.0
        self._since = self._clock()

        self._status = None
        self._status_error: Optional[str] = rigcmd.check(cfg)
        self._status_at: Optional[float] = None
        self._tree_error: Optional[str] = None
        self._rows: list = []
        self._trio: set = set()
        self._open_run = None
        self._registry_problem: Optional[str] = None
        self._registry_sig = None
        self._run_disk_kb: Optional[int] = None
        self._free_kb: Optional[int] = None
        self._disk_at = 0.0

        self._runner = None
        self._recovered = False
        self._recovery_error: Optional[str] = None
        self._starting_job_id: Optional[str] = None
        self.current_job: Optional[Job] = None
        self._job_info: Optional[dict] = None
        self._stop_reasons: dict = {}
        self._stop_attempts: dict = {}
        self._supervision_error: Optional[str] = None
        self._last_tail: Optional[list] = None
        self._last_event_at = 0.0

    # ---- lifecycle ---------------------------------------------------------------------------
    @property
    def active(self) -> bool:
        return self._token is not None

    def _enqueue(self, fn, *args) -> None:
        self._queue.put((fn, args))

    def start(self) -> None:
        if self._status_error:
            log.error("rig unusable: %s", self._status_error)
        for d in (self.store.dir, self.cfg.state_dir / "home"):
            try:
                d.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                log.error("cannot create %s: %s (is var/ writable by this uid?)", d, e)
        self._read_version()
        self.poll_once()
        if self._threaded:
            for name, target in (("worker", self._worker_loop), ("poller", self._poll_loop),
                                 ("watcher", self._watch_loop)):
                t = threading.Thread(target=target, name=f"rig-agent-{name}", daemon=True)
                t.start()
                self._threads.append(t)

    def serve(self) -> None:
        self.start()
        while not self._closed:
            time.sleep(0.5)

    def close(self) -> None:
        self._closed = True
        self._poll_now.set()
        if self._session is not None:
            log.info("withdrawing %s", self.base)
        self._safe_close()

    # ---- rig status / snapshot ---------------------------------------------------------------
    def _read_version(self) -> None:
        try:
            res = self._run_rig(self.cfg, ["--version"], VERSION_TIMEOUT_S)
        except Exception as e:   # noqa: BLE001
            log.warning("rig --version failed: %s", e)
            return
        if res.ok:
            text = (res.stdout or "").strip()
            self.rig_version = text[4:].strip() if text.startswith("rig ") else (text or None)

    def poll_once(self) -> bool:
        """One `rig status --format json`; rebuild + publish the snapshot; advertise once possible."""
        now = self._clock()
        try:
            res = self._run_rig(self.cfg, ["status", "--format", "json"], STATUS_TIMEOUT_S)
        except Exception as e:   # noqa: BLE001
            res = None
            self._status_error = f"rig status could not run: {e}"
        if res is not None:
            if res.ok:
                try:
                    doc = parse_status_json(res.stdout)
                    self._status, self._status_error, self._status_at = doc, None, now
                    self._adopt_identity(doc)
                except StatusError as e:
                    self._status_error = f"rig status: {e}"
            elif res.timed_out:
                self._status_error = f"rig status timed out after {int(STATUS_TIMEOUT_S)} s"
            else:
                self._status_error = error_message(res.stderr, res.stdout) or \
                    f"rig status failed (exit {res.returncode})"
        if self._runner is not None and not self._recovered:
            self._recover_jobs()
        self._read_tree()
        self._refresh_registry(force=True)
        self._rebuild(now)
        if self.base and not self.active and not self._closed:
            self.advertise()
        self._maybe_publish_state(now)
        return self._status_error is None

    def _adopt_identity(self, doc) -> None:
        if self.base is None:
            self.vehicle, self.vehicle_id = doc.vehicle, doc.vehicle_id
            self.base = keys.key_base(doc.vehicle_id)
            self._runner = self._runner_factory(self.cfg, doc.vehicle_id)
            log.info("deployment %s (vehicle_id %s) → %s", doc.vehicle, doc.vehicle_id, self.base)
        elif doc.vehicle_id != self.vehicle_id:
            log.warning("vehicle_id changed %s → %s; keeping %s (restart the agent to re-key)",
                        self.vehicle_id, doc.vehicle_id, self.base)
        self.vehicle = doc.vehicle

    def _read_tree(self) -> None:
        try:
            self._rows = vehicle_mod.read_vehicle_rows(self.cfg.root)
            self._trio = vehicle_mod.read_state_verb_services(self.cfg.root)
            self._tree_error = None
        except vehicle_mod.VehicleError as e:
            self._tree_error = str(e)

    def _refresh_registry(self, force: bool = False) -> bool:
        data = self.cfg.data_dir
        if data is None:
            self._open_run, self._registry_problem = None, None
            return False
        sig = registry_mod.signature(data)
        changed = force or sig != self._registry_sig
        run_flipped = False
        if changed:
            self._registry_sig = sig
            previous = self._open_run.id if self._open_run else None
            try:
                self._open_run, self._registry_problem = registry_mod.current_run(data), None
            except registry_mod.RegistryError as e:
                self._open_run, self._registry_problem = None, str(e)
            run_flipped = (self._open_run.id if self._open_run else None) != previous
        now = self._clock()
        if run_flipped or now - self._disk_at >= DISK_TICK_S:
            self._free_kb = registry_mod.free_kb(data)
            self._run_disk_kb = registry_mod.du_kb(self._open_run.dir) if self._open_run else None
            self._disk_at = now
        return changed

    def _rebuild(self, now: float) -> None:
        self.self_instance = vehicle_mod.self_instance(self._rows, self.vehicle_id, self.cfg.project)
        stacks = snap.build_stacks(self._status, self._rows, self._trio, self.vehicle_id, self.self_instance)
        run = None
        if self._open_run is not None:
            run = registry_mod.open_run_summary(self._open_run)
            run["disk_kb"] = self._run_disk_kb
        registry = {"data_dir": str(self.cfg.data_dir) if self.cfg.data_dir else None,
                    "free_kb": self._free_kb, "problem": self._registry_problem}
        state = snap.build_state(vehicle=self.vehicle or "", vehicle_id=self.vehicle_id or "",
                                 at_unix_s=self._status_at or now, ok=self._status_error is None,
                                 error=self._status_error or self._tree_error, rig_version=self.rig_version,
                                 run=run, registry=registry, stacks=stacks)
        with self._lock:
            self.state = state

    def _job_doc(self) -> Optional[dict]:
        with self._lock:
            job = self.current_job
        return job.to_json() if job is not None and not job.terminal else None

    def state_doc(self) -> dict:
        with self._lock:
            state = self.state
        if state is None:
            return {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": "no snapshot yet",
                    "vehicle_id": self.vehicle_id, "vehicle": self.vehicle, "stacks": [], "job": None}
        return {**state, "job": self._job_doc()}

    def descriptor(self) -> dict:
        return snap.build_descriptor(self.cfg, vehicle=self.vehicle or "", vehicle_id=self.vehicle_id or "",
                                     rig_version=self.rig_version, since_unix_s=self._since,
                                     self_instance=self.self_instance, job=self._job_doc())

    def _maybe_publish_state(self, now: float) -> None:
        with self._lock:
            state = self.state
        if snap.state_changed(self._published, state) or now - self._last_publish >= HEARTBEAT_POLLS * self.cfg.poll_s:
            self._publish_state()

    def _publish_state(self) -> None:
        with self._lock:
            state = self.state
        self._published = state
        self._last_publish = self._clock()
        if self._pub_state is None or state is None:
            return
        try:
            self._pub_state.put(encode_json({**state, "job": self._job_doc()}), encoding=self._json_encoding())
        except Exception as e:   # noqa: BLE001
            log.warning("state publish failed: %s", e)

    # ---- loops --------------------------------------------------------------------------------
    def _poll_loop(self) -> None:
        while not self._closed:
            t0 = self._clock()
            try:
                self.poll_once()
            except Exception:   # noqa: BLE001
                log.exception("status poll failed")
            wait = max(1.0, self.cfg.poll_s - (self._clock() - t0))
            self._poll_now.wait(wait)
            self._poll_now.clear()

    def _watch_loop(self) -> None:
        while not self._closed:
            try:
                if self._refresh_registry():
                    now = self._clock()
                    self._rebuild(now)
                    self._maybe_publish_state(now)
            except Exception:   # noqa: BLE001
                log.exception("registry watch failed")
            time.sleep(REGISTRY_TICK_S)

    def _worker_loop(self) -> None:
        while not self._closed:
            try:
                fn, args = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                fn(*args)
            except Exception:   # noqa: BLE001
                log.exception("worker task failed")

    # ---- zenoh --------------------------------------------------------------------------------
    def advertise(self) -> bool:
        """Open the session and declare everything — queryables and publishers first, the token
        last, and only once a state snapshot exists. Idempotent; returns True iff advertising."""
        if self.base is None or self.state is None:
            return False
        if self._session is not None:
            return self.active
        b = self.base
        try:
            s = self._session = self._open(list(self.cfg.connect), list(self.cfg.listen))
            self._queryables = [
                s.declare_queryable(b, self._on_query_descriptor),
                s.declare_queryable(keys.state_key(b), self._on_query_state),
                s.declare_queryable(keys.runs_key(b), self._on_query_runs),
                s.declare_queryable(keys.run_pattern(b), self._on_query_run),
                s.declare_queryable(keys.jobs_key(b), self._on_query_jobs),
                s.declare_queryable(keys.submit_key(b), self._on_query_submit),
                s.declare_queryable(keys.cancel_key(b), self._on_query_cancel),
                s.declare_queryable(keys.containers_key(b), self._on_query_containers),
                s.declare_queryable(keys.logs_key(b), self._on_query_logs),
            ]
            self._pub_state = s.declare_publisher(keys.state_key(b))
            self._pub_events = s.declare_publisher(keys.events_key(b))
            self._token = s.liveliness().declare_token(b)
            log.info("advertising %s (connect=%s listen=%s)", b, list(self.cfg.connect) or "scout",
                     list(self.cfg.listen) or "-")
            self._publish_state()
            return True
        except Exception as e:   # noqa: BLE001
            log.warning("zenoh advertise failed (%s); retrying on the next poll", e)
            self._safe_close()
            return False

    def _open_zenoh(self, connect, listen):
        import zenoh   # lazy: the pure modules never need it
        self._zenoh = zenoh
        try:
            zenoh.init_log_from_env_or("error")
        except Exception:   # noqa: BLE001 -- older binding
            pass
        conf = zenoh.Config()
        conf.insert_json5("mode", '"peer"')
        if connect:
            conf.insert_json5("connect/endpoints", json.dumps(list(connect)))
        if listen:
            conf.insert_json5("listen/endpoints", json.dumps(list(listen)))
        conf.insert_json5("connect/timeout_ms", str(CONNECT_TIMEOUT_MS))
        conf.insert_json5("connect/exit_on_failure", "false")
        return zenoh.open(conf)

    def _safe_close(self) -> None:
        for label, obj in [("token", self._token), ("state publisher", self._pub_state),
                           ("events publisher", self._pub_events)] + [("queryable", q) for q in self._queryables]:
            try:
                if obj is not None:
                    obj.undeclare()
            except Exception as e:   # noqa: BLE001
                log.debug("undeclare %s failed: %s", label, e)
        self._token = self._pub_state = self._pub_events = None
        self._queryables = []
        try:
            if self._session is not None:
                self._session.close()
        except Exception as e:   # noqa: BLE001
            log.debug("session close failed: %s", e)
        self._session = None

    def _json_encoding(self):
        return self._zenoh.Encoding.APPLICATION_JSON if self._zenoh is not None else None

    def _reply(self, query, obj) -> None:
        try:
            key = query.key_expr if hasattr(query, "key_expr") else self.base
            query.reply(key, encode_json(obj), encoding=self._json_encoding())
        except Exception as e:   # noqa: BLE001
            log.warning("reply failed: %s", e)

    # ---- queries (zenoh threads; answered from cached documents / the filesystem) ---------------
    def _on_query_descriptor(self, query) -> None:
        self._reply(query, self.descriptor())

    def _on_query_state(self, query) -> None:
        self._reply(query, self.state_doc())

    def _on_query_runs(self, query) -> None:
        try:
            self._reply(query, self.runs_doc())
        except Exception as e:   # noqa: BLE001
            self._reply(query, {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": f"registry read failed: {e}"})

    def _on_query_run(self, query) -> None:
        run_id = keys.parse_run_key(self.base or "", str(getattr(query, "key_expr", "")))
        try:
            self._reply(query, self.run_doc(run_id))
        except Exception as e:   # noqa: BLE001
            self._reply(query, {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": f"registry read failed: {e}"})

    def _on_query_jobs(self, query) -> None:
        self._reply(query, self.jobs_doc())

    def _docker_query(self, query, fn, *args) -> None:
        # No unbounded queue: logs must neither occupy Zenoh callbacks nor delay rig jobs/status.
        if self._closed or not self._docker_slots.acquire(blocking=False):
            self._reply(query, {"ok": False, "error": "Docker log reader busy; retry shortly"})
            return

        def work():
            try:
                self._reply(query, fn(*args))
            except Exception as e:  # noqa: BLE001 — every Docker failure answers the query
                self._reply(query, {"ok": False, "error": str(e)})
            finally:
                self._docker_slots.release()

        try:
            threading.Thread(target=work, name="rig-agent-docker-read", daemon=True).start()
        except Exception:
            self._docker_slots.release()
            self._reply(query, {"ok": False, "error": "Could not start Docker log reader"})

    def _on_query_containers(self, query) -> None:
        self._docker_query(query, self._docker_logs.containers)

    def _on_query_logs(self, query) -> None:
        try:
            container, tail = self._docker_logs.parse_request(_query_bytes(query))
        except (ValueError, TypeError) as e:
            self._reply(query, {"ok": False, "error": str(e)})
            return
        self._docker_query(query, self._docker_logs.logs, container, tail)

    def _on_query_submit(self, query) -> None:
        try:
            self._reply(query, self.submit(_query_bytes(query), _query_parameters(query)))
        except Exception as e:   # noqa: BLE001
            log.exception("submit failed")
            self._reply(query, {"ok": False, "error": f"internal error: {e}"})

    def _on_query_cancel(self, query) -> None:
        raw = _query_bytes(query)
        job_id = None
        try:
            if raw:
                doc = json.loads(bytes(raw).decode("utf-8"))
                job_id = doc.get("job_id") if isinstance(doc, dict) else None
            else:
                for part in _query_parameters(query).replace("&", ";").split(";"):
                    if part.startswith("job_id="):
                        job_id = part[len("job_id="):].strip()
        except (ValueError, UnicodeDecodeError) as e:
            self._reply(query, {"ok": False, "error": f"request is not JSON: {e}"})
            return
        if not isinstance(job_id, str) or not job_id:
            self._reply(query, {"ok": False, "error": "missing 'job_id'"})
            return
        self._reply(query, self.cancel(job_id))

    def runs_doc(self) -> dict:
        data = self.cfg.data_dir
        base = {"schema_version": snap.SCHEMA_VERSION, "ok": True,
                "data_dir": str(data) if data else None, "current": None, "problem": None, "runs": []}
        if data is None:
            return base
        rows, problem = registry_mod.list_runs(data)
        current, _ = registry_mod.current_run_id(data)
        return {**base, "current": current, "problem": problem, "runs": [r.to_json() for r in rows]}

    def run_doc(self, run_id: Optional[str]) -> dict:
        if not run_id:
            return {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": "missing run id"}
        data = self.cfg.data_dir
        if data is None:
            return {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": "registry inert (no data_dir)"}
        d = registry_mod.run_dir(data, run_id)
        if d is None:
            return {"schema_version": snap.SCHEMA_VERSION, "ok": False, "error": "no such run"}
        return {"schema_version": snap.SCHEMA_VERSION, "ok": True, "run": run_id,
                "state": registry_mod.run_state(data, run_id), "dir": str(d),
                "manifest": registry_mod.run_manifest(data, run_id)}

    def jobs_doc(self) -> dict:
        jobs = self.store.list()
        with self._lock:
            current = self.current_job
        if current is not None and not current.terminal:
            jobs = [current] + [j for j in jobs if j.job_id != current.job_id]
        return {"schema_version": snap.SCHEMA_VERSION, "ok": True, "jobs": [j.to_json() for j in jobs]}

    # ---- jobs ----------------------------------------------------------------------------------
    def submit(self, payload: Optional[bytes], parameters: str = "") -> dict:
        if not self.cfg.actuate:
            return {"ok": False, "error": "actuation disabled"}
        if self.base is None or self._runner is None:
            return {"ok": False, "error": "no status snapshot yet — rig status has not answered"}
        with self._lock:
            stacks = list((self.state or {}).get("stacks") or [])
        names = [s["name"] for s in stacks]
        trio = [s["name"] for s in stacks if s.get("state_verbs")]
        req, err = parse_submit(payload, parameters, known_names=names, state_verb_names=trio)
        if err:
            return {"ok": False, "error": err}
        with self._lock:
            if not self._recovered:
                return {"ok": False, "error": f"job recovery pending: {self._recovery_error or 'checking runners'}"}
            running = self.current_job if self.current_job is not None and not self.current_job.terminal else None
            if running is not None:
                return {"ok": False, "error": f"busy: {running.job_id} ({' '.join(running.argv)}) is running",
                        "job_id": running.job_id}
            now = self._clock()
            job = Job(job_id=new_job_id(now), verb=req.verb, args=req.args(), argv=verb_argv(req),
                      client=req.client, self_terminating=self_terminating(req, self.self_instance),
                      timeout_s=req.timeout_s, state="queued", submitted_unix_s=now,
                      runner={"kind": self._runner.kind})
            self.store.save(job)
            self.current_job = job
            self._job_info = None
            self._supervision_error = None
            self._last_tail = None
        log.info("job %s queued: %s (client %s)", job.job_id, " ".join(job.argv), job.client or "-")
        self._publish_event(job, force=True)
        self._dispatch(self._start_job, job.job_id)
        return {"ok": True, "job_id": job.job_id, "job": job.to_json()}

    def _start_job(self, job_id: str) -> None:
        with self._lock:
            job = self.current_job
            if job is None or job.job_id != job_id or job.terminal:
                return
            self._starting_job_id = job_id
        try:
            info = self._runner.spawn(job)
        except RunnerStartUncertain as e:
            # The detached container may already be executing the verb. Keep the slot reserved
            # and reconcile its deterministic name; never rerun the verb on a lost response.
            info = e.info
            job.error = f"runner start unconfirmed: {e}"
            log.warning("job %s: %s", job_id, job.error)
        except Exception as e:   # noqa: BLE001
            with self._lock:
                job.state, job.error, job.error_kind = "failed", f"could not start the runner: {e}", "other"
                job.ended_unix_s = self._clock()
                self.store.save(job)
                self._starting_job_id = None
            log.error("job %s: %s", job_id, job.error)
            self._publish_event(job, force=True)
            self._finish_job(job_id)
            return
        with self._lock:
            self._job_info = info
            self._starting_job_id = None
        log.info("job %s started (%s)", job_id, info)
        if self._threaded:
            t = threading.Thread(target=self._supervise_loop, name=f"rig-agent-job-{job_id}", daemon=True)
            t.start()
            self._threads.append(t)

    def _supervise_loop(self) -> None:
        while not self._closed:
            try:
                if self.supervise_once():
                    return
            except Exception:   # noqa: BLE001
                log.exception("job supervision failed")
            time.sleep(SUPERVISE_TICK_S)

    def supervise_once(self) -> bool:
        """One supervision tick for the current job: progress event on a changed log tail, the
        deadline, and finalization once the runner exits. True when the job is done."""
        with self._lock:
            job, info = self.current_job, self._job_info
        if job is None or job.terminal:
            return True
        if info is None:
            return False   # not spawned yet
        now = self._clock()
        record = self.store.load(job.job_id)
        if record is not None and not record.terminal:
            job.state, job.started_unix_s, job.deadline_unix_s = record.state, record.started_unix_s, record.deadline_unix_s
            if record.started_unix_s is not None:
                job.error = record.error
        tail = tail_lines(self.store.log_path(job.job_id))
        if tail and tail != self._last_tail:
            job.log_tail = tail
            if self._publish_event(job):
                self._last_tail = tail
        try:
            running, rc = self._runner.poll(info)
        except Exception as e:   # noqa: BLE001 — unknown state keeps the job and its slot intact
            if self._supervision_error != str(e):
                log.warning("job %s: cannot observe runner; will retry: %s", job.job_id, e)
            self._supervision_error = str(e)
            return False
        self._supervision_error = None
        if running:
            deadline = job.deadline_unix_s or (job.submitted_unix_s + job.timeout_s)
            with self._lock:
                if now > deadline + DEADLINE_SLACK_S:
                    self._stop_reasons.setdefault(job.job_id, "timeout")
                reason = self._stop_reasons.get(job.job_id)
            if reason:
                self._request_stop(job, reason)
            return False
        # The runner exited: its record is authoritative; fill in what it could not know.
        final = self.store.load(job.job_id)
        tail = tail_lines(self.store.log_path(job.job_id))
        with self._lock:
            # Publishing the terminal state releases the slot to submit(). Keep the entire
            # transition atomic so finalization cannot overwrite a newly reserved job.
            if final is not None and final.terminal:
                job = final
            else:
                job.state, job.error, job.error_kind = "failed", job.error or f"runner exited (rc {rc}) without a terminal record", "other"
                job.exit_code, job.ended_unix_s = rc, now
            reason = self._stop_reasons.pop(job.job_id, None)
            self._stop_attempts.pop(job.job_id, None)
            if reason == "cancelled":
                job.state, job.error, job.error_kind = "cancelled", "cancelled", None
            elif reason == "timeout":
                job.state, job.error, job.error_kind = "killed", f"deadline exceeded ({job.timeout_s} s)", "timeout"
            job.log_tail = tail or job.log_tail
            job.runner = {**job.runner, **info}
            self.store.save(job)
            self.current_job = job
        try:
            self._runner.cleanup(info)
        except Exception as e:   # noqa: BLE001
            log.debug("runner cleanup failed: %s", e)
        log.info("job %s %s: %s", job.job_id, job.state, job.error or "ok")
        self._publish_event(job, force=True)
        self._finish_job(job.job_id)
        return True

    def _finish_job(self, job_id: str) -> None:
        with self._lock:
            # A new submit may have reserved the next job after the previous one became terminal.
            if self.current_job is not None and self.current_job.job_id == job_id:
                self._job_info = None
                self._last_tail = None
        try:
            self.store.sweep()
        except Exception as e:   # noqa: BLE001
            log.debug("sweep failed: %s", e)
        if self._threaded:
            self._poll_now.set()

    def _request_stop(self, job: Job, reason: str) -> None:
        # Called by supervision only: docker stop can take tens of seconds. Retry failures and
        # keep the job busy until a subsequent poll confirms it has actually stopped.
        now = self._clock()
        with self._lock:
            info = self._job_info
            if info is None or now - self._stop_attempts.get(job.job_id, float("-inf")) < RETRY_S:
                return
            self._stop_reasons.setdefault(job.job_id, reason)
            self._stop_attempts[job.job_id] = now
        try:
            self._runner.stop(info)
        except Exception as e:   # noqa: BLE001
            log.warning("could not stop job %s: %s", job.job_id, e)

    def cancel(self, job_id: str) -> dict:
        if not self.cfg.actuate:
            return {"ok": False, "error": "actuation disabled"}
        with self._lock:
            job = self.current_job
            if job is None or job.job_id != job_id or job.terminal:
                known = self.store.load(job_id)
                if known is None:
                    return {"ok": False, "error": "no such job"}
                return {"ok": False, "error": f"job {job_id} is {known.state}", "job": known.to_json()}
            queued = self._job_info is None and self._starting_job_id != job_id
            if queued:
                job.state, job.error, job.ended_unix_s = "cancelled", "cancelled before it started", self._clock()
                self.store.save(job)
            else:
                self._stop_reasons.setdefault(job_id, "cancelled")
        if queued:
            self._publish_event(job, force=True)
            self._finish_job(job_id)
        return {"ok": True, "job": job.to_json()}

    def _publish_event(self, job: Job, force: bool = False) -> bool:
        now = self._clock()
        if not force and now - self._last_event_at < EVENT_MIN_INTERVAL_S:
            return False
        self._last_event_at = now
        if self._pub_events is None:
            return True
        try:
            self._pub_events.put(encode_json(job.to_json()), encoding=self._json_encoding())
        except Exception as e:   # noqa: BLE001
            log.warning("job event publish failed: %s", e)
        return True

    def _recover_jobs(self) -> bool:
        """After a restart: re-attach to a runner still finishing, reap exited ones, and fail records
        that claim to run but have no runner."""
        try:
            leftovers = self._runner.sweep()
        except Exception as e:   # noqa: BLE001
            self._recovery_error = f"cannot inspect existing runners: {e}"
            log.warning("%s; preserving records and retrying", self._recovery_error)
            return False
        active = [entry for entry in leftovers if entry["running"]]
        records = {entry["job_id"]: self.store.load(entry["job_id"]) for entry in leftovers}
        if len(active) > 1 or any(records[e["job_id"]] is None or records[e["job_id"]].terminal for e in active):
            self._recovery_error = "multiple or untracked active runners; waiting for them to exit"
            log.warning("%s; leaving all runners intact", self._recovery_error)
            return False
        attached = active[0]["job_id"] if active else None
        for entry in leftovers:
            record = records[entry["job_id"]]
            if entry["running"]:
                continue
            if record is not None and not record.terminal:
                record.state, record.error, record.error_kind = "failed", "runner exited while the agent was down", "other"
                record.ended_unix_s = self._clock()
                self.store.save(record)
            try:
                self._runner.cleanup(entry["info"])
            except Exception:   # noqa: BLE001
                pass
        for job in self.store.list():
            if not job.terminal and job.job_id != attached:
                job.state, job.error, job.error_kind = "failed", "agent restarted; no runner found", "other"
                job.ended_unix_s = self._clock()
                self.store.save(job)
        with self._lock:
            if active:
                self.current_job, self._job_info = records[attached], active[0]["info"]
            self._recovered, self._recovery_error = True, None
        if active:
            log.info("re-attaching to running job %s", attached)
            if self._threaded:
                t = threading.Thread(target=self._supervise_loop, name=f"rig-agent-job-{attached}", daemon=True)
                t.start()
                self._threads.append(t)
        return True
