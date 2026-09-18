import { describe, expect, it } from "vitest";
import { buildGraph, parseLivelinessToken } from "../ros/graph";
import { findTypeDescriptionServer, pickServer, serviceQueryKeyexpr } from "./keyexpr";

const ZID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ZID2 = "ffffc3d4e5f60718293a4b5c6d7e8f90";
const HASH = "RIHS01_df668c740482bbd48fb39d76a70dfd4bd59db1288021743503259e948f6b1a18";
const QOS = "::,10:,:,:,:";

const SRV = `@ros2_lv/0/${ZID}/3/22/SS/%/%/recorder/%recorder%start/vendor_msgs::srv::dds_::StartRecording_/${HASH}/${QOS}`;
const SRV_D1 = `@ros2_lv/1/${ZID2}/3/22/SS/%/%/recorder/%recorder%start/vendor_msgs::srv::dds_::StartRecording_/${HASH}/${QOS}`;
const GTD = `@ros2_lv/0/${ZID}/3/23/SS/%/%/recorder/%recorder%get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH}/${QOS}`;
const GTD_OTHER = `@ros2_lv/0/${ZID2}/9/23/SS/%/%/other/%other%get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH}/${QOS}`;

describe("serviceQueryKeyexpr", () => {
  it("builds <domain>/<name minus edge slashes>/<dds type>/<hash> with inner slashes literal", () => {
    const server = parseLivelinessToken(SRV)!;
    expect(serviceQueryKeyexpr(server)).toBe(
      `0/recorder/start/vendor_msgs::srv::dds_::StartRecording_/${HASH}`,
    );
  });

  it("throws on an entity with no service info", () => {
    const node = parseLivelinessToken(`@ros2_lv/0/${ZID}/3/0/NN/%/%/recorder`)!;
    expect(() => serviceQueryKeyexpr(node)).toThrow(/no service info/);
  });
});

describe("pickServer", () => {
  // buildGraph keys services per-domain: the same name in two domains yields TWO entries.
  const graph = buildGraph([SRV, SRV_D1]);

  it("filters within an entry by the requested domain", () => {
    const entries = graph.services.filter((s) => s.name === "/recorder/start");
    expect(entries).toHaveLength(2);
    const d1 = entries.find((e) => e.servers[0].domainId === 1)!;
    expect(pickServer(d1, 1)?.domainId).toBe(1);
    expect(pickServer(d1, 7)).toBeUndefined();
    expect(pickServer(d1)).toBeDefined();
  });
});

describe("findTypeDescriptionServer", () => {
  const graph = buildGraph([SRV, GTD, GTD_OTHER]);

  it("finds ~/get_type_description on the SAME node instance (zid+nid)", () => {
    const server = graph.services.find((s) => s.name === "/recorder/start")!.servers[0];
    const gtd = findTypeDescriptionServer(graph, server);
    expect(gtd?.zid).toBe(ZID);
    expect(gtd?.topic?.name).toBe("/recorder/get_type_description");
  });

  it("returns undefined when the node has no gtd service", () => {
    const graphNoGtd = buildGraph([SRV]);
    const server = graphNoGtd.services[0].servers[0];
    expect(findTypeDescriptionServer(graphNoGtd, server)).toBeUndefined();
  });
});
