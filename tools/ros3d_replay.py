#!/usr/bin/env python3
"""TF-aware ROS 3D bag playback on Lyrical/rmw_zenoh.

Reads existing bags without modification. Indexes TF on temporary disk, streams
selected point-cloud topics, and publishes an atomic TF snapshot on each seek.
Run this instead of another player for these topics (one clock/TF authority).
"""
import argparse
import json
import math
import sqlite3
import tempfile
import time
import uuid

import rclpy
import rosbag2_py
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from rclpy.serialization import deserialize_message
from rosidl_runtime_py.convert import message_to_ordereddict
from rosidl_runtime_py.set_message import set_message_fields
from sensor_msgs.msg import PointCloud2
from tf2_msgs.msg import TFMessage
from rosgraph_msgs.msg import Clock
from builtin_interfaces.msg import Time
from std_msgs.msg import String
from std_srvs.srv import SetBool
from rosbag2_interfaces.srv import Pause, Resume, IsPaused, GetRate, SetRate, Seek

NS = 1_000_000_000


def ns(stamp):
    return stamp.sec * NS + stamp.nanosec


def stamp(value):
    return Time(sec=value // NS, nanosec=value % NS)


def reader(path):
    result = rosbag2_py.SequentialReader()
    result.open(rosbag2_py.StorageOptions(uri=path, storage_id=""), rosbag2_py.ConverterOptions("cdr", "cdr"))
    return result


class TfIndex:
    """Disk-backed index: bounded Python memory even for long recordings."""
    def __init__(self, path, tf_topics, static_topics):
        self.temp = tempfile.TemporaryDirectory(prefix="ros3d-tf-")
        self.db = sqlite3.connect(self.temp.name + "/tf.sqlite")
        self.db.execute("CREATE TABLE tf (child TEXT, stamp INTEGER, record INTEGER, static INTEGER, value TEXT)")
        scan = reader(path)
        scan.set_filter(rosbag2_py.StorageFilter(topics=tf_topics + static_topics))
        for_count = 0
        while scan.has_next():
            topic, data, record = scan.read_next()
            for tf in deserialize_message(data, TFMessage).transforms:
                self.db.execute("INSERT INTO tf VALUES (?, ?, ?, ?, ?)",
                                (tf.child_frame_id, ns(tf.header.stamp), record, int(topic in static_topics),
                                 json.dumps(message_to_ordereddict(tf))))
                for_count += 1
                if for_count % 10000 == 0:
                    self.db.commit()
        self.db.execute("CREATE INDEX by_stamp ON tf (static, child, stamp)")
        self.db.execute("CREATE INDEX by_record ON tf (static, child, record)")
        self.db.commit()
        self.children = [row[0] for row in self.db.execute("SELECT DISTINCT child FROM tf")]
        if len(self.children) > 1024:
            raise ValueError("bag exceeds 1024 TF frames")

    def snapshot(self, acquisition, record):
        dynamic, static = [], []
        for child in self.children:
            old = self.db.execute("SELECT value FROM tf WHERE static=1 AND child=? AND record<=? ORDER BY record DESC LIMIT 1", (child, record)).fetchone()
            if old:
                static.append(json.loads(old[0]))
            for sign, order in [("<=", "DESC"), (">", "ASC")]:
                row = self.db.execute(f"SELECT value FROM tf WHERE static=0 AND child=? AND stamp{sign}? ORDER BY stamp {order} LIMIT 1", (child, acquisition)).fetchone()
                if row:
                    dynamic.append(json.loads(row[0]))
        return static, dynamic

    def close(self):
        self.db.close()
        self.temp.cleanup()


class Replay(Node):
    def __init__(self, args):
        super().__init__("ros3d_replay")
        self.args = args
        self.stream = reader(args.bag)
        types = {t.name: t.type for t in self.stream.get_all_topics_and_types()}
        self.cloud_topics = args.points or [name for name, kind in types.items() if kind == "sensor_msgs/msg/PointCloud2"]
        if not self.cloud_topics:
            raise ValueError("bag contains no PointCloud2 topics")
        for topic in self.cloud_topics:
            if types.get(topic) != "sensor_msgs/msg/PointCloud2":
                raise ValueError(f"{topic} is not a PointCloud2 topic in this bag")
        self.tf_topics = [t for t in args.tf if t in types]
        self.static_topics = [t for t in args.tf_static if t in types]
        self.get_logger().info("Indexing TF on temporary disk…")
        self.index = TfIndex(args.bag, self.tf_topics, self.static_topics)
        self.stream.set_filter(rosbag2_py.StorageFilter(topics=self.cloud_topics + self.tf_topics + self.static_topics))
        metadata = self.stream.get_metadata()
        self.begin = metadata.starting_time.nanoseconds
        self.end = self.begin + metadata.duration.nanoseconds
        self.position = self.begin
        self.paused, self.rate, self.loop = args.start_paused, args.rate, args.loop
        self.run_id, self.epoch = uuid.uuid4().hex, 0
        self.pending = None
        self.last_cloud_stamp = self.begin
        self.last_snapshot_at = 0.0
        self.anchor = time.monotonic()
        self.anchor_position = self.position
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE)
        self.state_pub = self.create_publisher(String, args.state_topic, latched)
        self.clock_pub = self.create_publisher(Clock, "/clock", latched)
        self.points_pubs = {topic: self.create_publisher(PointCloud2, topic, latched) for topic in self.cloud_topics}
        self.tf_pubs = {topic: self.create_publisher(TFMessage, topic, 100) for topic in self.tf_topics}
        self.static_pub = self.create_publisher(TFMessage, args.tf_static[0], latched)
        self.create_service(Pause, "~/pause", self.pause)
        self.create_service(Resume, "~/resume", self.resume)
        self.create_service(IsPaused, "~/is_paused", self.is_paused)
        self.create_service(GetRate, "~/get_rate", self.get_rate)
        self.create_service(SetRate, "~/set_rate", self.set_rate)
        self.create_service(Seek, "~/seek", self.seek)
        self.create_service(SetBool, "~/set_loop", self.set_loop)
        self.jump(self.begin)
        self.create_timer(.01, self.tick)
        self.get_logger().info(f"Ready: {self.begin / NS:.9f}–{self.end / NS:.9f} ROS seconds, {len(self.cloud_topics)} cloud topics")

    def reanchor(self):
        self.anchor, self.anchor_position = time.monotonic(), self.position

    def jump(self, destination):
        # A paused seek previews the first cloud at/after the requested bag timestamp.
        # No full clouds are indexed or accumulated in RAM.
        preview = reader(self.args.bag)
        preview.set_filter(rosbag2_py.StorageFilter(topics=self.cloud_topics))
        preview.seek(destination)
        if not preview.has_next():
            return False
        topic, data, record = preview.read_next()
        if len(data) > 64 * 1024 * 1024:
            raise ValueError("preview cloud exceeds 64 MiB")
        cloud = deserialize_message(data, PointCloud2)
        static, dynamic = self.index.snapshot(ns(cloud.header.stamp), record)
        self.publish_static(static)
        self.position = record
        self.epoch += 1
        # Snapshot is atomic at the viewer: reset + seed happen together before
        # admitting the preview cloud. Use strings for integer nanoseconds.
        self.last_cloud_stamp = ns(cloud.header.stamp)
        self.publish_snapshot(static, dynamic)
        self.clock_pub.publish(Clock(clock=stamp(record)))
        self.points_pubs[topic].publish(cloud)
        self.stream.seek(record)
        # Position the streaming reader after the cloud that was just previewed.
        # Same-time TF preceding it is already in the atomic snapshot.
        while self.stream.has_next():
            name, _, at = self.stream.read_next()
            if name == topic and at == record:
                break
        self.pending = None
        self.reanchor()
        return True

    def publish_static(self, transforms):
        message = TFMessage()
        set_message_fields(message, {"transforms": transforms})
        self.static_pub.publish(message)

    def publish_snapshot(self, static=None, dynamic=None):
        if static is None:
            static, dynamic = self.index.snapshot(self.last_cloud_stamp, self.position)
        self.state_pub.publish(String(data=json.dumps({"version": 1, "run": self.run_id, "epoch": self.epoch,
            "player": self.get_fully_qualified_name(), "position": str(self.position), "begin": str(self.begin), "end": str(self.end),
            "static": static, "dynamic": dynamic})))
        self.last_snapshot_at = time.monotonic()

    def tick(self):
        if self.paused:
            return
        target = self.anchor_position + int((time.monotonic() - self.anchor) * self.rate * NS)
        # Bound a timer callback so service controls remain responsive in dense bags.
        for _ in range(100):
            if self.pending is None:
                if not self.stream.has_next():
                    if self.loop:
                        self.jump(self.begin)
                    else:
                        self.paused = True
                        self.publish_snapshot()
                    return
                self.pending = self.stream.read_next()
            topic, data, record = self.pending
            if record > target:
                return
            self.pending = None
            self.position = record
            self.clock_pub.publish(Clock(clock=stamp(record)))
            if topic in self.points_pubs:
                cloud = deserialize_message(data, PointCloud2)
                self.last_cloud_stamp = ns(cloud.header.stamp)
                self.points_pubs[topic].publish(cloud)
                if time.monotonic() - self.last_snapshot_at > 1:
                    self.publish_snapshot()
            elif topic in self.tf_pubs:
                self.tf_pubs[topic].publish(deserialize_message(data, TFMessage))
            elif topic in self.static_topics:
                static, _ = self.index.snapshot(record, record)
                self.publish_static(static)

    def pause(self, request, response):
        self.paused = True
        # Refresh the latched snapshot for new viewers without changing the epoch
        # or clearing history in viewers that are already connected.
        self.publish_snapshot()
        return response

    def resume(self, request, response):
        self.reanchor()
        self.paused = False
        return response

    def is_paused(self, request, response):
        response.paused = self.paused
        return response

    def get_rate(self, request, response):
        response.rate = self.rate
        return response

    def set_rate(self, request, response):
        response.success = math.isfinite(request.rate) and 0 < request.rate <= 16
        if response.success:
            self.rate = request.rate
            self.reanchor()
        return response

    def set_loop(self, request, response):
        self.loop = request.data
        response.success = True
        response.message = "Loop enabled" if self.loop else "Loop disabled"
        return response

    def seek(self, request, response):
        destination = ns(request.time)
        response.success = self.begin <= destination < self.end and self.jump(destination)
        return response

    def destroy_node(self):
        self.index.close()
        return super().destroy_node()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bag")
    parser.add_argument("--points", nargs="+")
    parser.add_argument("--tf", nargs="+", default=["/tf"])
    parser.add_argument("--tf-static", nargs="+", default=["/tf_static"])
    parser.add_argument("--state-topic", default="/ros3d/replay_state")
    parser.add_argument("--start-paused", action="store_true")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--rate", type=float, default=1.0)
    args = parser.parse_args()
    if not math.isfinite(args.rate) or not 0 < args.rate <= 16:
        parser.error("rate must be in (0, 16]")
    rclpy.init()
    node = Replay(args)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, rclpy.executors.ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
