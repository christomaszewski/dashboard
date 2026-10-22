"""Launcher contract regressions; no pull/build/start or running Docker daemon needed.

Run: python3 tools/test_runtime_image_contract.py
When Docker Compose is installed, two tests also resolve the real deployment files through
`compose config`; a wrapper refuses every Docker operation except config/version and captures
the final pinned-up model instead of starting it. All files written belong to temporary trees.
"""
from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import runtime_images as ri

REPO = Path(__file__).resolve().parents[1]
DOCKER = shutil.which("docker")
ID_A, ID_B, ID_C = ("sha256:" + character * 64 for character in "abc")
BASE_IMAGES = ["dashboard-web:local", "dashboard-zenoh:local"]


def model():
    return {"name": "dash-vehicle-123", "services": {
        "dashboard-web": {"image": BASE_IMAGES[0], "build": {"context": "/src"},
                          "environment": {"DOLLARS": "$${literal}"},
                          "volumes": [{"type": "bind", "source": "/data/dash.yaml",
                                       "target": "/config/dashboard.yaml", "read_only": True}]},
        "dashboard-zenoh": {"image": BASE_IMAGES[1], "build": {"context": "/src/deploy"}},
    }}


def pins(images=BASE_IMAGES):
    return json.dumps({"version": 1, "images": dict(zip(images, (ID_A, ID_B, ID_C)))})


class HelperTests(unittest.TestCase):
    def test_native_platform_and_foreign_override(self):
        self.assertEqual(ri.native_platform({"RIG_TARGET_ARCH": "arm64"}, "linux/arm64/v8"), "linux/arm64")
        self.assertEqual(ri.native_platform({"RIG_TARGET_ARCH": "amd64"}), "linux/amd64")
        self.assertIsNone(ri.native_platform({}))
        for env, platform in [({"RIG_TARGET_ARCH": "sparc"}, None),
                              ({"RIG_TARGET_ARCH": "arm64"}, "linux/amd64"),
                              ({"RIG_TARGET_ARCH": "arm64", "DOCKER_DEFAULT_PLATFORM": "linux/amd64"}, None)]:
            with self.subTest(env=env, platform=platform), self.assertRaises(ValueError):
                ri.native_platform(env, platform)

    def test_exact_pin_set_and_full_image_ids(self):
        self.assertEqual(ri.image_pins(pins(), BASE_IMAGES), dict(zip(BASE_IMAGES, (ID_A, ID_B))))
        invalid = [{"version": True, "images": {}}, {"version": 1, "images": {}, "extra": 1},
                   {"version": 1, "images": {BASE_IMAGES[0]: ID_A}},
                   {"version": 1, "images": {**json.loads(pins())["images"], "unused": ID_C}}]
        for value in ("repo:tag", "sha256:123", ID_A.upper(), 42):
            invalid.append({"version": 1, "images": {BASE_IMAGES[0]: value, BASE_IMAGES[1]: ID_B}})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ri.image_pins(json.dumps(value), BASE_IMAGES)

    def test_compose_inspection_is_bounded_and_rejects_bad_models(self):
        with patch.dict(os.environ, {}, clear=True):
            for payload in ({}, {"services": {}}, {"services": {"bad": {}}}, {"services": []}):
                with self.subTest(payload=payload), patch.object(ri.subprocess, "run") as run:
                    run.return_value = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
                    with self.assertRaises(ValueError):
                        ri.compose_model(["-f", "compose.yml"])
                    self.assertEqual(run.call_args.kwargs["timeout"], 30)
            with patch.object(ri.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 1, "", "bad interpolation")
                with self.assertRaisesRegex(ValueError, "bad interpolation"):
                    ri.compose_model([])
            with patch.object(ri.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 30)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    ri.compose_model([])

    def test_compose_platform_mismatch_is_checked_before_pinning(self):
        value = model()
        value["services"]["dashboard-web"]["platform"] = "linux/amd64"
        with patch.dict(os.environ, {"RIG_TARGET_ARCH": "arm64"}, clear=True), \
                patch.object(ri.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(value), "")):
            with self.assertRaisesRegex(ValueError, "active service dashboard-web"):
                ri.compose_model([])

    def test_inventory_deduplicates_actual_refs_and_is_read_only(self):
        value = model()
        value["services"]["dashboard-zenoh"]["image"] = BASE_IMAGES[0]
        for mode in ("runtime-images", "images"):
            with self.subTest(mode=mode), patch.object(ri, "compose_model", return_value=value), \
                    patch.object(ri.subprocess, "run") as run, redirect_stdout(io.StringIO()) as out:
                self.assertEqual(ri.main([mode]), 0)
                run.assert_not_called()
                if mode == "runtime-images":
                    self.assertEqual(json.loads(out.getvalue()), {"version": 1, "images": [BASE_IMAGES[0]]})
                else:
                    self.assertEqual(out.getvalue(), '- "dashboard-web:local"\n')

    def test_pinned_up_preserves_project_mounts_and_agent_job_image(self):
        value = model()
        value["services"]["dashboard-rig-agent"] = {
            "image": "dashboard-rig-agent:local", "build": {},
            "environment": {"RIG_AGENT_IMAGE": "dashboard-rig-agent:local", "RIG_ROOT": "/fleet"}}
        expected = copy.deepcopy(value)
        images = BASE_IMAGES + ["dashboard-rig-agent:local"]
        with patch.dict(os.environ, {"RIG_TARGET_ARCH": "arm64", "RIG_RUNTIME_IMAGE_PINS": pins(images)}, clear=True), \
                patch.object(ri, "compose_model", return_value=value), patch.object(ri.subprocess, "run") as run:
            run.return_value.returncode = 7
            self.assertEqual(ri.main(["pinned-up", "-f", "a.yml", "--", "-d"]), 7)
            self.assertEqual(run.call_args.args[0], ["docker", "compose", "-f", "-", "up", "--no-build", "--pull", "never", "-d"])
            frozen = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(frozen["name"], expected["name"])
        self.assertEqual(frozen["services"]["dashboard-web"]["volumes"], expected["services"]["dashboard-web"]["volumes"])
        self.assertEqual(frozen["services"]["dashboard-web"]["environment"], expected["services"]["dashboard-web"]["environment"])
        for index, service in enumerate(frozen["services"].values()):
            self.assertEqual(service["image"], (ID_A, ID_B, ID_C)[index])
            self.assertEqual(service["platform"], "linux/arm64")
            self.assertEqual(service["pull_policy"], "never")
            self.assertNotIn("build", service)
        self.assertEqual(frozen["services"]["dashboard-rig-agent"]["environment"]["RIG_AGENT_IMAGE"], ID_C)

    def test_pinned_up_refuses_changed_selection_and_policy_flags(self):
        for args in (["--build"], ["--pull", "always"], ["dashboard-web"], ["--scale", "dashboard-web=2"]):
            with self.subTest(args=args), patch.dict(os.environ, {"RIG_RUNTIME_IMAGE_PINS": pins()}, clear=True), \
                    patch.object(ri, "compose_model", return_value=model()), patch.object(ri.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "selection are fixed"):
                    ri.main(["pinned-up", "--", *args])
                run.assert_not_called()
        with patch.dict(os.environ, {"RIG_RUNTIME_IMAGE_PINS": pins(BASE_IMAGES[:1])}, clear=True), \
                patch.object(ri, "compose_model", return_value=model()), patch.object(ri.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "selection changed"):
                ri.main(["pinned-up"])
            run.assert_not_called()


FAKE_DOCKER = r'''#!PYTHON
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
entry = {"args": args, "env": {k:v for k,v in os.environ.items() if k.startswith(("DASH_", "RIG_", "COMPOSE_"))}}
if args == ["compose", "version"]:
    pass
elif args[:4] == ["compose", "-f", "-", "up"]:
    entry["model"] = json.load(sys.stdin)
elif args[0] == "compose" and args[-3:] == ["config", "--format", "json"]:
    if os.environ.get("REAL_DOCKER"):
        result = subprocess.run([os.environ["REAL_DOCKER"], *args], capture_output=True, text=True)
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        entry["exit"] = result.returncode
    else:
        names = ["dashboard-web", "dashboard-zenoh"]
        if any(a.endswith("docker-compose.rig-agent.yml") for a in args):
            names.append("dashboard-rig-agent")
        variables = {"dashboard-web":"DASH_WEB_IMAGE", "dashboard-zenoh":"DASH_ZENOH_IMAGE", "dashboard-rig-agent":"DASH_AGENT_IMAGE"}
        services = {n:{"image":os.environ.get(variables[n], n+":local"), "build":{"context":"/build"}} for n in names}
        if "dashboard-rig-agent" in services:
            services["dashboard-rig-agent"]["environment"] = {"RIG_AGENT_IMAGE":services["dashboard-rig-agent"]["image"]}
        print(json.dumps({"name":os.environ["COMPOSE_PROJECT_NAME"], "services":services}))
else:
    print("test refuses Docker mutation: " + repr(args), file=sys.stderr)
    sys.exit(99)
with open(os.environ["DOCKER_LOG"], "a") as log:
    log.write(json.dumps(entry)+"\n")
sys.exit(entry.get("exit", 0))
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dashboard-image-contract-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "dashboard"
        self.repo.mkdir()
        shutil.copy2(REPO / "dash-up", self.repo / "dash-up")
        shutil.copytree(REPO / "deploy", self.repo / "deploy")
        (self.repo / "tools").mkdir()
        for name in ("dash_env.py", "dash_zenoh_config.py", "runtime_images.py"):
            shutil.copy2(REPO / "tools" / name, self.repo / "tools" / name)
        self.fleet = self.root / "fleet"
        self.fleet.mkdir()
        self.config = self.fleet / "dash.yaml"
        self.config.write_text("service: dashboard\nname: dash\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "docker"
        fake.write_text(FAKE_DOCKER.replace("#!PYTHON", "#!" + sys.executable))
        fake.chmod(0o755)
        self.log = self.root / "docker.jsonl"
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("DASH_", "RIG_", "COMPOSE_", "DOCKER_", "ROS_"))}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
                        DASH_PYTHON=sys.executable, DOCKER_LOG=str(self.log),
                        PYTHONDONTWRITEBYTECODE="1", RIG_TARGET_ARCH="arm64")

    def invoke(self, *args, **env):
        return subprocess.run([str(self.repo / "dash-up"), str(self.config), *args],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def entries(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def inventory(self, **env):
        result = self.invoke("runtime-images", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_base_inventory_and_yaml_list(self):
        self.assertEqual(self.inventory(), {"version": 1, "images": BASE_IMAGES})
        result = self.invoke("images")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([json.loads(line[2:]) for line in result.stdout.splitlines()], BASE_IMAGES)
        self.assertFalse((self.repo / "var").exists())
        self.assertFalse((self.repo / "tools" / "__pycache__").exists())
        self.assertTrue(all(entry["args"][-3:] == ["config", "--format", "json"] or entry["args"] == ["compose", "version"]
                            for entry in self.entries()))

    def test_registry_catalog_overrides_and_unused_agent_not_in_inventory(self):
        override = "localhost:5000/dashboard-web@sha256:" + "d" * 64
        result = self.inventory(RIG_IMAGE_REGISTRY="localhost:5000", RIG_IMAGE_TAG="fleet",
                                DASH_WEB_IMAGE=override, DASH_AGENT_IMAGE="unused:tag",
                                RIG_RUNTIME_IMAGE_PINS="deliberately ignored by inventory")
        self.assertEqual(result["images"], sorted([override, "localhost:5000/dashboard-zenoh:fleet"]))

    def test_agent_rate_limits_and_data_mount_selection_without_writes(self):
        (self.fleet / "vehicle.yaml").write_text("name: fixture\n")
        self.config.write_text("service: dashboard\nname: dash\nrig_agent: true\n"
                               "topic_rate_hz: 5\nros_domain_id: 7\nclouds_dir: clouds\nrig_data_dir: runs\n")
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.assertEqual(self.inventory()["images"], sorted(BASE_IMAGES + ["dashboard-rig-agent:local"]))
        after = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p != self.log)
        self.assertEqual(after, before)
        entry = self.entries()[-1]
        self.assertEqual(entry["env"]["DASH_RIG_ROOT"], str(self.fleet))
        self.assertEqual(entry["env"]["DASH_RIG_DATA"], str(self.fleet / "runs"))
        self.assertEqual(entry["env"]["DASH_CLOUDS_HOST"], str(self.fleet / "clouds"))
        for overlay in ("rig-agent", "rig-data", "rig-data-web", "clouds"):
            self.assertIn(str(self.repo / "deploy" / f"docker-compose.{overlay}.yml"), entry["args"])

    def test_agent_without_deployment_keeps_existing_skip_policy(self):
        self.config.write_text("name: dash\nrig_agent: true\n")
        result = self.invoke("runtime-images")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("agent skipped", result.stderr)
        self.assertEqual(json.loads(result.stdout)["images"], BASE_IMAGES)

    def test_inventory_validates_rate_limits_and_rejects_extra_selection(self):
        self.config.write_text("name: dash\ntopic_rate_hz: 5\n")
        result = self.invoke("runtime-images")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ros_domain_id", result.stderr)
        self.assertEqual([e["args"] for e in self.entries()], [["compose", "version"]])
        result = self.invoke("runtime-images", "dashboard-web")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not accept", result.stderr)

    def test_pinned_launcher_captures_exact_active_native_model(self):
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(), COMPOSE_PROJECT_NAME="dash-vehicle-fixture")
        self.assertEqual(result.returncode, 0, result.stderr)
        frozen = self.entries()[-1]["model"]
        self.assertEqual(frozen["name"], "dash-vehicle-fixture")
        self.assertEqual({s["image"] for s in frozen["services"].values()}, {ID_A, ID_B})
        self.assertTrue(all(s["platform"] == "linux/arm64" and s["pull_policy"] == "never" and "build" not in s
                            for s in frozen["services"].values()))

    def test_pinned_launcher_refuses_bypass_and_incomplete_map(self):
        for args in (("up", "--build"), ("run", "dashboard-web"), ("--profile", "all", "up"), ("restart",)):
            with self.subTest(args=args):
                result = self.invoke(*args, RIG_RUNTIME_IMAGE_PINS=pins())
                self.assertNotEqual(result.returncode, 0, result.stdout)
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(BASE_IMAGES[:1]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("selection changed", result.stderr)
        self.assertFalse(any("model" in e for e in self.entries()))

    @unittest.skipUnless(DOCKER, "Docker Compose not installed; fake-Compose contract tests still run")
    def test_real_compose_inventory_and_native_pinned_round_trip(self):
        self.config.write_text("name: dash\nclouds_dir: clouds\nrig_data_dir: runs\n")
        digest = "localhost:5000/dashboard-web@sha256:" + "d" * 64
        env = dict(REAL_DOCKER=DOCKER, DASH_WEB_IMAGE=digest, RIG_IMAGE_REGISTRY="localhost:5000", RIG_IMAGE_TAG="fleet")
        inventory = self.inventory(**env)
        self.assertEqual(inventory["images"], sorted([digest, "localhost:5000/dashboard-zenoh:fleet"]))
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(inventory["images"]), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        frozen = self.entries()[-1]["model"]
        web = frozen["services"]["dashboard-web"]
        self.assertEqual({v["target"]: v["source"] for v in web["volumes"]}, {
            "/config/dashboard.yaml": str(self.config), "/clouds": str(self.fleet / "clouds"),
            "/rig-data": str(self.fleet / "runs")})
        # Resolve the stdin model once more to catch Compose interpolation/path round-trip issues.
        probe = subprocess.run([DOCKER, "compose", "-f", "-", "config", "--format", "json"],
                               input=json.dumps(frozen), capture_output=True, text=True, timeout=30)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(json.loads(probe.stdout)["services"], frozen["services"])

    @unittest.skipUnless(DOCKER, "Docker Compose not installed; fake-Compose contract tests still run")
    def test_real_compose_agent_opt_in_and_native_platform_rejection(self):
        self.config.write_text(f"name: dash\nrig_agent: true\nrig_root: {self.fleet}\n"
                               "topic_rate_hz: 5\nros_domain_id: 7\n")
        env = dict(REAL_DOCKER=DOCKER)
        inventory = self.inventory(**env)
        self.assertEqual(inventory["images"], sorted(BASE_IMAGES + ["dashboard-rig-agent:local"]))
        self.assertFalse((self.fleet / "var").exists())
        self.assertFalse((self.repo / "var").exists())
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(inventory["images"]), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        frozen = self.entries()[-1]["model"]
        agent = frozen["services"]["dashboard-rig-agent"]
        self.assertEqual(agent["environment"]["RIG_AGENT_IMAGE"], agent["image"])
        self.assertEqual(agent["environment"]["RIG_ROOT"], str(self.fleet))
        self.assertTrue((self.fleet / "var/dashboard-rig-agent/home").is_dir())
        self.assertTrue((self.repo / "var/run/dash/zenohd-dashboard.json5").is_file())
        result = self.invoke("runtime-images", DOCKER_DEFAULT_PLATFORM="linux/amd64", **env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native linux/arm64", result.stderr)


if __name__ == "__main__":
    unittest.main()
