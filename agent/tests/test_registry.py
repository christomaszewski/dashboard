import os
import unittest
from pathlib import Path

from helpers import tmpdir

from rig_agent import registry


def _run(data: Path, run_id: str, manifest: str | None) -> Path:
    d = data / "runs" / run_id
    d.mkdir(parents=True)
    if manifest is not None:
        (d / "manifest.yaml").write_text(manifest)
    return d


def _point_current(data: Path, run_id: str) -> None:
    cur = data / "current"
    if cur.is_symlink() or cur.exists():
        cur.unlink()
    cur.symlink_to(Path("runs") / run_id)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.data = tmpdir() / "logs"
        self.data.mkdir()

    def test_empty_registry(self):
        self.assertIsNone(registry.current_run(self.data))
        self.assertEqual(registry.list_runs(self.data), ([], None))
        self.assertEqual(registry.current_run_id(self.data), (None, None))

    def test_states(self):
        _run(self.data, "20260901T100000Z_old", "run: 20260901T100000Z_old\nlabel: old\nstarted: '2026-09-01T10:00:00+00:00'\nended: '2026-09-01T11:00:00+00:00'\ndisk_kb: 4711\n")
        _run(self.data, "20260901T120000Z_crashed", "run: 20260901T120000Z_crashed\nstarted: '2026-09-01T12:00:00+00:00'\n")
        _run(self.data, "20260901T130000Z_bad", "run: [unterminated\n")
        _run(self.data, "20260902T140000Z_flight1", "run: 20260902T140000Z_flight1\nlabel: flight1\nstarted: '2026-09-02T14:00:00+00:00'\nstacks: [zenoh-router, cam_front]\nconfig: ab12cd34ef56\nreplay: {of: 20260901T100000Z_old}\n")
        (self.data / "runs" / "20260901T090000Z_gone").symlink_to("/nonexistent/archive")
        _point_current(self.data, "20260902T140000Z_flight1")

        cur = registry.current_run(self.data)
        self.assertEqual(cur.id, "20260902T140000Z_flight1")
        self.assertEqual(registry.open_run_summary(cur), {
            "id": "20260902T140000Z_flight1", "label": "flight1", "started": "2026-09-02T14:00:00+00:00",
            "stacks": ["zenoh-router", "cam_front"], "config": "ab12cd34ef56", "corrupt": False})

        rows, problem = registry.list_runs(self.data)
        self.assertIsNone(problem)
        states = {r.run: r.state for r in rows}
        self.assertEqual(states, {
            "20260901T090000Z_gone": "dangling", "20260901T100000Z_old": "sealed",
            "20260901T120000Z_crashed": "interrupted", "20260901T130000Z_bad": "corrupt",
            "20260902T140000Z_flight1": "OPEN"})
        by = {r.run: r for r in rows}
        self.assertEqual(by["20260901T100000Z_old"].disk_kb, 4711)
        self.assertEqual(by["20260901T100000Z_old"].label, "old")
        self.assertIsNone(by["20260901T120000Z_crashed"].label)
        self.assertEqual(by["20260902T140000Z_flight1"].replay_of, "20260901T100000Z_old")
        self.assertTrue(by["20260901T090000Z_gone"].linked)
        self.assertEqual(registry.run_state(self.data, "20260901T130000Z_bad"), "corrupt")
        self.assertEqual(registry.run_manifest(self.data, "20260901T130000Z_bad"), {"run": "20260901T130000Z_bad", "corrupt": True})
        self.assertEqual(registry.run_manifest(self.data, "20260901T100000Z_old")["label"], "old")

    def test_corrupt_open_run_still_reads_as_open(self):
        _run(self.data, "20260902T140000Z_x", "run: [\n")
        _point_current(self.data, "20260902T140000Z_x")
        cur = registry.current_run(self.data)
        self.assertTrue(cur.manifest.get("corrupt"))
        self.assertEqual(registry.list_runs(self.data)[0][0].state, "OPEN")

    def test_dangling_current_reads_as_none(self):
        (self.data / "current").symlink_to(Path("runs") / "20260902T140000Z_gone")
        self.assertIsNone(registry.current_run(self.data))

    def test_current_must_be_a_symlink_inside_the_registry(self):
        (self.data / "current").mkdir()
        with self.assertRaises(registry.RegistryError):
            registry.current_run(self.data)
        _, problem = registry.current_run_id(self.data)
        self.assertIn("not a symlink", problem)
        (self.data / "current").rmdir()
        outside = tmpdir()
        (self.data / "current").symlink_to(outside)
        with self.assertRaises(registry.RegistryError):
            registry.current_run(self.data)
        rows, problem = registry.list_runs(self.data)
        self.assertIn("outside the registry", problem)

    def test_run_dir_rejects_path_tricks(self):
        _run(self.data, "20260902T140000Z_x", "run: x\n")
        self.assertIsNotNone(registry.run_dir(self.data, "20260902T140000Z_x"))
        for bad in ("", "..", "../runs", "a/b", ".hidden", "nope"):
            self.assertIsNone(registry.run_dir(self.data, bad), bad)
        self.assertIsNone(registry.run_manifest(self.data, "nope"))

    def test_signature_tracks_the_open_run_and_registry_entries(self):
        s0 = registry.signature(self.data)
        _run(self.data, "20260902T140000Z_x", "run: x\n")
        s1 = registry.signature(self.data)
        self.assertNotEqual(s0, s1, "a new entry changes the runs/ mtime")
        _point_current(self.data, "20260902T140000Z_x")
        s2 = registry.signature(self.data)
        self.assertNotEqual(s1, s2)
        self.assertEqual(s2[0], os.path.join("runs", "20260902T140000Z_x"))
        m = self.data / "runs" / "20260902T140000Z_x" / "manifest.yaml"
        m.write_text("run: x\nended: now\n")
        os.utime(m, ns=(m.stat().st_atime_ns, m.stat().st_mtime_ns + 5_000_000))
        self.assertNotEqual(s2, registry.signature(self.data), "sealing rewrites the manifest")

    def test_disk_helpers_are_best_effort(self):
        self.assertIsInstance(registry.free_kb(self.data), int)
        self.assertIsNone(registry.free_kb(self.data / "missing"))
        _run(self.data, "20260902T140000Z_x", "run: x\n")
        self.assertIsInstance(registry.du_kb(self.data / "runs" / "20260902T140000Z_x"), int)
        self.assertIsNone(registry.du_kb(self.data / "missing"))


if __name__ == "__main__":
    unittest.main()
