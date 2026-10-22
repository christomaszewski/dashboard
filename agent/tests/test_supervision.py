"""Fault injection for the job slot: uncertainty must never authorize removal or another verb."""
import subprocess
import threading
import unittest
from unittest.mock import Mock

from test_agent import Harness
from rig_agent.jobs import Job
from rig_agent.runner import DockerRunner, RunnerError, RunnerStartUncertain


def submit(h):
    return h.agent.submit(b'{"verb":"up","names":["cam_front"]}')


def saved_job(h, job_id="j-20261021T120000Z-live"):
    job = Job(job_id=job_id, verb="up", args={}, argv=["up"], client=None,
              self_terminating=False, timeout_s=600, state="running", submitted_unix_s=900,
              started_unix_s=901, deadline_unix_s=1501)
    h.store.save(job)
    h.runner.leftovers.append({"job_id": job_id, "info": {"job_id": job_id}, "running": True})
    h.runner.running[job_id] = (True, None)
    return job


class SupervisionTests(unittest.TestCase):
    def test_docker_outage_preserves_job_then_recovers_without_force_removal(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        calls, replies = [], {}

        def docker(argv, **kw):
            calls.append(argv)
            return replies.get(argv[1], subprocess.CompletedProcess(argv, 0, "", ""))

        h.agent._runner_factory = lambda cfg, vid: DockerRunner(cfg, vid, run=docker)
        h.agent.poll_once()
        ack = submit(h)
        job_id = ack["job_id"]
        original = h.store.path(job_id).read_bytes()
        replies["inspect"] = subprocess.CompletedProcess([], 1, "", "daemon temporarily unavailable")
        replies["ps"] = subprocess.CompletedProcess([], 1, "", "daemon temporarily unavailable")
        for _ in range(2):
            self.assertFalse(h.agent.supervise_once())
            self.assertIn("busy", submit(h)["error"])
            self.assertEqual(h.store.path(job_id).read_bytes(), original)
        self.assertFalse(any(c[1] in ("rm", "stop") for c in calls))
        replies["inspect"] = subprocess.CompletedProcess([], 0, '{"Status":"running","ExitCode":0}', "")
        self.assertFalse(h.agent.supervise_once())
        completed = h.store.load(job_id)
        completed.state, completed.exit_code = "succeeded", 0
        h.store.save(completed)
        replies["inspect"] = subprocess.CompletedProcess([], 0, '{"Status":"exited","ExitCode":0}', "")
        self.assertTrue(h.agent.supervise_once())
        self.assertEqual(h.store.load(job_id).state, "succeeded")
        self.assertEqual([c for c in calls if c[1] == "rm"], [["docker", "rm", "rig-agent-job-" + job_id]])

    def test_uncertain_launch_keeps_slot_and_never_repeats_the_verb(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        h.agent.poll_once()

        def uncertain(job):
            h.runner.running[job.job_id] = (True, None)
            raise RunnerStartUncertain("Docker response timed out", {"job_id": job.job_id})

        h.runner.spawn = Mock(side_effect=uncertain)
        ack = submit(h)
        self.assertTrue(ack["ok"])
        self.assertFalse(h.store.load(ack["job_id"]).terminal)
        self.assertFalse(h.agent.supervise_once())
        self.assertIn("busy", submit(h)["error"])
        h.runner.spawn.assert_called_once()
        h.runner.running[ack["job_id"]] = (False, None)  # positive absence/exited observation
        self.assertTrue(h.agent.supervise_once())
        self.assertIn("start unconfirmed", h.store.load(ack["job_id"]).error)
        self.assertTrue(submit(h)["ok"])

    def test_failed_recovery_preserves_records_blocks_submit_and_retries(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        job = saved_job(h)
        original = h.store.path(job.job_id).read_bytes()
        sweep = h.runner.sweep
        h.runner.sweep = Mock(side_effect=RunnerError("daemon unreachable"))
        h.agent.poll_once()
        self.assertFalse(h.agent._recovered)
        self.assertIn("recovery pending", submit(h)["error"])
        self.assertEqual(h.store.path(job.job_id).read_bytes(), original)
        self.assertEqual(h.runner.cleaned, [])
        h.runner.sweep = sweep
        h.agent.poll_once()
        self.assertTrue(h.agent._recovered)
        self.assertEqual(h.agent.current_job.job_id, job.job_id)
        self.assertFalse(h.agent.supervise_once())
        self.assertIn("busy", submit(h)["error"])

    def test_recovery_never_kills_extra_or_untracked_active_runners(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        first = saved_job(h)
        second = saved_job(h, "j-20261021T120001Z-other")
        h.agent.poll_once()
        self.assertFalse(h.agent._recovered)
        self.assertIn("recovery pending", submit(h)["error"])
        self.assertEqual(h.runner.cleaned, [])
        self.assertEqual([j.state for j in h.store.list()], ["running", "running"])
        h.runner.leftovers.pop()
        h.store.path(first.job_id).unlink()  # active container with an unreadable/missing record
        h.agent.poll_once()
        self.assertFalse(h.agent._recovered)
        self.assertEqual(h.runner.cleaned, [])
        h.store.save(first)
        h.agent.poll_once()
        self.assertTrue(h.agent._recovered)
        self.assertEqual(h.agent.current_job.job_id, first.job_id)
        self.assertEqual(h.store.load(second.job_id).state, "failed")

    def test_cancel_during_spawn_waits_for_runner_and_blocks_new_work(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        h.agent.poll_once()
        h.agent._dispatch = lambda *a: None  # drive the queued start on another thread
        entered, release = threading.Event(), threading.Event()
        spawn = h.runner.spawn

        def slow_start(job):
            entered.set()
            if not release.wait(2):
                raise AssertionError("test did not release spawn")
            return spawn(job)

        h.runner.spawn = slow_start
        ack = submit(h)
        thread = threading.Thread(target=h.agent._start_job, args=(ack["job_id"],))
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(h.agent.cancel(ack["job_id"])["ok"])
            self.assertEqual(h.runner.stopped, [])
            self.assertFalse(h.store.load(ack["job_id"]).terminal)
            self.assertIn("busy", submit(h)["error"])
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(h.agent.supervise_once())
        self.assertEqual(h.runner.stopped, [ack["job_id"]])
        self.assertTrue(h.agent.supervise_once())
        self.assertEqual(h.store.load(ack["job_id"]).state, "cancelled")

    def test_cancel_is_async_and_stop_failure_retries_without_releasing_slot(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        h.agent.poll_once()
        ack = submit(h)
        stop = h.runner.stop
        h.runner.stop = Mock(side_effect=RunnerError("stop failed"))
        self.assertTrue(h.agent.cancel(ack["job_id"])["ok"])
        h.runner.stop.assert_not_called()
        self.assertFalse(h.agent.supervise_once())
        h.runner.stop.assert_called_once()
        self.assertIn("busy", submit(h)["error"])
        self.assertFalse(h.agent.supervise_once())
        h.runner.stop.assert_called_once()  # no rapid retry
        h.t[0] += 6
        h.runner.stop.side_effect = stop
        self.assertFalse(h.agent.supervise_once())
        self.assertEqual(h.runner.stop.call_count, 2)
        self.assertTrue(h.agent.supervise_once())
        self.assertEqual(h.store.load(ack["job_id"]).state, "cancelled")

    def test_queued_cancel_and_old_finalization_cannot_erase_new_job(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        h.agent.poll_once()
        dispatch = h.agent._dispatch
        h.agent._dispatch = lambda *a: None
        old = submit(h)["job_id"]
        self.assertTrue(h.agent.cancel(old)["ok"])
        h.agent._start_job(old)
        self.assertEqual(h.runner.spawned, [])
        h.agent._dispatch = dispatch
        new = submit(h)["job_id"]
        h.agent._finish_job(old)
        self.assertEqual(h.agent._job_info["job_id"], new)
        self.assertFalse(h.agent.supervise_once())

    def test_read_only_agent_refuses_cancel_of_recovered_job(self):
        h = Harness(actuate=False)
        self.addCleanup(h.agent.close)
        job = saved_job(h)
        h.agent.poll_once()
        self.assertEqual(h.agent.cancel(job.job_id), {"ok": False, "error": "actuation disabled"})
        self.assertFalse(h.agent.supervise_once())
        self.assertEqual(h.runner.stopped, [])

    def test_finalization_cannot_overwrite_a_concurrent_submission(self):
        h = Harness()
        self.addCleanup(h.agent.close)
        h.agent.poll_once()
        old = submit(h)["job_id"]
        h.runner.running[old] = (False, 1)  # exited without writing its terminal record
        saving, release, submitting, submitted = (threading.Event() for _ in range(4))
        save = h.store.save
        result = []

        def slow_save(job):
            if job.job_id == old and job.terminal:
                saving.set()
                if not release.wait(2):
                    raise AssertionError("test did not release finalization")
            save(job)

        def next_submit():
            submitting.set()
            result.append(submit(h))
            submitted.set()

        h.store.save = slow_save
        finalizer = threading.Thread(target=h.agent.supervise_once)
        requester = threading.Thread(target=next_submit)
        finalizer.start()
        try:
            self.assertTrue(saving.wait(1))
            requester.start()
            self.assertTrue(submitting.wait(1))
            self.assertFalse(submitted.wait(0.1))  # terminal transition still owns the slot
        finally:
            release.set()
            finalizer.join(2)
            if requester.ident is not None:
                requester.join(2)
        self.assertFalse(finalizer.is_alive())
        self.assertFalse(requester.is_alive())
        self.assertTrue(result[0]["ok"])
        self.assertNotEqual(result[0]["job_id"], old)
        self.assertEqual(h.agent.current_job.job_id, result[0]["job_id"])
        self.assertEqual(h.agent._job_info["job_id"], result[0]["job_id"])
