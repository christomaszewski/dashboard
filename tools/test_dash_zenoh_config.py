"""tools/dash_zenoh_config.py -- the topic rate limits an instance config turns into the sidecar's
zenoh downsampling rules. Pure core (`rules`, `render`) plus the CLI over a temp dir.
Run: python3 tools/test_dash_zenoh_config.py"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dash_zenoh_config as dz  # noqa: E402

TOOL = pathlib.Path(__file__).resolve().parent / "dash_zenoh_config.py"
TEMPLATE = pathlib.Path(__file__).resolve().parent.parent / "deploy" / "zenohd-dashboard.json5"


def _raises(fn, needle):
    try:
        fn()
    except SystemExit as exc:
        assert needle in str(exc), str(exc)
        return
    raise AssertionError(f"expected a refusal mentioning {needle!r}")


def test_no_limits_no_rules():
    assert dz.rules({}, {}) == []
    assert dz.rules({"web_port": 8080}, {"ROS_DOMAIN_ID": "1"}) == []


def test_the_domain_wide_cap_is_refused_with_its_replacement():
    # zenoh's per-rule budget made it starve slow topics; per-topic rules each get their own
    _raises(lambda: dz.rules({"topic_rate_hz": 5, "ros_domain_id": 7}, {}), "topic_rate_hz was removed")
    _raises(lambda: dz.rules({"topic_rate_hz": 5, "topic_rates": {"/a": 1}}, {"ROS_DOMAIN_ID": "1"}), "topic_rates")
    assert dz.rules({"topic_rates": {"/a": 1}, "ros_domain_id": 3}, {"ROS_DOMAIN_ID": "1"})[0]["key_expr"] == "3/a/**"  # config wins


def test_per_topic_caps_map_to_rmw_zenoh_topic_keys():
    out = dz.rules({"topic_rates": {"/imu/data": 10, "/ouster/points": 1}}, {"ROS_DOMAIN_ID": "1"})
    assert out == [{"key_expr": "1/imu/data/**", "freq": 10.0}, {"key_expr": "1/ouster/points/**", "freq": 1.0}]


def test_refusals_name_the_reason():
    _raises(lambda: dz.rules({"topic_rates": {"/a": 1}}, {}), "ros_domain_id")
    _raises(lambda: dz.rules({"topic_rates": {"/a": 0}, "ros_domain_id": 1}, {}), "> 0 Hz")
    _raises(lambda: dz.rules({"topic_rates": {"/a": "fast"}, "ros_domain_id": 1}, {}), "rate in Hz")
    _raises(lambda: dz.rules({"topic_rates": {"/a": True}, "ros_domain_id": 1}, {}), "rate in Hz")
    _raises(lambda: dz.rules({"topic_rates": {"imu": 1}, "ros_domain_id": 1}, {}), "not a ROS topic name")
    _raises(lambda: dz.rules({"topic_rates": {}, "ros_domain_id": 1}, {}), "non-empty mapping")


def test_render_splices_a_downsampling_block_into_the_stock_template():
    text = dz.render(TEMPLATE.read_text(), [{"key_expr": "1/**", "freq": 5.0}])
    assert 'flows: ["ingress"]' in text and 'messages: ["put"]' in text
    assert '{ key_expr: "1/**", freq: 5 },' in text
    assert text.rstrip().endswith("}")
    # json5-with-comments: strip the comments and it is JSON with the stock keys plus the block
    import re
    body = "\n".join(re.sub(r"//.*$", "", l) for l in text.splitlines())   # comments, full-line and trailing
    body = body.replace("mode:", '"mode":').replace("connect:", '"connect":').replace("endpoints:", '"endpoints":')
    body = body.replace("scouting:", '"scouting":').replace("multicast:", '"multicast":').replace("enabled:", '"enabled":')
    body = body.replace("downsampling:", '"downsampling":').replace("flows:", '"flows":').replace("messages:", '"messages":')
    body = body.replace("rules:", '"rules":').replace("key_expr:", '"key_expr":').replace("freq:", '"freq":')
    body = re.sub(r",(\s*[}\]])", r"\1", body)  # trailing commas
    doc = json.loads(body)
    assert doc["mode"] == "client" and doc["downsampling"][0]["rules"] == [{"key_expr": "1/**", "freq": 5}]


def test_cli_writes_the_file_and_prints_its_path_only_when_limits_are_set():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = pathlib.Path(tmp) / "dash.yaml"
        out = pathlib.Path(tmp) / "var" / "run" / "dash" / "zenohd-dashboard.json5"
        env = {k: v for k, v in os.environ.items() if k != "ROS_DOMAIN_ID"}
        cfg.write_text("service: dashboard\nname: dash\n")
        r = subprocess.run([sys.executable, str(TOOL), str(cfg), str(out)], env=env, capture_output=True, text=True)
        assert r.returncode == 0 and r.stdout == "" and not out.exists(), r
        # an indented /topic: Hz block, read with or without PyYAML on the host
        cfg.write_text("service: dashboard\nname: dash\ntopic_rates:\n  /imu/data: 10   # IMU\n  /ouster/points: 1\nhome:\n  widgets: []\n")
        r = subprocess.run([sys.executable, str(TOOL), str(cfg), str(out)], env=env, capture_output=True, text=True)
        assert r.returncode == 1 and "ros_domain_id" in r.stderr, r
        r = subprocess.run([sys.executable, str(TOOL), str(cfg), str(out)], env={**env, "ROS_DOMAIN_ID": "1"}, capture_output=True, text=True)
        assert r.returncode == 0 and r.stdout.strip() == str(out), r
        text = out.read_text()
        assert '{ key_expr: "1/imu/data/**", freq: 10 },' in text and '{ key_expr: "1/ouster/points/**", freq: 1 },' in text
        cfg.write_text("service: dashboard\nname: dash\ntopic_rate_hz: 5\nros_domain_id: 1\n")
        r = subprocess.run([sys.executable, str(TOOL), str(cfg), str(out)], env=env, capture_output=True, text=True)
        assert r.returncode == 1 and "topic_rate_hz was removed" in r.stderr, r


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print("FAIL", name, "->", exc)
    sys.exit(1 if failures else 0)
