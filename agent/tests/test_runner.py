import subprocess
import unittest
from pathlib import Path

from helpers import make_config, make_tree, result, scripted_run_rig, tmpdir

from rig_agent.jobs import Job, JobStore
from rig_agent.runner import DockerRunner, RunnerError, container_name, docker_run_argv, run_job, run_result


def _job(argv, timeout_s=300, **kw) -> Job:
    base = dict(job_id="j-20260902T140000Z-0001", verb=argv[0], args={}, argv=list(argv), client="t",
                self_terminating=False, timeout_s=timeout_s, submitted_unix_s=1.0, runner={"kind": "fake"})
    base.update(kw)
    return Job(**base)


class DockerArgvTests(unittest.TestCase):
    def setUp(self):
        self.root = make_tree(tmpdir())
        self.cfg = make_config(self.root, RIG_AGENT_RUNNER="docker", RIG_AGENT_USER="1000:1000",
                               RIG_AGENT_GROUPS="999", RIG_AGENT_IMAGE="reg/dashboard-rig-agent:v1",
                               RIG_VEHICLE_LOCAL_HOST="/etc/rig/vehicle.local.yaml")

    def test_identity_mounts_no_compose_labels_and_the_command(self):
        argv = docker_run_argv(self.cfg, _job(["down", "--end-run"]), "1")
        text = " ".join(argv)
        self.assertEqual(argv[:4], ["docker", "run", "-d", "--name"])
        self.assertEqual(argv[4], container_name("j-20260902T140000Z-0001"))
        self.assertIn("--label dashboard.rig-agent.job=j-20260902T140000Z-0001", text)
        self.assertIn("--label dashboard.rig-agent.vehicle=1", text)
        self.assertNotIn("com.docker.compose", text, "no compose labels: compose down must never see it")
        self.assertIn("--network host", text)
        self.assertIn("--user 1000:1000", text)
        self.assertIn("--group-add 999", text)
        ws = self.root.parent
        self.assertIn(f"-v {ws}:{ws}:ro", text, "the whole workspace, read-only, at its host path")
        self.assertIn(f"-v {self.root / 'var'}:{self.root / 'var'}", text)
        data = self.cfg.data_dir
        self.assertIn(f"-v {data}:{data}", text)
        self.assertIn("-v /etc/rig/vehicle.local.yaml:/etc/rig/vehicle.local.yaml:ro", text)
        self.assertIn("-v /var/run/docker.sock:/var/run/docker.sock", text)
        self.assertNotIn(f"-v {self.cfg.state_dir}:", text, "the state dir lives under var/ — already mounted")
        self.assertIn(f"-e RIG_ROOT={self.root}", text)
        self.assertIn(f"-e RIG_AGENT_STATE_DIR={self.cfg.state_dir}", text)
        self.assertIn(f"-e HOME={self.cfg.state_dir / 'home'}", text)
        self.assertEqual(argv[-7:], ["--entrypoint", "python3", "reg/dashboard-rig-agent:v1", "-m", "rig_agent",
                                     "run-job", "j-20260902T140000Z-0001"])

    def test_optional_pieces(self):
        cfg = make_config(self.root, RIG_AGENT_RUNNER="docker", RIG_DATA_DIR="",
                          RIG_AGENT_STATE_DIR="/var/lib/rig-agent")
        text = " ".join(docker_run_argv(cfg, _job(["up"]), "1"))
        self.assertNotIn("--user", text)
        self.assertNotIn(":/etc/rig/vehicle.local.yaml:ro", text, "no host file → no identity mount")
        self.assertIn("-v /var/lib/rig-agent:/var/lib/rig-agent", text, "a state dir outside var/ gets its own mount")


class _Proc:
    def __init__(self, rc=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = rc, stdout, stderr


class DockerRunnerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.replies = {}

        def run(argv, **kw):
            self.calls.append(argv)
            return self.replies.get(argv[1], _Proc())

        self.runner = DockerRunner(make_config(make_tree(tmpdir()), RIG_AGENT_RUNNER="docker"), "1", run=run)

    def test_spawn_poll_stop_cleanup(self):
        self.replies["run"] = _Proc(0, "abcdef0123456789\n")
        info = self.runner.spawn(_job(["up"]))
        self.assertEqual(info, {"kind": "docker", "container": "rig-agent-job-j-20260902T140000Z-0001", "id": "abcdef012345"})
        self.replies["inspect"] = _Proc(0, "true 0\n")
        self.assertEqual(self.runner.poll(info), (True, None))
        self.replies["inspect"] = _Proc(0, "false 3\n")
        self.assertEqual(self.runner.poll(info), (False, 3))
        self.replies["inspect"] = _Proc(1, "", "No such object")
        self.assertEqual(self.runner.poll(info), (False, None))
        self.runner.stop(info)
        self.assertEqual(self.calls[-1][:4], ["docker", "stop", "-t", "15"])
        self.runner.cleanup(info)
        self.assertEqual(self.calls[-1], ["docker", "rm", "-f", info["container"]])

    def test_spawn_failure(self):
        self.replies["run"] = _Proc(125, "", "docker: image not found")
        with self.assertRaises(RunnerError):
            self.runner.spawn(_job(["up"]))

    def test_sweep(self):
        self.replies["ps"] = _Proc(0, "rig-agent-job-j-1\tj-1\trunning\nrig-agent-job-j-0\tj-0\texited\nweird line\n")
        self.assertEqual(self.runner.sweep(), [
            {"job_id": "j-1", "info": {"kind": "docker", "container": "rig-agent-job-j-1"}, "running": True},
            {"job_id": "j-0", "info": {"kind": "docker", "container": "rig-agent-job-j-0"}, "running": False}])
        self.assertIn("label=dashboard.rig-agent.vehicle=1", self.calls[-1])


class RunJobTests(unittest.TestCase):
    def setUp(self):
        self.root = make_tree(tmpdir())
        self.cfg = make_config(self.root)
        self.store = JobStore(self.cfg.state_dir)
        self.data = self.cfg.data_dir
        (self.data / "runs").mkdir()

    def _open_run(self, run_id):
        d = self.data / "runs" / run_id
        d.mkdir()
        (d / "manifest.yaml").write_text(f"run: {run_id}\nlabel: {run_id.split('_', 1)[1]}\n")
        cur = self.data / "current"
        if cur.is_symlink():
            cur.unlink()
        cur.symlink_to(Path("runs") / run_id)

    def test_success_reads_the_registry_for_the_result(self):
        self._open_run("20260901T100000Z_old")

        def script(args):
            self.assertEqual(args, ["new-run", "flight1"])
            (self.data / "runs" / "20260901T100000Z_old" / "manifest.yaml").write_text("run: x\nended: now\n")
            self._open_run("20260902T140000Z_flight1")
            return result(args, stderr="rig: sealed run 20260901T100000Z_old\nrig: opened run 20260902T140000Z_flight1\n")

        job = _job(["new-run", "flight1"])
        self.store.save(job)
        rc = run_job(self.cfg, self.store, job.job_id, run_rig=scripted_run_rig(script), install_signals=False)
        self.assertEqual(rc, 0)
        rec = self.store.load(job.job_id)
        self.assertEqual(rec.state, "succeeded")
        self.assertEqual(rec.exit_code, 0)
        self.assertEqual(rec.result, {"run_before": "20260901T100000Z_old", "run_after": "20260902T140000Z_flight1",
                                      "sealed": "20260901T100000Z_old", "opened": "20260902T140000Z_flight1"})
        self.assertEqual(rec.log_tail, ["rig: sealed run 20260901T100000Z_old", "rig: opened run 20260902T140000Z_flight1"])
        self.assertEqual(self.store.log_path(job.job_id).read_text().splitlines(), rec.log_tail)
        self.assertIsNotNone(rec.started_unix_s)
        self.assertIsNotNone(rec.ended_unix_s)
        self.assertEqual(rec.deadline_unix_s, rec.started_unix_s + 300)
        self.assertIn("pid", rec.runner)

    def test_guard_refusal_is_classified_verbatim(self):
        self._open_run("20260902T140000Z_flight1")
        msg = ("rig: end-run: stacks are running (cam_front-vehicle-1, dashboard-vehicle-1) — a running recording "
               "belongs to the run it started in. `rig down` first, or --force to accept late writes landing in the sealed run\n")
        job = _job(["end-run"])
        self.store.save(job)
        rc = run_job(self.cfg, self.store, job.job_id, run_rig=scripted_run_rig(lambda a: result(a, rc=1, stderr=msg)),
                     install_signals=False)
        self.assertEqual(rc, 1)
        rec = self.store.load(job.job_id)
        self.assertEqual(rec.state, "failed")
        self.assertEqual(rec.error_kind, "guard-running")
        self.assertEqual(rec.guard_projects, ["cam_front-vehicle-1", "dashboard-vehicle-1"])
        self.assertTrue(rec.error.startswith("end-run: stacks are running"))
        self.assertEqual(rec.result["sealed"], None)
        self.assertEqual(rec.result["run_after"], "20260902T140000Z_flight1")

    def test_timeout_and_stop(self):
        job = _job(["activate"], timeout_s=30)
        self.store.save(job)
        run_job(self.cfg, self.store, job.job_id, run_rig=scripted_run_rig(lambda a: result(a, rc=None, timed_out=True)),
                install_signals=False)
        rec = self.store.load(job.job_id)
        self.assertEqual((rec.state, rec.error_kind, rec.error), ("killed", "timeout", "timed out after 30 s"))
        job2 = _job(["activate"], job_id="j-20260902T140001Z-0002")
        self.store.save(job2)
        run_job(self.cfg, self.store, job2.job_id, run_rig=scripted_run_rig(lambda a: result(a, rc=-15, stopped=True)),
                install_signals=False)
        rec2 = self.store.load(job2.job_id)
        self.assertEqual((rec2.state, rec2.error_kind, rec2.error), ("killed", None, "stopped by the agent"))

    def test_missing_or_finished_records(self):
        self.assertEqual(run_job(self.cfg, self.store, "j-nope", run_rig=scripted_run_rig(lambda a: result(a)), install_signals=False), 2)
        done = _job(["up"], state="succeeded")
        self.store.save(done)
        self.assertEqual(run_job(self.cfg, self.store, done.job_id, run_rig=scripted_run_rig(lambda a: result(a)), install_signals=False), 0)

    def test_no_data_dir(self):
        cfg = make_config(self.root, RIG_DATA_DIR="")
        job = _job(["up"])
        self.store.save(job)
        run_job(cfg, self.store, job.job_id, run_rig=scripted_run_rig(lambda a: result(a)), install_signals=False)
        self.assertEqual(self.store.load(job.job_id).result, run_result(None, None))


class RealSubprocessTests(unittest.TestCase):
    """rigcmd.run_rig against a real child: python stands in for rig (the tree's rig_cli is a stub)."""

    def test_run_rig_captures_streams_and_times_out(self):
        from rig_agent import rigcmd
        root = make_tree(tmpdir())
        (root / "rig_cli" / "__main__.py").write_text(
            "import sys, time\n"
            "args = sys.argv[1:]\n"
            "if 'slow' in args:\n    time.sleep(30)\n"
            "print('out line'); print('err line', file=sys.stderr)\n"
            "sys.exit(3 if 'fail' in args else 0)\n")
        cfg = make_config(root)
        seen = []
        res = rigcmd.run_rig(cfg, ["status"], 10, on_line=seen.append)
        self.assertEqual((res.returncode, res.stdout.strip(), res.stderr.strip()), (0, "out line", "err line"))
        self.assertEqual(sorted(seen), ["err line", "out line"])
        self.assertTrue(res.ok)
        self.assertEqual(rigcmd.run_rig(cfg, ["fail"], 10).returncode, 3)
        slow = rigcmd.run_rig(cfg, ["slow"], 0.5)
        self.assertTrue(slow.timed_out)
        self.assertFalse(slow.ok)
        self.assertLess(slow.duration_s, 12)
        env = rigcmd.rig_env(cfg, {"RIG_VAR_x": "1", "RIG_TARGET_STATE": "standby", "PATH": "/bin", "PYTHONPATH": "/extra"})
        self.assertNotIn("RIG_VAR_x", env)
        self.assertNotIn("RIG_TARGET_STATE", env)
        self.assertEqual(env["PYTHONPATH"], f"{root}:/extra")
        self.assertIsNone(rigcmd.check(cfg))
        self.assertIn("no rig_cli/", rigcmd.check(make_config(make_tree(tmpdir(), rig=False))))


if __name__ == "__main__":
    unittest.main()
