import json
import sys
import threading
import unittest
from unittest.mock import Mock

from helpers import Query
from test_agent import BASE, Harness
from rig_agent.docker_logs import DockerLogs, LOG_BYTES, capture

ID = "a" * 64


class DockerReadTests(unittest.TestCase):
    def test_inventory_includes_compose_identity_and_stopped_containers(self):
        stopped = dict(id=ID, name="cam-1", image="camera:local", state="exited", status="Exited (1)",
                       project="cam-vehicle-1", service="camera")
        running = {**stopped, "id": "b" * 64, "name": "cam-2", "state": "running"}
        run = Mock(return_value=(json.dumps(stopped) + "\n" + json.dumps(running), False))
        rows = DockerLogs(run).containers()["containers"]
        self.assertEqual(rows, [running, stopped])
        self.assertEqual(run.call_args.args[0][:5], ["docker", "ps", "--all", "--no-trunc", "--format"])
        run.return_value = ("", True)
        with self.assertRaisesRegex(ValueError, "inventory exceeds"):
            DockerLogs(run).containers()

    def test_request_refuses_options_injection_and_unbounded_tails(self):
        for doc in ({}, [], {"container_id": "--help"}, {"container_id": "a" * 12},
                    *({"container_id": ID, "tail": tail} for tail in (0, -1, 501, "all", True, 1.5)),
                    {"container_id": ID, "argv": ["--follow"]}):
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                DockerLogs.parse_request(json.dumps(doc).encode())
        self.assertEqual(DockerLogs.parse_request(json.dumps({"container_id": ID}).encode()), (ID, 200))
        run = Mock(return_value=("log\n", True))
        doc = DockerLogs(run).logs(ID, 100)
        run.assert_called_once_with(["docker", "logs", "--timestamps", "--tail", "100", ID], LOG_BYTES)
        self.assertEqual((doc["container_id"], doc["text"], doc["truncated"]), (ID, "log\n", True))

    def test_capture_bounds_memory_combines_streams_and_reports_failures(self):
        text, truncated = capture([sys.executable, "-c", "import os; os.write(1,b'x'*100000); os.write(2,b'ERR')"], 100)
        self.assertEqual(text, "x" * 97 + "ERR")
        self.assertTrue(truncated)
        with self.assertRaisesRegex(ValueError, "no such container"):
            capture([sys.executable, "-c", "import sys; print('no such container',file=sys.stderr); sys.exit(1)"], 100)
        with self.assertRaisesRegex(ValueError, "timed out"):
            capture([sys.executable, "-c", "import time; time.sleep(10)"], 100, timeout_s=0.05)
        with self.assertRaisesRegex(ValueError, "too large"):
            capture([sys.executable, "-c", "import os; os.write(1,b'x'*5000000)"], 100)


class DockerQueryTests(unittest.TestCase):
    def test_read_only_agent_replies_asynchronously_and_limits_concurrency(self):
        h = Harness(actuate=False)
        h.agent.poll_once()
        entered = threading.Event()
        release = threading.Event()
        complete = threading.Event()

        def read():
            entered.set()
            release.wait(2)
            return {"schema_version": 1, "ok": True, "containers": []}

        h.agent._docker_logs.containers = read
        q = Query(BASE + "/docker/containers")
        original_reply = q.reply

        def reply(*a, **kw):
            original_reply(*a, **kw)
            complete.set()

        q.reply = reply
        try:
            h.agent._docker_slots.acquire()  # one other viewer already working
            h.agent._on_query_containers(q)
            self.assertTrue(entered.wait(1))
            self.assertTrue(h.query(BASE + "/state")["ok"], "Docker never blocks state or jobs")
            refused = h.query(BASE + "/docker/containers")
            self.assertFalse(refused["ok"])
            self.assertIn("busy", refused["error"])
            release.set()
            self.assertTrue(complete.wait(1))
            self.assertTrue(q.last["ok"], "read-only permits log reads")
        finally:
            release.set()
            h.agent._docker_slots.release()
            h.agent.close()

    def test_invalid_query_never_runs_docker(self):
        h = Harness()
        h.agent.poll_once()
        h.agent._docker_logs.logs = Mock()
        reply = h.query(BASE + "/docker/logs", json.dumps({"container_id": "--follow"}).encode())
        self.assertFalse(reply["ok"])
        h.agent._docker_logs.logs.assert_not_called()
        h.agent.close()


if __name__ == "__main__":
    unittest.main()
