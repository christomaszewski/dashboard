"""Opt-in disposable Docker bench; no vehicle services are started/stopped.

RIG_AGENT_DOCKER_TEST_IMAGE must contain the current rig_agent code. An optional
RIG_AGENT_TEST_RIG_SOURCE checkout adds the real CLI's empty-deployment run/seal check.
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from helpers import STATUS_JSON, Session, make_config, make_tree, status_run_rig
from rig_agent.agent import RigAgent
from rig_agent.runner import DockerRunner, RunnerError, container_name

IMAGE = os.environ.get("RIG_AGENT_DOCKER_TEST_IMAGE")
RIG_SOURCE = os.environ.get("RIG_AGENT_TEST_RIG_SOURCE")


@unittest.skipUnless(IMAGE, "set RIG_AGENT_DOCKER_TEST_IMAGE for the disposable Docker bench")
class DockerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rig-agent-docker-test-", dir="/tmp")
        self.root = make_tree(Path(self.temp.name).resolve())
        env = patch.dict(os.environ, {"RIG_HOME": str(self.root / "var" / "rig-home")})
        env.start()
        self.addCleanup(env.stop)
        self.vehicle_id = "test-" + uuid.uuid4().hex
        self.cfg = make_config(self.root, RIG_AGENT_RUNNER="docker", RIG_AGENT_IMAGE=IMAGE)
        (self.cfg.state_dir / "home").mkdir(parents=True)
        (self.root / "rig_cli" / "__main__.py").write_text(
            "import sys,time\nfrom pathlib import Path\n"
            "root=Path(sys.argv[sys.argv.index('--root')+1])\n"
            "print('disposable job started', flush=True)\n"
            "(root/'var'/'started').touch()\n"
            "while not (root/'var'/'release').exists(): time.sleep(0.05)\n"
            "print('disposable job complete', flush=True)\n")
        self.agents = []
        self.outage = False
        self.lost_start_reply = False
        self.stop_fails_once = False
        self.calls = []

    def tearDown(self):
        for agent in self.agents:
            agent.close()
        # Force is confined to test teardown and this unique test-only vehicle label.
        containers = subprocess.run(["docker", "ps", "-aq", "--filter",
                                     f"label=dashboard.rig-agent.vehicle={self.vehicle_id}"],
                                    capture_output=True, text=True, check=True, timeout=15).stdout.split()
        for container in containers:
            subprocess.run(["docker", "rm", "-f", container], capture_output=True, check=True, timeout=15)
        self.temp.cleanup()

    def docker(self, argv, **kwargs):
        self.calls.append(argv)
        if self.outage and argv[1] in ("inspect", "ps"):
            return subprocess.CompletedProcess(argv, 1, "", "injected Docker connectivity failure")
        if self.stop_fails_once and argv[1] == "stop":
            self.stop_fails_once = False
            return subprocess.CompletedProcess(argv, 1, "", "injected stop failure")
        result = subprocess.run(argv, **kwargs)
        if self.lost_start_reply and argv[1] == "run":
            self.lost_start_reply = False
            raise subprocess.TimeoutExpired(argv, 30)
        return result

    def agent(self, real_rig=False):
        doc = {**STATUS_JSON, "vehicle_id": self.vehicle_id}
        agent = RigAgent(self.cfg, session_factory=Session, dispatch=lambda fn, *args: fn(*args),
                         run_rig=None if real_rig else status_run_rig(doc),
                         runner_factory=lambda cfg, vid: DockerRunner(cfg, vid, run=self.docker))
        self.agents.append(agent)
        self.assertTrue(agent.poll_once(), agent.state_doc())
        return agent

    def until(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail("Docker bench condition did not complete before its deadline")
            time.sleep(0.1)

    def submit(self, agent, request=None):
        ack = agent.submit(json.dumps(request or {"verb": "up", "names": ["cam_front"]}).encode())
        self.assertTrue(ack["ok"], ack)
        return ack["job_id"]

    def test_live_job_survives_observation_outage_and_agent_restart(self):
        agent = self.agent()
        job_id = self.submit(agent)
        self.until(lambda: (self.root / "var" / "started").exists())
        with self.assertRaises(RunnerError):
            agent._runner.cleanup(agent._job_info)  # plain rm refuses a live runner
        self.assertTrue(agent._runner.poll(agent._job_info)[0])
        self.outage = True
        self.assertFalse(agent.supervise_once())
        self.assertFalse(agent.store.load(job_id).terminal)
        self.assertIn("busy", agent.submit(b'{"verb":"up"}')["error"])
        agent.close()  # actual detached container keeps executing
        replacement = self.agent()
        self.assertFalse(replacement._recovered)
        self.assertIn("recovery pending", replacement.submit(b'{"verb":"up"}')["error"])
        self.outage = False
        replacement.poll_once()
        self.assertEqual(replacement.current_job.job_id, job_id)
        (self.root / "var" / "release").touch()
        self.until(replacement.supervise_once)
        self.assertEqual(replacement.store.load(job_id).state, "succeeded")
        self.assertEqual(replacement._runner.poll({"container": container_name(job_id)}), (False, None))
        self.assertFalse(any(c[1:3] == ["rm", "-f"] for c in self.calls))

    def test_lost_start_reply_and_failed_stop_do_not_release_active_job(self):
        agent = self.agent()
        self.lost_start_reply = True
        job_id = self.submit(agent)
        self.until(lambda: (self.root / "var" / "started").exists())
        self.assertFalse(agent.supervise_once())
        self.assertEqual(len([c for c in self.calls if c[1] == "run"]), 1)
        self.stop_fails_once = True
        started = time.monotonic()
        self.assertTrue(agent.cancel(job_id)["ok"])
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertFalse(agent.supervise_once())
        self.assertTrue(agent._runner.poll(agent._job_info)[0])
        self.assertIn("busy", agent.submit(b'{"verb":"up"}')["error"])
        agent._stop_attempts[job_id] = 0  # advance the retry gate without a five-second test sleep
        self.until(agent.supervise_once)
        self.assertEqual(agent.store.load(job_id).state, "cancelled")

    @unittest.skipUnless(RIG_SOURCE, "set RIG_AGENT_TEST_RIG_SOURCE for the real CLI run/seal check")
    def test_real_rig_opens_and_seals_only_the_scratch_registry(self):
        shutil.copytree(Path(RIG_SOURCE) / "rig_cli", self.root / "rig_cli", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "vehicle.yaml").write_text(
            f"vehicle: integration-test\nvehicle_id: {self.vehicle_id}\ndata_dir: {self.cfg.data_dir}\n"
            "infra: []\nsensors: []\nautonomy: []\n")
        (self.root / "services.yaml").write_text("services: {}\n")
        (self.root / "vehicle.local.yaml").write_text(f"data_dir: {self.cfg.data_dir}\n")
        self.cfg = make_config(self.root, RIG_AGENT_RUNNER="docker", RIG_AGENT_IMAGE=IMAGE,
                               RIG_VEHICLE_LOCAL=self.root / "vehicle.local.yaml",
                               RIG_VEHICLE_LOCAL_HOST=self.root / "vehicle.local.yaml")
        agent = self.agent(real_rig=True)
        opened = self.submit(agent, {"verb": "new-run", "label": "integration"})
        self.until(agent.supervise_once)
        first = agent.store.load(opened)
        self.assertEqual(first.state, "succeeded", first.error)
        self.assertTrue(first.result["opened"])
        # There are no deployment services: down only seals this test's scratch run.
        sealed = self.submit(agent, {"verb": "down", "end_run": True})
        self.until(agent.supervise_once)
        last = agent.store.load(sealed)
        self.assertEqual(last.state, "succeeded", last.error)
        self.assertEqual(last.result["sealed"], first.result["opened"])
        self.assertFalse((self.cfg.data_dir / "current").exists())
