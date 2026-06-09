import { describe, expect, it } from "vitest";
import { parseKey, parseRos1Key, parseRos2Key } from "./keyParser";

// Real-shaped rmw_zenoh fixtures: <domain>/<topic minus leading slash>/<dds type>/<RIHS01_64hex>.
const HASH = "RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18";
const CHATTER = `0/chatter/std_msgs::msg::dds_::String_/${HASH}`;
const NESTED = `42/turtle1/cmd_vel/geometry_msgs::msg::dds_::Twist_/${HASH}`;

describe("parseRos2Key", () => {
  it("parses a root-level topic", () => {
    expect(parseRos2Key(CHATTER)).toEqual({
      topicName: "/chatter",
      identity: { flavor: "ros2", typeName: "std_msgs/msg/String", rihsHash: HASH },
    });
  });

  it("parses a namespaced topic (multi-segment) and non-zero domain", () => {
    expect(parseRos2Key(NESTED)).toEqual({
      topicName: "/turtle1/cmd_vel",
      identity: { flavor: "ros2", typeName: "geometry_msgs/msg/Twist", rihsHash: HASH },
    });
  });

  it("rejects non-ROS2 keys", () => {
    expect(parseRos2Key("fleet/veh1/media/cam0")).toBeNull();
    expect(parseRos2Key(`x/chatter/std_msgs::msg::dds_::String_/${HASH}`)).toBeNull(); // domain not numeric
    expect(parseRos2Key("0/chatter/std_msgs::msg::dds_::String_/RIHS01_beef")).toBeNull(); // short hash
    expect(parseRos2Key(`0/chatter/notatype/${HASH}`)).toBeNull(); // type not DDS-mangled
  });
});

describe("parseKey precedence", () => {
  const ros1Type = "std_msgs/String"; // hex-encodes with a letter ('/' = 2f), so it can't look like a domain id
  const ros1Hex = Array.from(new TextEncoder().encode(ros1Type), (b) => b.toString(16).padStart(2, "0")).join("");
  const ros1Key = `${ros1Hex}/992ce8a1687cec8c8bd883ec73ca41d1/ros1_bridge/chatter`;

  it("still parses ros1 bridge keys", () => {
    expect(parseRos1Key(ros1Key)).toEqual({
      topicName: "/chatter",
      identity: { flavor: "ros1", typeName: "std_msgs/String", md5: "992ce8a1687cec8c8bd883ec73ca41d1" },
    });
    expect(parseKey(ros1Key).identity.flavor).toBe("ros1");
  });

  it("routes ros2 keys to ros2 and unknown keys to unknown", () => {
    expect(parseKey(CHATTER).identity.flavor).toBe("ros2");
    expect(parseKey("fleet/veh1/media/cam0")).toEqual({
      topicName: "fleet/veh1/media/cam0",
      identity: { flavor: "unknown" },
    });
  });
});
