import json
import unittest

from helpers import STATUS_JSON, make_tree, tmpdir

from rig_agent import snapshot
from rig_agent.status import StatusError, parse_status_json
from rig_agent.vehicle import (VehicleError, project_name, read_state_verb_services, read_vehicle_rows,
                               self_instance)


class StatusParseTests(unittest.TestCase):
    def test_real_shape(self):
        doc = parse_status_json(json.dumps(STATUS_JSON))
        self.assertEqual((doc.vehicle, doc.vehicle_id, doc.run_line), ("orin-dev", "1", None))
        self.assertEqual([s.sensor for s in doc.stacks], ["zenoh-router", "dashboard", "cam_front", "lidar"])
        down = doc.stacks[1]
        self.assertEqual((down.state, down.health, down.op_state, down.running, down.total), ("down", "-", None, 0, 0))
        self.assertEqual(doc.stacks[3].op_state, "standby")

    def test_older_rig_without_op_state_and_string_ids(self):
        doc = parse_status_json(json.dumps({"vehicle": "v", "vehicle_id": "veh-7", "run": "OPEN 2026… (x)",
                                            "stacks": [{"sensor": "a", "service": "b", "state": "running",
                                                        "health": "healthy", "running": 1, "total": 1}]}))
        self.assertEqual(doc.vehicle_id, "veh-7")
        self.assertEqual(doc.run_line, "OPEN 2026… (x)")
        self.assertIsNone(doc.stacks[0].op_state)

    def test_rejects_garbage(self):
        for text in ("", "nope", "[]", json.dumps({"vehicle": "v"}),
                     json.dumps({"vehicle": "v", "vehicle_id": 1, "stacks": [{"sensor": "a"}]}),
                     json.dumps({"vehicle": "v", "vehicle_id": True, "stacks": []})):
            with self.assertRaises(StatusError, msg=text):
                parse_status_json(text)


class VehicleTests(unittest.TestCase):
    def setUp(self):
        self.root = make_tree(tmpdir())

    def test_rows_in_rig_order_with_defaults(self):
        rows = read_vehicle_rows(self.root)
        self.assertEqual([r.name for r in rows], ["zenoh-router", "dashboard", "lidar", "cam_front", "bag_player"],
                         "infra → sensors (by order: lidar 20 < cam_front 30) → autonomy; templated name dropped")
        by = {r.name: r for r in rows}
        self.assertEqual(by["bag_player"].enabled, False)
        self.assertEqual(by["bag_player"].order, 10, "(index+1)*10 default")
        self.assertEqual(by["cam_front"].tier, "sensor")
        self.assertEqual(by["zenoh-router"].tier, "infra")

    def test_unreadable_tree(self):
        (self.root / "vehicle.yaml").write_text("infra: [\n")
        with self.assertRaises(VehicleError):
            read_vehicle_rows(self.root)

    def test_trio_detection_all_three_or_none(self):
        self.assertEqual(read_state_verb_services(self.root), {"ouster"},
                         "camera-service declares no trio; novatel's partial claim does not count; missing repos skip")

    def test_project_and_self(self):
        self.assertEqual(project_name("dashboard", 1), "dashboard-vehicle-1")
        self.assertEqual(project_name("dashboard", None), "dashboard")
        rows = read_vehicle_rows(self.root)
        self.assertEqual(self_instance(rows, "1", "dashboard-vehicle-1"), "dashboard")
        self.assertIsNone(self_instance(rows, "1", "other-vehicle-1"))
        self.assertIsNone(self_instance(rows, "1", None))


class SnapshotTests(unittest.TestCase):
    def test_build_stacks_merges_rows_and_status(self):
        root = make_tree(tmpdir())
        rows = read_vehicle_rows(root)
        status = parse_status_json(json.dumps(STATUS_JSON))
        stacks = snapshot.build_stacks(status, rows, {"ouster"}, "1", "dashboard")
        names = [s["name"] for s in stacks]
        self.assertEqual(names, ["zenoh-router", "dashboard", "lidar", "cam_front", "bag_player"])
        by = {s["name"]: s for s in stacks}
        self.assertEqual(by["bag_player"]["state"], "down", "disabled rows are absent from rig status")
        self.assertEqual(by["bag_player"]["health"], "n/a")
        self.assertFalse(by["bag_player"]["enabled"])
        self.assertTrue(by["dashboard"]["self"])
        self.assertEqual(by["dashboard"]["project"], "dashboard-vehicle-1")
        self.assertTrue(by["lidar"]["state_verbs"])
        self.assertFalse(by["cam_front"]["state_verbs"])
        self.assertEqual(by["lidar"]["op_state"], "standby")
        self.assertEqual(by["cam_front"]["health"], "healthy")

    def test_build_stacks_keeps_status_rows_the_raw_read_dropped(self):
        status = parse_status_json(json.dumps({"vehicle": "v", "vehicle_id": 1, "run": None, "stacks": [
            {"sensor": "orin-dev_gps", "service": "novatel", "state": "running", "health": "n/a", "running": 1, "total": 1}]}))
        stacks = snapshot.build_stacks(status, [], set(), "1", None)
        self.assertEqual(stacks[0]["name"], "orin-dev_gps")
        self.assertEqual(stacks[0]["state"], "running")

    def test_state_changed_ignores_timestamps_disk_and_job(self):
        a = snapshot.build_state(vehicle="v", vehicle_id="1", at_unix_s=1.0, ok=True, error=None, rig_version="x",
                                 run={"id": "r", "disk_kb": 10}, registry={"data_dir": "/d", "free_kb": 5, "problem": None},
                                 stacks=[{"name": "a", "state": "running"}])
        b = {**a, "at_unix_s": 2.0, "run": {"id": "r", "disk_kb": 99}, "registry": {**a["registry"], "free_kb": 1}, "job": {"x": 1}}
        self.assertFalse(snapshot.state_changed(a, b))
        c = {**b, "stacks": [{"name": "a", "state": "down"}]}
        self.assertTrue(snapshot.state_changed(a, c))
        self.assertTrue(snapshot.state_changed(None, a))
        self.assertFalse(snapshot.state_changed(None, None))


if __name__ == "__main__":
    unittest.main()
