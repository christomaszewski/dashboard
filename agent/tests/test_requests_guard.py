import json
import unittest

from helpers import tmpdir  # noqa: F401  (sys.path)

from rig_agent.guard import classify_rig_error, error_message
from rig_agent.requests import (DOWN_END_RUN_TIMEOUT_S, default_timeout, parse_submit, self_terminating,
                                verb_argv)

ROWS = ["zenoh-router", "dashboard", "lidar", "cam_front", "bag_player"]
TRIO = ["lidar"]


def _parse(doc=None, params="", **kw):
    payload = json.dumps(doc).encode() if doc is not None else None
    return parse_submit(payload, params, known_names=ROWS, state_verb_names=TRIO, **kw)


class SubmitParseTests(unittest.TestCase):
    def test_minimal_and_defaults(self):
        req, err = _parse({"verb": "standby", "names": ["lidar"]})
        self.assertIsNone(err)
        self.assertEqual((req.verb, req.names, req.force, req.end_run, req.label), ("standby", ("lidar",), False, False, None))
        self.assertEqual(req.timeout_s, 300)
        self.assertEqual(req.args(), {"names": ["lidar"], "force": False})
        req, _ = _parse({"verb": "down", "end_run": True, "client": "dashboard 10.0.0.5"})
        self.assertEqual(req.timeout_s, DOWN_END_RUN_TIMEOUT_S)
        self.assertEqual(req.client, "dashboard 10.0.0.5")
        self.assertEqual(req.args(), {"names": [], "force": False, "end_run": True})

    def test_selector_parameters_form(self):
        req, err = _parse(params="verb=activate;names=lidar,lidar;force=0")
        self.assertIsNone(err)
        self.assertEqual(req.names, ("lidar",), "de-duplicated")
        req, err = _parse(params="verb=new-run&label=flight1&force=1")
        self.assertIsNone(err)
        self.assertEqual((req.label, req.force), ("flight1", True))

    def test_refusals(self):
        cases = [
            (b"{nope", "", "request is not JSON"),
            (b"[1]", "", "request must be a JSON object"),
            (b"{}", "", "missing 'verb'"),
            (json.dumps({"verb": "reboot"}).encode(), "", "unknown verb 'reboot'"),
            (json.dumps({"verb": "up", "names": "cam_front"}).encode(), "", None),   # string form is accepted
            (json.dumps({"verb": "up", "names": [1]}).encode(), "", "'names' must be a list"),
            (json.dumps({"verb": "up", "names": ["cam_x"]}).encode(), "", "unknown row 'cam_x' (rows: zenoh-router, dashboard, lidar, cam_front, bag_player)"),
            (json.dumps({"verb": "new-run", "names": ["cam_front"]}).encode(), "", "'names' is not accepted for new-run/end-run"),
            (json.dumps({"verb": "standby", "names": ["cam_front"]}).encode(), "", "standby/activate: 'cam_front' declares no state verbs"),
            (json.dumps({"verb": "up", "label": "x"}).encode(), "", "'label' is only accepted for new-run"),
            (json.dumps({"verb": "new-run", "label": "_bad"}).encode(), "", "'label' must match [A-Za-z0-9][A-Za-z0-9_-]*"),
            (json.dumps({"verb": "new-run", "label": "no spaces"}).encode(), "", "'label' must match"),
            (json.dumps({"verb": "standby", "force": True}).encode(), "", "'force' is not accepted for standby/activate"),
            (json.dumps({"verb": "end-run", "end_run": True}).encode(), "", "'end_run' is only accepted for down"),
            (json.dumps({"verb": "up", "force": "maybe"}).encode(), "", "'force' must be true or false"),
            (json.dumps({"verb": "up", "timeout_s": "soon"}).encode(), "", "'timeout_s' must be a number"),
        ]
        for payload, params, expected in cases:
            req, err = parse_submit(payload, params, known_names=ROWS, state_verb_names=TRIO)
            if expected is None:
                self.assertIsNone(err, payload)
            else:
                self.assertIsNotNone(err, payload)
                self.assertIn(expected, err)

    def test_timeout_clamp_and_numeric_label(self):
        self.assertEqual(_parse({"verb": "up", "timeout_s": 5})[0].timeout_s, 30)
        self.assertEqual(_parse({"verb": "up", "timeout_s": 99999})[0].timeout_s, 1800)
        self.assertEqual(_parse({"verb": "activate", "timeout_s": "120.5"})[0].timeout_s, 120)
        self.assertEqual(_parse({"verb": "new-run", "label": 123})[0].label, "123")
        self.assertEqual(default_timeout("down"), 300)
        self.assertEqual(default_timeout("down", end_run=True), 900)

    def test_verb_argv(self):
        self.assertEqual(verb_argv(_parse({"verb": "down", "end_run": True})[0]), ["down", "--end-run"])
        self.assertEqual(verb_argv(_parse({"verb": "down", "names": ["cam_front", "lidar"], "force": True})[0]),
                         ["down", "cam_front", "lidar", "--force"])
        self.assertEqual(verb_argv(_parse({"verb": "new-run", "label": "flight1", "force": True})[0]),
                         ["new-run", "flight1", "--force"])
        self.assertEqual(verb_argv(_parse({"verb": "new-run"})[0]), ["new-run"])
        self.assertEqual(verb_argv(_parse({"verb": "end-run", "force": True})[0]), ["end-run", "--force"])
        self.assertEqual(verb_argv(_parse({"verb": "end-run"})[0]), ["end-run"])
        self.assertEqual(verb_argv(_parse({"verb": "standby", "names": ["lidar"]})[0]), ["standby", "lidar"])
        self.assertEqual(verb_argv(_parse({"verb": "activate"})[0]), ["activate"])
        self.assertEqual(verb_argv(_parse({"verb": "up", "names": ["cam_front"]})[0]), ["up", "cam_front"])

    def test_self_terminating(self):
        self.assertTrue(self_terminating(_parse({"verb": "down"})[0], "dashboard"))
        self.assertTrue(self_terminating(_parse({"verb": "down", "names": ["cam_front"], "end_run": True})[0], "dashboard"))
        self.assertTrue(self_terminating(_parse({"verb": "down", "names": ["dashboard"]})[0], "dashboard"))
        self.assertFalse(self_terminating(_parse({"verb": "down", "names": ["cam_front"]})[0], "dashboard"))
        self.assertFalse(self_terminating(_parse({"verb": "down", "names": ["cam_front"]})[0], None))
        self.assertFalse(self_terminating(_parse({"verb": "end-run"})[0], "dashboard"))
        self.assertFalse(self_terminating(_parse({"verb": "up"})[0], "dashboard"))


class GuardTests(unittest.TestCase):
    RUNNING = ("rig: new-run: stacks are running (cam_front-vehicle-1, dashboard-vehicle-1) — a running "
               "recording belongs to the run it started in. `rig down` first, or --force to accept late "
               "writes landing in the sealed run\n")

    def test_classification_on_rigs_real_messages(self):
        self.assertEqual(classify_rig_error(1, self.RUNNING), ("guard-running", ["cam_front-vehicle-1", "dashboard-vehicle-1"]))
        self.assertEqual(classify_rig_error(1, "rig: end-run: `docker compose ls` timed out — cannot tell whether stacks are running — retry, or --force to rotate anyway (late writes would land in the sealed run)\n"),
                         ("guard-cannot-tell", []))
        self.assertEqual(classify_rig_error(1, "rig: new-run: label 'bad label' must match [A-Za-z0-9][A-Za-z0-9_-]* (it becomes a directory name)\n"),
                         ("bad-label", []))
        self.assertEqual(classify_rig_error(1, "rig: runs need `data_dir` in vehicle.yaml (the host dir the registry lives under)\n"),
                         ("no-data-dir", []))
        self.assertEqual(classify_rig_error(0, "rig: no active run\n"), (None, []))
        self.assertEqual(classify_rig_error(1, "rig: unknown sensor(s): cam_x\n"), ("other", []))
        self.assertEqual(classify_rig_error(None, "", timed_out=True), ("timeout", []))

    def test_error_message_prefers_the_rig_line(self):
        self.assertTrue(error_message("==> cam_front [camera-service]: down\n" + self.RUNNING).startswith("new-run: stacks are running"))
        self.assertEqual(error_message("something else happened\n"), "something else happened")
        self.assertEqual(error_message("", "stdout only\n"), "stdout only")
        self.assertIsNone(error_message("", ""))


if __name__ == "__main__":
    unittest.main()
