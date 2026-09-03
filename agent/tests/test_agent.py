"""RigAgent against fake zenoh session/query objects and a scripted runner — no binding, no docker.
`dispatch` is synchronous and the supervision tick is driven by hand, so every state is inspectable."""
import json
import unittest
from pathlib import Path

from helpers import (STATUS_JSON, FakeRunner, Query, Session, make_config, make_tree, result, scripted_run_rig,
                     status_run_rig, tmpdir)

from rig_agent.agent import RigAgent
from rig_agent.jobs import JobStore
from rig_agent.runner import run_job

BASE = "fleet/1/rig"


class Harness:
    def __init__(self, *, run_rig=None, runner=None, actuate=True, data_dir=True):
        self.root = make_tree(tmpdir(), data_dir=data_dir)
        self.cfg = make_config(self.root, RIG_AGENT_ACTUATE="1" if actuate else "0")
        self.sessions = []
        self.fail_open = False
        self.t = [1_000.0]
        self.runner = runner if runner is not None else FakeRunner()
        self.store = JobStore(self.cfg.state_dir)

        def factory(connect, listen):
            if self.fail_open:
                raise RuntimeError("router unreachable")
            s = Session(connect, listen)
            self.sessions.append(s)
            return s

        self.agent = RigAgent(self.cfg, session_factory=factory, run_rig=run_rig or status_run_rig(),
                              runner_factory=lambda cfg, vid: self.runner, dispatch=lambda fn, *a: fn(*a),
                              clock=lambda: self.t[0], store=self.store)

    @property
    def session(self):
        return self.sessions[-1]

    def query(self, key, payload=None, parameters=""):
        """Route like zenoh would: an exact queryable, else the wildcard one whose prefix matches."""
        entry = self.session.queryables.get(key)
        if entry is None:
            for declared, candidate in self.session.queryables.items():
                if declared.endswith("/*") and key.startswith(declared[:-1]) and "/" not in key[len(declared) - 1:]:
                    entry = candidate
                    break
        cb, _ = entry
        q = Query(key, payload, parameters)
        cb(q)
        return q.last

    def events(self):
        return self.session.publishers[BASE + "/jobs/events"].puts

    def states(self):
        return self.session.publishers[BASE + "/state"].puts


class AdvertiseTests(unittest.TestCase):
    def test_first_poll_keys_the_agent_and_advertises_token_last(self):
        h = Harness()
        h.agent._read_version()
        self.assertTrue(h.agent.poll_once())
        a = h.agent
        self.assertEqual((a.base, a.vehicle, a.vehicle_id, a.rig_version, a.self_instance), (BASE, "orin-dev", "1", "0.2.46", "dashboard"))
        self.assertTrue(a.active)
        s = h.session
        self.assertEqual(s.connect, ["tcp/localhost:7447"])
        self.assertEqual(set(s.queryables), {BASE, BASE + "/state", BASE + "/runs", BASE + "/run/*", BASE + "/jobs",
                                             BASE + "/jobs/submit", BASE + "/jobs/cancel"})
        self.assertEqual(set(s.publishers), {BASE + "/state", BASE + "/jobs/events"})
        self.assertEqual(s.tokens[0].key, BASE)
        self.assertEqual(s.order[-1], "t", "the token is declared after every queryable and publisher")
        self.assertEqual(len(h.states()), 1, "the first snapshot is published on advertise")
        state = h.states()[0]
        self.assertTrue(state["ok"])
        self.assertEqual([r["name"] for r in state["stacks"]], ["zenoh-router", "dashboard", "lidar", "cam_front", "bag_player"])
        self.assertEqual(state["registry"]["data_dir"], str(h.cfg.data_dir))
        self.assertIsNone(state["run"])
        self.assertIsNone(state["job"])
        self.assertTrue(a.poll_once())
        self.assertEqual(len(h.sessions), 1, "advertise is idempotent")
        self.assertEqual(len(h.states()), 1, "an unchanged snapshot is not re-published")
        h.t[0] += 61
        a.poll_once()
        self.assertEqual(len(h.states()), 2, "…except as a heartbeat")

    def test_no_token_until_rig_status_answers(self):
        h = Harness(run_rig=scripted_run_rig(lambda a: result(a, rc=1, stderr="rig: vehicle.yaml: infra #0 needs `name`\n")))
        self.assertFalse(h.agent.poll_once())
        self.assertIsNone(h.agent.base)
        self.assertFalse(h.agent.active)
        self.assertEqual(h.sessions, [])
        doc = h.agent.state_doc()
        self.assertFalse(doc["ok"])
        self.assertIn("infra #0", doc["error"])

    def test_status_failure_after_advertising_keeps_the_last_rows(self):
        h = Harness()
        h.agent.poll_once()
        h.agent._run_rig = scripted_run_rig(lambda a: result(a, rc=None, timed_out=True))
        self.assertFalse(h.agent.poll_once())
        self.assertTrue(h.agent.active)
        state = h.agent.state_doc()
        self.assertFalse(state["ok"])
        self.assertIn("timed out", state["error"])
        self.assertEqual(state["stacks"][2]["state"], "running", "last good roll-up")

    def test_open_failure_is_contained_and_retried(self):
        h = Harness()
        h.fail_open = True
        h.agent.poll_once()
        self.assertFalse(h.agent.active)
        h.fail_open = False
        h.agent.poll_once()
        self.assertTrue(h.agent.active)

    def test_close_withdraws_everything(self):
        h = Harness()
        h.agent.poll_once()
        s = h.session
        h.agent.close()
        self.assertFalse(h.agent.active)
        self.assertEqual(s.closed, 1)
        self.assertEqual(s.tokens[0].undeclared, 1)
        self.assertTrue(all(p.undeclared == 1 for p in s.publishers.values()))
        self.assertTrue(all(q.undeclared == 1 for _cb, q in s.queryables.values()))


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.h.agent._read_version()
        self.h.agent.poll_once()

    def test_descriptor_and_state(self):
        d = self.h.query(BASE)
        self.assertEqual((d["schema_version"], d["service"], d["vehicle_id"], d["rig_version"]), (1, "rig-agent", "1", "0.2.46"))
        self.assertEqual(d["capabilities"], {"actuate": True, "verbs": ["standby", "activate", "up", "down", "new-run", "end-run"], "jobs": True})
        self.assertEqual(d["self_instance"], "dashboard")
        self.assertEqual(d["root"], str(self.h.root))
        s = self.h.query(BASE + "/state")
        self.assertEqual(s["stacks"][1], {"name": "dashboard", "service": "dashboard", "tier": "infra", "order": 5,
                                          "enabled": True, "project": "dashboard-vehicle-1", "state": "down", "health": "-",
                                          "op_state": None, "running": 0, "total": 0, "state_verbs": False, "self": True})

    def test_runs_and_run_detail(self):
        data = self.h.cfg.data_dir
        self.assertEqual(self.h.query(BASE + "/runs")["runs"], [])
        d = data / "runs" / "20260902T140000Z_flight1"
        d.mkdir(parents=True)
        (d / "manifest.yaml").write_text("run: 20260902T140000Z_flight1\nlabel: flight1\nstarted: '2026-09-02T14:00:00+00:00'\nstacks: [cam_front]\n")
        (data / "current").symlink_to(Path("runs") / "20260902T140000Z_flight1")
        runs = self.h.query(BASE + "/runs")
        self.assertEqual(runs["current"], "20260902T140000Z_flight1")
        self.assertEqual(runs["runs"][0]["state"], "OPEN")
        detail = self.h.query(BASE + "/run/20260902T140000Z_flight1")
        self.assertTrue(detail["ok"])
        self.assertEqual((detail["state"], detail["manifest"]["label"], detail["dir"]), ("OPEN", "flight1", str(d)))
        self.assertEqual(self.h.query(BASE + "/run/nope")["error"], "no such run")
        # the watcher picks the open run up without a status poll
        self.h.agent._refresh_registry()
        self.h.agent._rebuild(self.h.t[0])
        self.assertEqual(self.h.agent.state_doc()["run"]["label"], "flight1")
        self.assertEqual(self.h.agent.state_doc()["run"]["stacks"], ["cam_front"])

    def test_registry_inert_without_data_dir(self):
        h = Harness(data_dir=False)
        h.agent.poll_once()
        self.assertEqual(h.query(BASE + "/runs"), {"schema_version": 1, "ok": True, "data_dir": None, "current": None, "problem": None, "runs": []})
        self.assertIn("inert", h.query(BASE + "/run/x")["error"])
        self.assertIsNone(h.query(BASE)["data_dir"])


class JobTests(unittest.TestCase):
    def _succeeding_runner(self, h):
        def on_spawn(job):
            rig = scripted_run_rig(lambda a: result(a, stderr="==> lidar [ouster]: standby\nrig: done\n"))
            return run_job(h.cfg, h.store, job.job_id, run_rig=rig, install_signals=False)
        return FakeRunner(on_spawn=on_spawn)

    def test_submit_runs_to_completion_with_events(self):
        h = Harness()
        h.runner = self._succeeding_runner(h)
        h.agent.poll_once()
        reply = h.query(BASE + "/jobs/submit", json.dumps({"verb": "standby", "names": ["lidar"], "client": "test"}).encode())
        self.assertTrue(reply["ok"], reply)
        job_id = reply["job_id"]
        self.assertEqual(reply["job"]["argv"], ["standby", "lidar"])
        self.assertEqual(reply["job"]["state"], "queued")
        self.assertEqual(h.runner.spawned, [job_id])
        self.assertEqual(h.events()[0]["state"], "queued")
        self.assertTrue(h.agent.supervise_once())
        final = h.events()[-1]
        self.assertEqual((final["state"], final["exit_code"], final["client"]), ("succeeded", 0, "test"))
        self.assertEqual(final["log_tail"], ["==> lidar [ouster]: standby", "rig: done"])
        self.assertEqual(final["runner"]["kind"], "fake")
        self.assertEqual(h.runner.cleaned, [job_id])
        jobs = h.query(BASE + "/jobs")["jobs"]
        self.assertEqual([j["job_id"] for j in jobs], [job_id])
        self.assertIsNone(h.query(BASE + "/state")["job"])
        self.assertTrue(h.agent.supervise_once(), "idempotent once done")

    def test_busy_cancel_and_deadline(self):
        h = Harness()   # hanging runner
        h.agent.poll_once()
        first = h.query(BASE + "/jobs/submit", None, "verb=activate;names=lidar")
        self.assertTrue(first["ok"], first)
        job_id = first["job_id"]
        self.assertEqual(h.query(BASE + "/state")["job"]["job_id"], job_id, "the running job rides on the state")
        self.assertEqual(h.query(BASE)["job"]["job_id"], job_id)
        second = h.query(BASE + "/jobs/submit", json.dumps({"verb": "up"}).encode())
        self.assertFalse(second["ok"])
        self.assertIn("busy", second["error"])
        self.assertEqual(second["job_id"], job_id)
        self.assertFalse(h.agent.supervise_once(), "still running")
        self.assertEqual(h.query(BASE + "/jobs/cancel", json.dumps({"job_id": "j-nope"}).encode())["error"], "no such job")
        cancel = h.query(BASE + "/jobs/cancel", json.dumps({"job_id": job_id}).encode())
        self.assertTrue(cancel["ok"])
        self.assertEqual(h.runner.stopped, [job_id])
        self.assertTrue(h.agent.supervise_once())
        final = h.events()[-1]
        self.assertEqual((final["state"], final["error"]), ("cancelled", "cancelled"))
        again = h.query(BASE + "/jobs/cancel", json.dumps({"job_id": job_id}).encode())
        self.assertFalse(again["ok"])
        self.assertIn("is cancelled", again["error"])
        # a new job now runs; let it overrun its deadline
        third = h.query(BASE + "/jobs/submit", json.dumps({"verb": "up", "timeout_s": 60}).encode())
        self.assertTrue(third["ok"], third)
        h.t[0] += 30
        self.assertFalse(h.agent.supervise_once())
        self.assertEqual(h.runner.stopped, [job_id], "not yet")
        h.t[0] += 40
        self.assertFalse(h.agent.supervise_once(), "stop requested this tick")
        self.assertEqual(h.runner.stopped, [job_id, third["job_id"]])
        self.assertTrue(h.agent.supervise_once())
        final = h.events()[-1]
        self.assertEqual((final["state"], final["error_kind"], final["error"]), ("killed", "timeout", "deadline exceeded (60 s)"))

    def test_refusals(self):
        h = Harness()
        h.agent.poll_once()
        self.assertEqual(h.query(BASE + "/jobs/submit", json.dumps({"verb": "standby", "names": ["cam_front"]}).encode())["error"],
                         "standby/activate: 'cam_front' declares no state verbs")
        self.assertIn("unknown row", h.query(BASE + "/jobs/submit", json.dumps({"verb": "up", "names": ["nope"]}).encode())["error"])
        self.assertEqual(h.query(BASE + "/jobs/cancel", b"{}")["error"], "missing 'job_id'")
        self.assertEqual(h.runner.spawned, [])
        ro = Harness(actuate=False)
        ro.agent.poll_once()
        self.assertEqual(ro.query(BASE + "/jobs/submit", json.dumps({"verb": "up"}).encode()), {"ok": False, "error": "actuation disabled"})
        self.assertFalse(ro.query(BASE)["capabilities"]["actuate"])
        cold = Harness(run_rig=scripted_run_rig(lambda a: result(a, rc=1, stderr="rig: nope\n")))
        cold.agent.poll_once()
        self.assertIn("no status snapshot", cold.agent.submit(json.dumps({"verb": "up"}).encode())["error"])

    def test_self_terminating_and_spawn_failure(self):
        h = Harness()
        h.agent.poll_once()
        reply = h.query(BASE + "/jobs/submit", json.dumps({"verb": "down", "end_run": True}).encode())
        self.assertTrue(reply["job"]["self_terminating"])
        self.assertEqual(reply["job"]["argv"], ["down", "--end-run"])
        self.assertEqual(reply["job"]["timeout_s"], 900)
        h.query(BASE + "/jobs/cancel", json.dumps({"job_id": reply["job_id"]}).encode())
        h.agent.supervise_once()
        h.runner = FakeRunner(fail_spawn="docker: no such image")
        h.agent._runner = h.runner
        reply = h.query(BASE + "/jobs/submit", json.dumps({"verb": "up"}).encode())
        self.assertTrue(reply["ok"])
        final = h.events()[-1]
        self.assertEqual(final["state"], "failed")
        self.assertIn("could not start the runner: docker: no such image", final["error"])
        self.assertTrue(h.agent.supervise_once())
        self.assertIsNone(h.query(BASE + "/state")["job"])

    def test_recovery_after_restart(self):
        h = Harness()
        store = h.store
        from rig_agent.jobs import Job
        store.save(Job(job_id="j-20260902T140000Z-live", verb="activate", args={}, argv=["activate"], client=None,
                       self_terminating=False, timeout_s=600, state="running", submitted_unix_s=900.0, started_unix_s=901.0,
                       deadline_unix_s=1501.0))
        store.save(Job(job_id="j-20260902T130000Z-dead", verb="up", args={}, argv=["up"], client=None,
                       self_terminating=False, timeout_s=600, state="running", submitted_unix_s=1.0))
        store.save(Job(job_id="j-20260902T120000Z-lost", verb="up", args={}, argv=["up"], client=None,
                       self_terminating=False, timeout_s=600, state="queued", submitted_unix_s=1.0))
        h.runner.leftovers = [
            {"job_id": "j-20260902T140000Z-live", "info": {"kind": "fake", "job_id": "j-20260902T140000Z-live"}, "running": True},
            {"job_id": "j-20260902T130000Z-dead", "info": {"kind": "fake", "job_id": "j-20260902T130000Z-dead"}, "running": False},
        ]
        h.runner.running["j-20260902T140000Z-live"] = (True, None)
        h.agent.poll_once()
        self.assertEqual(h.agent.current_job.job_id, "j-20260902T140000Z-live", "re-attached")
        self.assertEqual(store.load("j-20260902T130000Z-dead").state, "failed")
        self.assertIn("agent was down", store.load("j-20260902T130000Z-dead").error)
        self.assertEqual(store.load("j-20260902T120000Z-lost").state, "failed")
        self.assertEqual(h.runner.cleaned, ["j-20260902T130000Z-dead"])
        self.assertFalse(h.agent.supervise_once(), "the live one is still supervised")
        h.runner.running["j-20260902T140000Z-live"] = (False, 0)
        self.assertTrue(h.agent.supervise_once())
        self.assertEqual(store.load("j-20260902T140000Z-live").state, "failed", "no terminal record from the runner → failed, not lost")


if __name__ == "__main__":
    unittest.main()
