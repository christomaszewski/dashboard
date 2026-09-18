"""Run with the pinned Lyrical Python environment: python3 -m unittest discover -s tools -p 'test_ros3d_replay.py'."""
import argparse
import tempfile
import unittest
from pathlib import Path
import rclpy
from rosbag2_interfaces.srv import Seek, SetRate, Pause
from ros3d_fixture import write_bag
from ros3d_replay import Replay, TfIndex, NS


class ReplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rclpy.init()
        cls.temp = tempfile.TemporaryDirectory(prefix="ros3d-test-")
        cls.bag = str(Path(cls.temp.name) / "bag")
        write_bag(Path(cls.bag), 2, 10, 16)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()
        rclpy.shutdown()

    def test_index_restores_statics_and_brackets_acquisition_time(self):
        index = TfIndex(self.bag, ["/tf"], ["/tf_static"])
        try:
            static, dynamic = index.snapshot(1000 * NS + 550_000_000, 1000 * NS + 550_000_000)
            self.assertEqual({tf["child_frame_id"] for tf in static}, {"odom", "test_ouster"})
            self.assertEqual([tf["header"]["stamp"]["nanosec"] for tf in dynamic], [500_000_000, 600_000_000])
            self.assertEqual(index.snapshot(999 * NS, 999 * NS)[0], [])
        finally:
            index.close()

    def test_paused_seek_rate_and_loop(self):
        args = argparse.Namespace(bag=self.bag, points=None, tf=["/tf"], tf_static=["/tf_static"],
                                  state_topic="/test/replay_state", start_paused=True, rate=1.0, loop=True)
        node = Replay(args)
        try:
            request = Seek.Request()
            request.time.sec, request.time.nanosec = 1001, 50_000_000
            response = node.seek(request, Seek.Response())
            self.assertTrue(response.success)
            self.assertTrue(node.paused)
            self.assertEqual(node.position, 1001 * NS + 100_000_000)
            self.assertEqual(node.epoch, 2)
            request.time.sec = 999
            self.assertFalse(node.seek(request, Seek.Response()).success)
            self.assertEqual(node.position, 1001 * NS + 100_000_000)
            rate = SetRate.Request(rate=2.0)
            self.assertTrue(node.set_rate(rate, SetRate.Response()).success)
            rate.rate = float("nan")
            self.assertFalse(node.set_rate(rate, SetRate.Response()).success)
            node.paused = False
            node.anchor -= 10
            node.tick()
            self.assertEqual(node.epoch, 3)
            self.assertEqual(node.position, 1000 * NS)
            node.pause(Pause.Request(), Pause.Response())
            self.assertTrue(node.paused)
            self.assertEqual(node.epoch, 3)  # refreshing the late-join snapshot must preserve existing histories
        finally:
            node.destroy_node()


if __name__ == "__main__":
    unittest.main()
