import { describe, expect, it } from "vitest";
import { MessageWriter as Ros2Writer } from "@foxglove/rosmsg2-serialization";
import { MessageWriter as Ros1Writer } from "@foxglove/rosmsg-serialization";
import { ros1, ros2jazzy } from "@foxglove/rosmsg-msgs-common";
import { buildRos1StaticDecoder, buildRos2StaticDecoder } from "./staticDefs";

describe("buildRos2StaticDecoder", () => {
  it("round-trips a geometry_msgs/Twist through CDR", async () => {
    const writer = new Ros2Writer([ros2jazzy["geometry_msgs/Twist"], ros2jazzy["geometry_msgs/Vector3"]]);
    const msg = { linear: { x: 1.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: -0.25 } };
    const decoder = await buildRos2StaticDecoder("geometry_msgs/msg/Twist");
    const out = decoder.decode(writer.writeMessage(msg)) as typeof msg;
    expect(out.linear.x).toBe(1.5);
    expect(out.angular.z).toBe(-0.25);
    expect(decoder.lastWarning?.()).toBeUndefined();
  });

  it("round-trips a sensor_msgs/Imu (transitive defs: Header, Quaternion, Vector3)", async () => {
    const writer = new Ros2Writer([
      ros2jazzy["sensor_msgs/Imu"],
      ros2jazzy["std_msgs/Header"],
      ros2jazzy["geometry_msgs/Quaternion"],
      ros2jazzy["geometry_msgs/Vector3"],
    ]);
    const msg = {
      header: { stamp: { sec: 7, nanosec: 13 }, frame_id: "imu_link" },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      orientation_covariance: new Array(9).fill(0),
      angular_velocity: { x: 0.5, y: 0, z: 0 },
      angular_velocity_covariance: new Array(9).fill(0),
      linear_acceleration: { x: 0, y: 0, z: 9.8125 },
      linear_acceleration_covariance: new Array(9).fill(-1),
    };
    const decoder = await buildRos2StaticDecoder("sensor_msgs/msg/Imu");
    const out = decoder.decode(writer.writeMessage(msg)) as Record<string, any>;
    expect(out.header.frame_id).toBe("imu_link");
    expect(out.header.stamp).toEqual({ sec: 7, nanosec: 13 });
    expect(out.angular_velocity.x).toBe(0.5);
    expect(out.linear_acceleration.z).toBe(9.8125);
    expect(Array.from(out.linear_acceleration_covariance)).toEqual(new Array(9).fill(-1));
  });

  it("rejects types missing from the bundle with a useful error", async () => {
    await expect(buildRos2StaticDecoder("novatel_oem7_msgs/msg/BESTPOS")).rejects.toThrow(
      /novatel_oem7_msgs\/BESTPOS is not in the bundled/,
    );
  });
});

describe("buildRos1StaticDecoder", () => {
  it("round-trips a geometry_msgs/Twist through ROS1 wire format", async () => {
    const writer = new Ros1Writer([ros1["geometry_msgs/Twist"], ros1["geometry_msgs/Vector3"]]);
    const msg = { linear: { x: 2.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0.125 } };
    const decoder = await buildRos1StaticDecoder("geometry_msgs/Twist");
    const out = decoder.decode(writer.writeMessage(msg)) as typeof msg;
    expect(out.linear.x).toBe(2.5);
    expect(out.angular.z).toBe(0.125);
  });
});
