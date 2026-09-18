import json
import unittest

from helpers import tmpdir

from rig_agent.jobs import Job, JobStore, new_job_id, tail_lines


def _job(job_id="j-20260902T140000Z-0001", **kw) -> Job:
    base = dict(job_id=job_id, verb="standby", args={"names": ["lidar"], "force": False}, argv=["standby", "lidar"],
                client="test", self_terminating=False, timeout_s=300, submitted_unix_s=1.0)
    base.update(kw)
    return Job(**base)


class JobTests(unittest.TestCase):
    def test_ids_sort_by_time(self):
        a, b = new_job_id(1_700_000_000), new_job_id(1_700_000_100)
        self.assertTrue(a.startswith("j-2023") and a < b)

    def test_record_round_trip_and_tolerance(self):
        job = _job(state="failed", error="x", error_kind="other", guard_projects=["p"], log_tail=["l1"],
                   result={"sealed": None}, runner={"kind": "docker", "container": "c"})
        doc = job.to_json()
        self.assertEqual(doc["schema_version"], 1)
        again = Job.from_json(json.loads(json.dumps(doc)))
        self.assertEqual(again, job)
        # unknown fields are ignored, missing optionals default, an unknown state reads as failed
        loose = Job.from_json({"job_id": "j-1", "verb": "up", "state": "weird", "future": 1})
        self.assertEqual((loose.state, loose.args, loose.argv, loose.timeout_s), ("failed", {}, [], 0))
        with self.assertRaises(ValueError):
            Job.from_json({"verb": "up"})
        self.assertTrue(_job(state="cancelled").terminal)
        self.assertFalse(_job(state="running").terminal)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = JobStore(tmpdir() / "state", keep=3)

    def test_save_load_list_running(self):
        self.assertEqual(self.store.list(), [])
        self.assertIsNone(self.store.running())
        for i, state in enumerate(["succeeded", "running", "queued"]):
            self.store.save(_job(f"j-20260902T14000{i}Z-aaaa", state=state))
        ids = [j.job_id for j in self.store.list()]
        self.assertEqual(ids, ["j-20260902T140002Z-aaaa", "j-20260902T140001Z-aaaa", "j-20260902T140000Z-aaaa"], "newest first")
        self.assertEqual(self.store.running().job_id, "j-20260902T140002Z-aaaa")
        self.assertIsNone(self.store.load("j-nope"))
        self.assertFalse(self.store.path("j-x").with_suffix(".json.tmp").exists(), "atomic write leaves no temp file")

    def test_corrupt_record_is_skipped(self):
        self.store.save(_job())
        self.store.path("j-20260902T140001Z-bbbb").write_text("{not json")
        self.assertEqual([j.job_id for j in self.store.list()], ["j-20260902T140000Z-0001"])

    def test_sweep_keeps_the_newest_and_never_a_live_job(self):
        for i in range(6):
            self.store.save(_job(f"j-20260902T14000{i}Z-aaaa", state="running" if i == 0 else "succeeded"))
            self.store.log_path(f"j-20260902T14000{i}Z-aaaa").write_text("log\n")
        removed = self.store.sweep()
        self.assertEqual(removed, 2, "6 records, keep 3: the 3 oldest are candidates, the running one stays")
        left = [j.job_id for j in self.store.list()]
        self.assertEqual(left, ["j-20260902T140005Z-aaaa", "j-20260902T140004Z-aaaa", "j-20260902T140003Z-aaaa",
                                "j-20260902T140000Z-aaaa"])
        self.assertFalse(self.store.log_path("j-20260902T140001Z-aaaa").exists(), "logs go with the record")


class TailTests(unittest.TestCase):
    def test_tail_lines(self):
        p = tmpdir() / "x.log"
        self.assertEqual(tail_lines(p), [])
        p.write_text("".join(f"line {i}\n" for i in range(100)))
        self.assertEqual(tail_lines(p, 3), ["line 97", "line 98", "line 99"])
        big = "".join(f"row {i:06d}\n" for i in range(60_000))   # > 256 KiB
        p.write_text(big)
        tail = tail_lines(p, 2)
        self.assertEqual(tail, ["row 059998", "row 059999"])


if __name__ == "__main__":
    unittest.main()
