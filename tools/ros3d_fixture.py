#!/usr/bin/env python3
"""Deterministic Lyrical fixture: live topics, a small bag, and native CDR test vectors.

Run in the existing fleet-ros image with RMW_IMPLEMENTATION=rmw_zenoh_cpp.
No Ouster hardware, captured bag, or extra Python packages are needed.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from rclpy.serialization import serialize_message
from builtin_interfaces.msg import Time
from geometry_msgs.msg import TransformStamped
from sensor_msgs.msg import PointCloud2, PointField
from tf2_msgs.msg import TFMessage
from rosgraph_msgs.msg import Clock


def stamp(ns):
    return Time(sec=ns // 1_000_000_000, nanosec=ns % 1_000_000_000)


def transform(parent, child, ns, x=0.0, y=0.0, z=0.0, yaw=0.0):
    msg = TransformStamped()
    msg.header.frame_id, msg.child_frame_id = parent, child
    msg.header.stamp = stamp(ns)
    msg.transform.translation.x, msg.transform.translation.y, msg.transform.translation.z = float(x), float(y), float(z)
    msg.transform.rotation.z, msg.transform.rotation.w = math.sin(yaw / 2), math.cos(yaw / 2)
    return msg


def pose(t):
    return 2 * math.sin(t * .35), math.cos(t * .25), .3 * math.sin(t * .2)


def messages(t, count=12000, epoch=1000_000_000_000):
    ns = epoch + round(t * 1e9)
    bx, by, yaw = pose(t)
    dynamic = TFMessage(transforms=[transform("odom", "base_link", ns, bx, by, yaw=yaw)])
    static = TFMessage(transforms=[transform("map", "odom", 0), transform("base_link", "test_ouster", 0, .5, 0, 1)])
    c, s = math.cos(yaw), math.sin(yaw)
    ox, oy, oz = bx + .5 * c, by + .5 * s, 1.0
    data = bytearray(count * 24)
    expected = []
    for i in range(count):
        u, v = (i % 100) / 99, ((i // 100) % 100) / 99
        surface = (i // 10000) % 3
        if surface == 0:
            world = (u * 30 - 15, v * 30 - 15, 0.0)
        elif surface == 1:
            world = (12.0, u * 24 - 12, v * 5)
        else:
            world = (u * 24 - 12, 12.0, v * 5)
        dx, dy = world[0] - ox, world[1] - oy
        local = (c * dx + s * dy, -s * dx + c * dy, world[2] - oz)
        struct.pack_into("<ffffHBBI", data, i * 24, *local, float((i % 256)), i % 128, i % 255, 0, i * 1000)
        if i < 16:
            expected.append(list(world))
    cloud = PointCloud2()
    cloud.header.frame_id, cloud.header.stamp = "test_ouster", stamp(ns)
    cloud.width, cloud.height, cloud.point_step, cloud.row_step = count, 1, 24, count * 24
    cloud.is_bigendian, cloud.is_dense, cloud.data = False, True, bytes(data)
    cloud.fields = [PointField(name=name, offset=offset, datatype=datatype, count=1) for name, offset, datatype in
                    [("x", 0, 7), ("y", 4, 7), ("z", 8, 7), ("intensity", 12, 7), ("ring", 16, 4), ("reflectivity", 18, 2), ("t", 20, 6)]]
    return static, dynamic, cloud, expected


def native_vectors(directory):
    from tf2_ros import Buffer
    from rclpy.time import Time as RosTime
    directory.mkdir(parents=True, exist_ok=True)
    static, dynamic, cloud, expected = messages(2.0, 16)
    buffer = Buffer()
    for tf in static.transforms:
        buffer.set_transform_static(tf, "fixture")
    for tf in dynamic.transforms:
        buffer.set_transform(tf, "fixture")
    oracle = buffer.lookup_transform("map", "test_ouster", RosTime.from_msg(cloud.header.stamp))
    for name, message in [("tf_static", static), ("tf", dynamic), ("points", cloud), ("clock", Clock(clock=cloud.header.stamp))]:
        (directory / (name + ".cdr")).write_bytes(serialize_message(message))
    (directory / "native.json").write_text(json.dumps({name: list((directory / (name + ".cdr")).read_bytes())
        for name in ("tf_static", "tf", "points", "clock")}) + "\n")
    (directory / "expected.json").write_text(json.dumps({"world_points": expected, "transform": {
        "translation": [oracle.transform.translation.x, oracle.transform.translation.y, oracle.transform.translation.z],
        "rotation": [oracle.transform.rotation.x, oracle.transform.rotation.y, oracle.transform.rotation.z, oracle.transform.rotation.w],
    }, "ros_distro": "lyrical", "source": "rclpy serialization and native tf2 lookup"}, indent=2) + "\n")


def write_bag(path, duration, hz, count):
    import rosbag2_py
    writer = rosbag2_py.SequentialWriter()
    writer.open(rosbag2_py.StorageOptions(uri=str(path), storage_id="mcap"), rosbag2_py.ConverterOptions("cdr", "cdr"))
    # Native rosbag QoS metadata ensures /tf_static is transient local on ordinary rosbag2 playback.
    for ident, name, kind in [(1, "/tf_static", "tf2_msgs/msg/TFMessage"), (2, "/tf", "tf2_msgs/msg/TFMessage"), (3, "/ouster/points", "sensor_msgs/msg/PointCloud2")]:
        qos = rosbag2_py._storage.QoS(1 if name == "/tf_static" else 100)
        if name == "/tf_static":
            qos.transient_local()
        writer.create_topic(rosbag2_py.TopicMetadata(id=ident, name=name, type=kind, serialization_format="cdr", offered_qos_profiles=[qos]))
    for i in range(round(duration * hz)):
        static, dynamic, cloud, _ = messages(i / hz, count)
        ns = cloud.header.stamp.sec * 1_000_000_000 + cloud.header.stamp.nanosec
        if i == 0:
            writer.write("/tf_static", serialize_message(static), ns)
        writer.write("/tf", serialize_message(dynamic), ns)
        writer.write("/ouster/points", serialize_message(cloud), ns)
    del writer
    print(f"Wrote {path}: {duration}s, {hz} Hz, {count} points/scan", flush=True)


class Fixture(Node):
    def __init__(self, count, hz):
        super().__init__("ros3d_fixture")
        self.count, self.started = count, time.monotonic()
        static_qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE)
        self.static_a = self.create_publisher(TFMessage, "/tf_static", static_qos)
        self.static_b = self.create_publisher(TFMessage, "/tf_static", static_qos)
        self.dynamic = self.create_publisher(TFMessage, "/tf", 100)
        self.points = self.create_publisher(PointCloud2, "/ouster/points", 5)
        self.clock = self.create_publisher(Clock, "/clock", 10)
        static, _, _, _ = messages(0, 1)
        self.static_a.publish(TFMessage(transforms=[static.transforms[0]]))
        self.static_b.publish(TFMessage(transforms=[static.transforms[1]]))
        self.create_timer(1 / hz, self.tick)

    def tick(self):
        _, dynamic, cloud, _ = messages(time.monotonic() - self.started, self.count)
        self.clock.publish(Clock(clock=cloud.header.stamp))
        self.dynamic.publish(dynamic)
        self.points.publish(cloud)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bag", type=Path)
    parser.add_argument("--cdr", type=Path)
    parser.add_argument("--duration", type=float, default=12)
    parser.add_argument("--hz", type=float, default=10)
    parser.add_argument("--points", type=int, default=12000)
    args = parser.parse_args()
    if not 1 <= args.points <= 2_000_000 or not 0 < args.hz <= 100 or not 0 < args.duration <= 300:
        parser.error("points/hz/duration outside fixture limits")
    rclpy.init()
    try:
        if args.cdr:
            native_vectors(args.cdr)
        if args.bag:
            write_bag(args.bag, args.duration, args.hz, args.points)
        if not args.bag and not args.cdr:
            node = Fixture(args.points, args.hz)
            try:
                rclpy.spin(node)
            except KeyboardInterrupt:
                pass
            finally:
                node.destroy_node()
    finally:
        rclpy.shutdown()


if __name__ == "__main__":
    main()
