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
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import runtime_images as ri
import dash_env as de

REPO = Path(__file__).resolve().parents[1]
DOCKER = shutil.which("docker")
ID_A, ID_B, ID_C = ("sha256:" + character * 64 for character in "abc")
BASE_IMAGES = ["dashboard-web:local", "dashboard-zenoh:local"]


class ConfigTests(unittest.TestCase):
    def load(self, text, fallback=False):
        with tempfile.TemporaryDirectory(prefix="dashboard-config-") as tmp:
            path = Path(tmp) / "dashboard.yaml"
            path.write_text(text)
            if fallback:
                with patch.dict(sys.modules, {"yaml": None}):
                    return de.load(str(path))
            return de.load(str(path))

    def test_agent_requirements_match_with_and_without_pyyaml(self):
        cases = [
            ("name: dash", False),
            ("{}", False),
            ("rig_agent: true", True),
            ("rig_agent: false\ntabs: [rig, logs]", False),
            ("rig_agent: true\ntabs: {rig: false}", True),
            ("tabs: [rig]", True),
            ("tabs:\n  - logs", True),
            ("tabs:\n- logs\nname: dash", True),
            ("tabs: {home: false, logs: true}", True),
            ("tabs:\n  rig: true\n  logs: false", True),
            ("tabs: {rig: false, logs: false}", False),
            ("tabs: {rig: 'true', logs: yes}", False),
            ("tabs: [health, cameras, ros, ros3d, clouds, debug]\nvehicle_state: true", False),
            ("home: {widgets: [{type: rig}]}", True),
            ("home:\n  widgets:\n    - type: rig\n      stacks: [front, rear]", True),
            ("home:\n  widgets:\n    - type: panel\n      items:\n        - type: rig", True),
            ("home: {widgets: [{type: rig}]}\ntabs: {home: false, cameras: true}", False),
            ("home: {widgets: [{type: rig}]}\ntabs: {home: false}", True),
            ("home: {widgets: [{type: rig}]}\nrig_agent: false", False),
            ("home: {version: 2, widgets: [{type: rig}]}", False),
            ("home: {version: true, widgets: [{type: rig}]}", False),
            ("home: {widgets: [{type: rig, stacks: bad}]}", False),
            ("home: {widgets: [{type: rig, stacks: [1]}]}", False),
            ("home: {widgets: [{type: panel, items: [{type: panel, items: [{type: rig}]}]}]}", False),
            ("home: {widgets: [{type: preflight, recording_controls: true}, {type: health}]}", False),
        ]
        for text, expected in cases:
            for fallback in (False, True):
                with self.subTest(text=text, fallback=fallback):
                    cfg = self.load(text, fallback)
                    self.assertEqual(de.rig_agent_required(cfg), expected)

    def test_fallback_preserves_nested_names_quotes_and_topic_rates(self):
        text = """name: dash
topic_rates:
  /imu/data: 5
home:
  widgets:
    - type: panel
      title: "Operator's # controls"
      items:
        - type: rig
          label: 'Vehicle: rig'
        - type: text
          text: vehicle's state
          name: nested
tabs: [health, "logs"] # chosen views
"""
        regular, fallback = self.load(text), self.load(text, True)
        self.assertEqual(fallback, regular)
        self.assertEqual(fallback["name"], "dash")
        self.assertEqual(fallback["topic_rates"], {"/imu/data": 5})
        self.assertTrue(de.rig_agent_required(fallback))

    def test_fallback_refuses_unsupported_yaml_instead_of_losing_dependencies(self):
        for text in ("tabs: &views [logs]", "tabs: *views", "tabs: [logs,", "home: !custom widgets"):
            with self.subTest(text=text), self.assertRaisesRegex(SystemExit, "PyYAML"):
                self.load(text, True)

    def test_fallback_reads_shipped_home_example_and_text_blocks(self):
        example = (REPO / "config/infra/dashboard.example.yaml").read_text()
        start = example.index("# home:\n")
        home = "\n".join(line[2:] if line.startswith("# ") else line for line in example[start:].splitlines())
        text_blocks = """home:
  widgets:
    - type: text
      text: |
        Operator's status: # literal content
        Call before lifting.
    - type: text
      text: >-
        Call the tower
        before lifting.
    - type: rig
"""
        for text in (example, example[:start] + home, text_blocks):
            with self.subTest(text=text[:80]):
                regular, fallback = self.load(text), self.load(text, True)
                self.assertEqual(fallback, regular)
                self.assertEqual(de.rig_agent_required(fallback), de.rig_agent_required(regular))
        self.assertTrue(de.rig_agent_required(self.load(text_blocks, True)))

    def test_launcher_identity_precedes_config_then_hostname(self):
        for identity in ("from-rig", "rover.3", "-rover-"):
            with patch.dict(os.environ, {"VEHICLE_ID": identity}, clear=True):
                self.assertEqual(de.state_key({"name": "dash", "vehicle_id": "from-config"}), f"fleet/{identity}/dash/dash/state")
        for identity in ("", "rover/3", "rover*", "rover 3"):
            with patch.dict(os.environ, {"VEHICLE_ID": identity}, clear=True), self.assertRaisesRegex(SystemExit, "VEHICLE_ID"):
                de.state_key({"name": "dash"})
        with patch.dict(os.environ, {}, clear=True), patch.object(de.socket, "gethostname", return_value="rover.local"):
            self.assertEqual(de.state_key({"name": "dash", "vehicle_id": 7}), "fleet/7/dash/dash/state")
            self.assertEqual(de.state_key({"name": "dash", "vehicle_id": "rover.3"}), "fleet/rover.3/dash/dash/state")
            self.assertEqual(de.state_key({"name": "dash"}), "fleet/rover/dash/dash/state")


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
        if any(a.endswith("docker-compose.vehicle-state.yml") for a in args):
            names += ["dashboard-state", "dashboard-state-zenoh"]
        variables = {"dashboard-web":"DASH_WEB_IMAGE", "dashboard-zenoh":"DASH_ZENOH_IMAGE", "dashboard-rig-agent":"DASH_AGENT_IMAGE",
                     "dashboard-state":"DASH_STATE_IMAGE", "dashboard-state-zenoh":"DASH_ZENOH_IMAGE"}
        local = {"dashboard-state-zenoh": "dashboard-zenoh:local"}
        services = {n:{"image":os.environ.get(variables[n], local.get(n, n+":local")), "build":{"context":"/build"}} for n in names}
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
                    if k != "VEHICLE_ID" and not k.startswith(("DASH_", "RIG_", "COMPOSE_", "DOCKER_", "ROS_"))}
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
                               "topic_rates:\n  /imu/data: 5\nros_domain_id: 7\nclouds_dir: clouds\nrig_data_dir: runs\n")
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.assertEqual(self.inventory()["images"], sorted(BASE_IMAGES + ["dashboard-rig-agent:local", "dashboard-state:local"]))
        after = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p != self.log)
        self.assertEqual(after, before)
        entry = self.entries()[-1]
        self.assertEqual(entry["env"]["DASH_RIG_ROOT"], str(self.fleet))
        self.assertEqual(entry["env"]["DASH_RIG_DATA"], str(self.fleet / "runs"))
        self.assertEqual(entry["env"]["DASH_CLOUDS_HOST"], str(self.fleet / "clouds"))
        for overlay in ("rig-agent", "rig-data", "rig-data-web", "clouds", "vehicle-state", "state-rig-data"):
            self.assertIn(str(self.repo / "deploy" / f"docker-compose.{overlay}.yml"), entry["args"])

    def test_runtime_inventory_follows_rendered_agent_dependencies_and_overrides(self):
        (self.fleet / "vehicle.yaml").write_text("name: fixture\n")
        # -S proves ordinary nested YAML still selects services on a stock Python host.
        no_yaml = self.bin / "python-no-yaml"
        no_yaml.write_text(f"#!/bin/sh\nunset PYTHONPATH\nexec {shlex.quote(sys.executable)} -S \"$@\"\n")
        no_yaml.chmod(0o755)
        cases = [
            ("tabs: [logs]", True),
            ("tabs:\n  rig: true", True),
            ("home:\n  widgets:\n    - type: panel\n      items:\n        - type: rig", True),
            ("tabs: {home: false, clouds: true}\nhome: {widgets: [{type: rig}]}", False),
            ("tabs: [health, cameras, clouds]\nhome: {widgets: [{type: preflight}]}", False),
            ("tabs: [rig, logs]\nrig_agent: false", False),
            ("tabs: {rig: false}\nrig_agent: true", True),
        ]
        for body, required in cases:
            for python in (sys.executable, str(no_yaml)):
                with self.subTest(body=body, python=python):
                    self.config.write_text(f"name: dash\n{body}\n")
                    expected = sorted(BASE_IMAGES + (["dashboard-rig-agent:local"] if required else []))
                    self.assertEqual(self.inventory(DASH_PYTHON=python)["images"], expected)
                    env = self.entries()[-1]["env"]
                    self.assertEqual(env["DASH_RIG_AGENT"], str(int(required)))
                    self.assertEqual(env["DASH_RIG_ACTUATE"], "0")
        self.config.write_text("name: dash\ntabs: [rig]\nrig_actuate: true\n")
        self.inventory()
        self.assertEqual(self.entries()[-1]["env"]["DASH_RIG_ACTUATE"], "1")

    def test_inherited_run_registry_starts_state_without_agent_or_projected_widgets(self):
        self.config.write_text("name: dash\nvehicle_state: false\nrig_agent: false\nvehicle_id: config-vehicle\n")
        data = str(self.fleet / "recordings")
        self.assertEqual(self.inventory(RIG_DATA_DIR=data, VEHICLE_ID="rover.3")["images"],
                         sorted(BASE_IMAGES + ["dashboard-state:local"]))
        entry = self.entries()[-1]
        env = entry["env"]
        self.assertEqual(env["DASH_VEHICLE_STATE"], "0")
        self.assertEqual(env["DASH_RIG_AGENT"], "0")
        self.assertEqual(env["DASH_VEHICLE_ID"], "rover.3")
        self.assertEqual(env["DASH_STATE_KEY"], "fleet/rover.3/dash/dash/state")
        self.assertEqual(env["DASH_RIG_DATA"], data)
        self.assertIn(str(self.repo / "deploy/docker-compose.state-rig-data.yml"), entry["args"])
        self.assertNotIn(str(self.repo / "deploy/docker-compose.rig-agent.yml"), entry["args"])
        self.assertFalse((self.repo / "var").exists())

    def test_unsupported_fallback_config_fails_before_compose_selection(self):
        no_yaml = self.bin / "python-no-yaml"
        no_yaml.write_text(f"#!/bin/sh\nunset PYTHONPATH\nexec {shlex.quote(sys.executable)} -S \"$@\"\n")
        no_yaml.chmod(0o755)
        self.config.write_text("name: dash\ntabs: &views [logs]\n")
        result = self.invoke("runtime-images", DASH_PYTHON=str(no_yaml))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PyYAML", result.stderr)
        self.assertEqual([e["args"] for e in self.entries()], [["compose", "version"]])

    def test_vehicle_state_inventory_key_and_registry_without_writes(self):
        self.config.write_text("service: dashboard\nname: dash\nvehicle_state: true\nvehicle_id: rover-3\n")
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        # The private bridge reuses the dashboard-zenoh image: one new image, not two.
        self.assertEqual(self.inventory()["images"], sorted(BASE_IMAGES + ["dashboard-state:local"]))
        after = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p != self.log)
        self.assertEqual(after, before)
        entry = self.entries()[-1]
        self.assertEqual(entry["env"]["DASH_STATE_KEY"], "fleet/rover-3/dash/dash/state")
        self.assertEqual(entry["env"]["DASH_STATE_WS_PORT"], "10001")
        self.assertEqual(entry["env"]["DASH_RUNTIME_JSON"], str(self.repo / "var/run/dash/runtime.json"))
        self.assertIn(str(self.repo / "deploy/docker-compose.vehicle-state.yml"), entry["args"])
        result = self.inventory(RIG_IMAGE_REGISTRY="localhost:5000", RIG_IMAGE_TAG="fleet")
        self.assertEqual(result["images"], sorted(f"localhost:5000/{n}:fleet" for n in ("dashboard-state", "dashboard-web", "dashboard-zenoh")))

    def test_vehicle_state_key_defaults_to_the_short_hostname(self):
        self.config.write_text("name: dash\nvehicle_state: true\nstate_ws_port: 10555\n")
        self.inventory()
        host = re.sub(r"[^A-Za-z0-9_-]+", "-", socket.gethostname().split(".")[0]).strip("-") or "vehicle"
        env = self.entries()[-1]["env"]
        self.assertEqual(env["DASH_STATE_KEY"], f"fleet/{host}/dash/dash/state")
        self.assertEqual(env["DASH_STATE_WS_PORT"], "10555")

    def test_agent_without_deployment_keeps_existing_skip_policy(self):
        self.config.write_text("name: dash\nrig_agent: true\n")
        result = self.invoke("runtime-images")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("agent skipped", result.stderr)
        self.assertEqual(json.loads(result.stdout)["images"], BASE_IMAGES)

    def test_inventory_validates_rate_limits_and_rejects_extra_selection(self):
        self.config.write_text("name: dash\ntopic_rates:\n  /imu/data: 5\n")
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
        entry = self.entries()[-1]
        self.assertEqual(entry["args"].count("--remove-orphans"), 1)
        frozen = entry["model"]
        self.assertEqual(frozen["name"], "dash-vehicle-fixture")
        self.assertEqual({s["image"] for s in frozen["services"].values()}, {ID_A, ID_B})
        self.assertTrue(all(s["platform"] == "linux/arm64" and s["pull_policy"] == "never" and "build" not in s
                            for s in frozen["services"].values()))
        result = self.invoke("up", "-d", "--remove-orphans", RIG_RUNTIME_IMAGE_PINS=pins())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entries()[-1]["args"].count("--remove-orphans"), 1)

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
        self.assertEqual(inventory["images"], sorted([digest, "localhost:5000/dashboard-zenoh:fleet", "localhost:5000/dashboard-state:fleet"]))
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(inventory["images"]), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        frozen = self.entries()[-1]["model"]
        web = frozen["services"]["dashboard-web"]
        self.assertEqual({v["target"]: v["source"] for v in web["volumes"]}, {
            "/config/dashboard.yaml": str(self.config), "/clouds": str(self.fleet / "clouds"),
            "/rig-data": str(self.fleet / "runs"), "/config/runtime.json": str(self.repo / "var/run/dash/runtime.json")})
        # Resolve the stdin model once more to catch Compose interpolation/path round-trip issues.
        probe = subprocess.run([DOCKER, "compose", "-f", "-", "config", "--format", "json"],
                               input=json.dumps(frozen), capture_output=True, text=True, timeout=30)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(json.loads(probe.stdout)["services"], frozen["services"])

    @unittest.skipUnless(DOCKER, "Docker Compose not installed; fake-Compose contract tests still run")
    def test_real_compose_vehicle_state_round_trip(self):
        self.config.write_text("name: dash\nvehicle_state: true\nvehicle_id: rover-3\ntopic_rates:\n  /imu/data: 5\nros_domain_id: 7\n")
        env = dict(REAL_DOCKER=DOCKER)
        inventory = self.inventory(**env)
        self.assertEqual(inventory["images"], sorted(BASE_IMAGES + ["dashboard-state:local"]))
        self.assertFalse((self.repo / "var").exists())
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(inventory["images"]), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = self.entries()[-1]["model"]["services"]
        runtime = self.repo / "var/run/dash/runtime.json"
        self.assertEqual(json.loads(runtime.read_text()), {"vehicle_state_key": "fleet/rover-3/dash/dash/state"})
        self.assertIn({"target": "/config/runtime.json", "source": str(runtime)},
                      [{"target": v["target"], "source": v["source"]} for v in services["dashboard-web"]["volumes"]])
        state, bridge = services["dashboard-state"], services["dashboard-state-zenoh"]
        self.assertEqual(state["environment"], {"DASH_STATE_KEY": "fleet/rover-3/dash/dash/state",
                                                "DASH_STATE_LOCATOR": "ws/127.0.0.1:10001", "VEHICLE_ID": "rover-3"})
        self.assertEqual(bridge["image"], services["dashboard-zenoh"]["image"])  # one pinned bridge image
        self.assertEqual(bridge["command"][-2:], ["--ws-port", "127.0.0.1:10001"])
        # The private bridge always gets the stock config: the browser path's rate limits never apply.
        self.assertEqual([v["source"] for v in bridge["volumes"]], [str(self.repo / "deploy/zenohd-dashboard.json5")])
        self.assertNotEqual(services["dashboard-zenoh"]["volumes"][0]["source"], bridge["volumes"][0]["source"])

    @unittest.skipUnless(DOCKER, "Docker Compose not installed; fake-Compose contract tests still run")
    def test_real_compose_run_only_state_mount_and_identity(self):
        self.config.write_text("name: dash\nvehicle_state: false\nrig_agent: false\nvehicle_id: ignored-config\n")
        data = str(self.fleet / "records")
        env = dict(REAL_DOCKER=DOCKER, RIG_DATA_DIR=data, VEHICLE_ID="rover.3")
        inventory = self.inventory(**env)
        self.assertEqual(inventory["images"], sorted(BASE_IMAGES + ["dashboard-state:local"]))
        result = self.invoke("up", "-d", RIG_RUNTIME_IMAGE_PINS=pins(inventory["images"]), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = self.entries()[-1]["model"]["services"]
        self.assertNotIn("dashboard-rig-agent", services)
        state = services["dashboard-state"]
        self.assertEqual(state["environment"]["VEHICLE_ID"], "rover.3")
        self.assertEqual(state["environment"]["RIG_DATA_DIR"], data)
        self.assertEqual(state["volumes"], [{"type": "bind", "source": data, "target": data,
                                             "read_only": True, "bind": {"create_host_path": False}}])
        runtime = json.loads((self.repo / "var/run/dash/runtime.json").read_text())
        self.assertEqual(runtime, {"vehicle_state_key": "fleet/rover.3/dash/dash/state",
                                  "current_run_state_key": "fleet/rover.3/dash/dash/state"})

    @unittest.skipUnless(DOCKER, "Docker Compose not installed; fake-Compose contract tests still run")
    def test_real_compose_agent_opt_in_and_native_platform_rejection(self):
        self.config.write_text(f"name: dash\nrig_agent: true\nrig_root: {self.fleet}\n"
                               "topic_rates:\n  /imu/data: 5\nros_domain_id: 7\n")
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
