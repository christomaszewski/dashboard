import unittest
from pathlib import Path

from helpers import make_config, make_tree, tmpdir  # noqa: F401  (sys.path)

from rig_agent import keys
from rig_agent.config import AgentConfig, ConfigError, split_endpoints


class ConfigTests(unittest.TestCase):
    def test_root_is_required_and_absolute(self):
        with self.assertRaises(ConfigError):
            AgentConfig.from_env({})
        with self.assertRaises(ConfigError):
            AgentConfig.from_env({"RIG_ROOT": "relative/tree"})

    def test_defaults(self):
        cfg = AgentConfig.from_env({"RIG_ROOT": "/srv/tree"})
        self.assertEqual(cfg.root, Path("/srv/tree"))
        self.assertIsNone(cfg.data_dir)
        self.assertEqual(cfg.mount, Path("/srv/tree"))
        self.assertEqual(cfg.connect, ("tcp/localhost:7447",))
        self.assertEqual(cfg.listen, ())
        self.assertEqual(cfg.poll_s, 10.0)
        self.assertTrue(cfg.actuate)
        self.assertEqual(cfg.runner, "docker")
        self.assertEqual(cfg.state_dir, Path("/srv/tree/var/dashboard-rig-agent"))
        self.assertEqual(str(cfg.vehicle_local), "/etc/rig/vehicle.local.yaml")
        self.assertIsNone(cfg.project)

    def test_overrides_and_validation(self):
        cfg = AgentConfig.from_env({
            "RIG_ROOT": "/srv/tree", "RIG_DATA_DIR": "/data", "RIG_MOUNT": "/srv", "ZENOH_CONNECT": "",
            "ZENOH_LISTEN": "tcp/0.0.0.0:7447", "RIG_AGENT_POLL_S": "1", "RIG_AGENT_ACTUATE": "0",
            "RIG_AGENT_RUNNER": "subprocess", "RIG_AGENT_USER": "1000:1000", "RIG_AGENT_GROUPS": "999, 27",
            "RIG_AGENT_PROJECT": "dashboard-vehicle-1", "RIG_VEHICLE_LOCAL_HOST": "/etc/rig/vehicle.local.yaml",
        })
        self.assertEqual(cfg.data_dir, Path("/data"))
        self.assertEqual(cfg.mount, Path("/srv"))
        self.assertEqual(cfg.connect, (), "explicitly empty = scout only")
        self.assertEqual(cfg.listen, ("tcp/0.0.0.0:7447",))
        self.assertEqual(cfg.poll_s, 2.0, "clamped to the minimum")
        self.assertFalse(cfg.actuate)
        self.assertEqual(cfg.groups, ("999", "27"))
        self.assertEqual(cfg.vehicle_local_host, Path("/etc/rig/vehicle.local.yaml"))
        with self.assertRaises(ConfigError):
            AgentConfig.from_env({"RIG_ROOT": "/srv/tree", "RIG_AGENT_RUNNER": "systemd"})
        with self.assertRaises(ConfigError):
            AgentConfig.from_env({"RIG_ROOT": "/srv/tree", "RIG_AGENT_POLL_S": "fast"})

    def test_runner_env_round_trips(self):
        cfg = AgentConfig.from_env({"RIG_ROOT": "/srv/tree", "RIG_DATA_DIR": "/data", "RIG_AGENT_PROJECT": "p"})
        again = AgentConfig.from_env(cfg.runner_env())
        self.assertEqual((again.root, again.data_dir, again.state_dir, again.project),
                         (cfg.root, cfg.data_dir, cfg.state_dir, cfg.project))

    def test_split_endpoints(self):
        self.assertEqual(split_endpoints(None, "tcp/a:1"), ("tcp/a:1",))
        self.assertEqual(split_endpoints("", "tcp/a:1"), ())
        self.assertEqual(split_endpoints(" tcp/a:1 ,tcp/b:2", None), ("tcp/a:1", "tcp/b:2"))


class KeyTests(unittest.TestCase):
    def test_keys(self):
        b = keys.key_base(1)
        self.assertEqual(b, "fleet/1/rig")
        self.assertEqual(keys.state_key(b), "fleet/1/rig/state")
        self.assertEqual(keys.run_pattern(b), "fleet/1/rig/run/*")
        self.assertEqual(keys.run_key(b, "20260902T1_x"), "fleet/1/rig/run/20260902T1_x")
        self.assertEqual(keys.submit_key(b), "fleet/1/rig/jobs/submit")
        self.assertEqual(keys.cancel_key(b), "fleet/1/rig/jobs/cancel")
        self.assertEqual(keys.events_key(b), "fleet/1/rig/jobs/events")
        self.assertEqual(keys.key_base(" v-7 "), "fleet/v-7/rig")
        for bad in ("", "a/b", "*"):
            with self.assertRaises(ValueError):
                keys.key_base(bad)

    def test_parse_run_key(self):
        b = "fleet/1/rig"
        self.assertEqual(keys.parse_run_key(b, "fleet/1/rig/run/20260902T143000Z_flight1"), "20260902T143000Z_flight1")
        self.assertIsNone(keys.parse_run_key(b, "fleet/1/rig/run/"))
        self.assertIsNone(keys.parse_run_key(b, "fleet/1/rig/run/a/b"))
        self.assertIsNone(keys.parse_run_key(b, "fleet/1/rig/runs"))


if __name__ == "__main__":
    unittest.main()
