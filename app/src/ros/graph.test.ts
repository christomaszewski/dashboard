import { describe, expect, it } from "vitest";
import { buildGraph, parseLivelinessToken } from "./graph";

// Token fixtures shaped per rmw_zenoh jazzy liveliness_utils.cpp:
//   @ros2_lv/<domain>/<zid>/<nid>/<eid>/<kind>/<enclave>/<ns>/<node>[/<topic>/<type>/<hash>/<qos>]
// with '/' mangled to '%' and qos = rel:dur:hist,depth:deadline:lifespan:liveliness (empty = default).
const ZID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH = "RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18";
const QOS_DEFAULT = "::,10:,:,:,:";
const QOS_TL = ":1:,1:,:,:,:"; // transient_local, depth 1 (e.g. /tf_static)
const QOS_BE = "2::,5:,:,:,:"; // best_effort, depth 5 (sensor data profile)

const NODE = `@ros2_lv/0/${ZID}/0/0/NN/%/%/talker`;
const NODE_LISTENER = `@ros2_lv/0/${ZID}/1/0/NN/%/%/listener`;
const NODE_NS = `@ros2_lv/0/${ZID}/2/0/NN/%/%veh/imu_node`;
const PUB = `@ros2_lv/0/${ZID}/0/10/MP/%/%/talker/%chatter/std_msgs::msg::dds_::String_/${HASH}/${QOS_DEFAULT}`;
const SUB = `@ros2_lv/0/${ZID}/1/11/MS/%/%/listener/%chatter/std_msgs::msg::dds_::String_/${HASH}/${QOS_DEFAULT}`;
const PUB_NS = `@ros2_lv/0/${ZID}/2/12/MP/%/%veh/imu_node/%veh%imu%data/sensor_msgs::msg::dds_::Imu_/${HASH}/${QOS_BE}`;
const PUB_TL = `@ros2_lv/0/${ZID}/2/13/MP/%/%/static_tf/%tf_static/tf2_msgs::msg::dds_::TFMessage_/${HASH}/${QOS_TL}`;
const SRV = `@ros2_lv/0/${ZID}/0/22/SS/%/%/talker/%talker%describe_parameters/rcl_interfaces::srv::dds_::DescribeParameters_/${HASH}/${QOS_DEFAULT}`;

describe("parseLivelinessToken", () => {
  it("parses a node token", () => {
    const e = parseLivelinessToken(NODE);
    expect(e).toMatchObject({ kind: "NN", domainId: 0, zid: ZID, namespace: "/", nodeName: "talker", nodeFq: "/talker" });
    expect(e?.topic).toBeUndefined();
  });

  it("parses a publisher token with topic info and default QoS", () => {
    const e = parseLivelinessToken(PUB);
    expect(e?.kind).toBe("MP");
    expect(e?.topic).toMatchObject({
      name: "/chatter",
      typeDds: "std_msgs::msg::dds_::String_",
      typeHash: HASH,
      qos: { reliability: "reliable", durability: "volatile", depth: 10 },
    });
  });

  it("demangles namespaced nodes and topics", () => {
    const e = parseLivelinessToken(PUB_NS);
    expect(e?.nodeFq).toBe("/veh/imu_node");
    expect(e?.topic?.name).toBe("/veh/imu/data");
    expect(e?.topic?.qos.reliability).toBe("best_effort");
    expect(e?.topic?.qos.depth).toBe(5);
  });

  it("decodes transient_local durability", () => {
    expect(parseLivelinessToken(PUB_TL)?.topic?.qos.durability).toBe("transient_local");
  });

  it("rejects non-graph keyexprs and malformed tokens", () => {
    expect(parseLivelinessToken("fleet/veh1/media/cam0")).toBeNull();
    expect(parseLivelinessToken("@ros2_lv/0/zid/0/0/XX/%/%/n")).toBeNull(); // bad kind
    expect(parseLivelinessToken(`@ros2_lv/0/${ZID}/0/0/NN/%/%`)).toBeNull(); // 8 parts
    expect(parseLivelinessToken(`@ros2_lv/0/${ZID}/0/10/MP/%/%/talker`)).toBeNull(); // MP without topic info
  });
});

describe("buildGraph", () => {
  const graph = buildGraph([NODE, NODE_LISTENER, NODE_NS, PUB, SUB, PUB_NS, PUB_TL, SRV, "some/other/key"]);

  it("aggregates pub+sub of the same topic into one entry", () => {
    const chatter = graph.topics.find((t) => t.name === "/chatter");
    expect(chatter?.publishers).toHaveLength(1);
    expect(chatter?.subscribers).toHaveLength(1);
    expect(chatter?.typeName).toBe("std_msgs/msg/String");
  });

  it("builds the rmw_zenoh data keyexpr (topic minus leading slash)", () => {
    expect(graph.topics.find((t) => t.name === "/chatter")?.dataKeyexpr).toBe(
      `0/chatter/std_msgs::msg::dds_::String_/${HASH}`,
    );
    expect(graph.topics.find((t) => t.name === "/veh/imu/data")?.dataKeyexpr).toBe(
      `0/veh/imu/data/sensor_msgs::msg::dds_::Imu_/${HASH}`,
    );
  });

  it("flags QoS that changes consumer behavior", () => {
    expect(graph.topics.find((t) => t.name === "/tf_static")?.transientLocal).toBe(true);
    expect(graph.topics.find((t) => t.name === "/veh/imu/data")?.bestEffort).toBe(true);
    expect(graph.topics.find((t) => t.name === "/chatter")?.transientLocal).toBe(false);
  });

  it("collects nodes, services, domains; ignores foreign keys", () => {
    expect(graph.nodes.map((n) => n.nodeFq)).toEqual(["/listener", "/talker", "/veh/imu_node"]);
    expect(graph.services).toHaveLength(1);
    expect(graph.services[0]).toMatchObject({ name: "/talker/describe_parameters" });
    expect(graph.services[0].servers).toHaveLength(1);
    expect(graph.domains).toEqual([0]);
    expect(graph.tokenCount).toBe(8);
  });
});
