import { describe, expect, it } from "vitest";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import { buildGraph } from "../../ros/graph";
import type { GetReply, Transport } from "../../transport/types";
import { decodeAttachment, encodeAttachment } from "../../services/attachment";
import { GET_TYPE_DESCRIPTION_SRV } from "../../services/srvDefs";
import { FlavorResolver } from "../resolver";
import { typeHolders } from "./described";

const ZID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH = "RIHS01_4444444444444444444444444444444444444444444444444444444444444444";
const HASH_GTD = "RIHS01_3333333333333333333333333333333333333333333333333333333333333333";
const QOS = "::,10:,:,:,:";
const PUB = `@ros2_lv/1/${ZID}/4/30/MP/%/%/ins_driver/%ins%status/vendor_msgs::msg::dds_::Status_/${HASH}/${QOS}`;
const GTD = `@ros2_lv/1/${ZID}/4/31/SS/%/%/ins_driver/%ins_driver%get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH_GTD}/${QOS}`;
const GTD_KEY = `1/ins_driver/get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH_GTD}`;

const ft = (type_id: number, nested = "") => ({ type_id, capacity: 0n, string_capacity: 0n, nested_type_name: nested });
const DESCRIPTION = {
  type_description: {
    type_name: "vendor_msgs/msg/Status",
    fields: [
      { name: "mode", type: ft(3), default_value: "" },
      { name: "valid", type: ft(15), default_value: "" },
      { name: "fix", type: ft(1, "vendor_msgs/msg/Fix"), default_value: "" },
    ],
  },
  referenced_type_descriptions: [
    { type_name: "vendor_msgs/msg/Fix", fields: [{ name: "lat", type: ft(11), default_value: "" }] },
  ],
};
const STATUS_DEFS = [
  { name: "vendor_msgs/msg/Status", definitions: [
    { type: "uint8", name: "mode" }, { type: "bool", name: "valid" },
    { type: "vendor_msgs/msg/Fix", name: "fix", isComplex: true },
  ] },
  { name: "vendor_msgs/msg/Fix", definitions: [{ type: "float64", name: "lat" }] },
];

/** A transport whose only service is the publisher node's ~/get_type_description. */
function gtdTransport(calls: string[]): Transport {
  const reader = new MessageReader(GET_TYPE_DESCRIPTION_SRV.requestDefs);
  const writer = new MessageWriter(GET_TYPE_DESCRIPTION_SRV.responseDefs);
  return {
    subscribe: () => Promise.resolve({ close: () => Promise.resolve() }),
    get: async (keyexpr, opts): Promise<GetReply[]> => {
      calls.push(keyexpr);
      if (keyexpr !== GTD_KEY || !opts?.payload || !opts.attachment) return [];
      const a = decodeAttachment(opts.attachment);
      const req = reader.readMessage(opts.payload) as { type_name: string; type_hash: string };
      const ok = req.type_name === "vendor_msgs/msg/Status" && req.type_hash === HASH;
      const response = { successful: ok, failure_reason: ok ? "" : "unknown type", type_description: ok ? DESCRIPTION : { type_description: { type_name: "", fields: [] }, referenced_type_descriptions: [] }, type_sources: [], extra_information: [] };
      return [{ keyexpr, payload: writer.writeMessage(response), attachment: encodeAttachment(a) }];
    },
    liveliness: { subscribe: () => Promise.resolve({ close: () => Promise.resolve() }), get: () => Promise.resolve([]) },
    close: () => Promise.resolve(),
  };
}

describe("types outside the bundle", () => {
  const graph = buildGraph([PUB, GTD]);
  const id = { flavor: "ros2" as const, typeName: "vendor_msgs/msg/Status", rihsHash: HASH };

  it("decode with the description a publishing node returns, fetched once", async () => {
    const calls: string[] = [];
    const resolver = new FlavorResolver(gtdTransport(calls), { graph: () => graph });
    const decoder = await resolver.resolve(id);
    const bytes = new MessageWriter(STATUS_DEFS).writeMessage({ mode: 4, valid: true, fix: { lat: 40.44 } });
    expect(decoder.decode(bytes)).toEqual({ mode: 4, valid: true, fix: { lat: 40.44 } });
    expect(decoder.lastWarning?.()).toBeUndefined();
    await resolver.resolve(id);
    expect(calls).toEqual([GTD_KEY]);
  });

  it("stay undecodable without the live graph, as before", async () => {
    await expect(new FlavorResolver(gtdTransport([])).resolve(id)).rejects.toThrow(/not in the bundled message definitions/);
  });

  it("say why when no node using the type can describe it", async () => {
    const resolver = new FlavorResolver(gtdTransport([]), { graph: () => buildGraph([PUB]) });
    await expect(resolver.resolve(id)).rejects.toThrow(/vendor_msgs\/msg\/Status is not bundled; node \/ins_driver does not expose ~\/get_type_description/);
    const empty = new FlavorResolver(gtdTransport([]), { graph: () => buildGraph([]) });
    await expect(empty.resolve(id)).rejects.toThrow(/no node using it is in the graph yet/);
  });

  it("ask publishers before subscribers, one entity per node", () => {
    const sub = PUB.replace("/4/30/MP/", "/5/40/MS/").replace(ZID, "f".repeat(32)).replace("ins_driver", "logger");
    const holders = typeHolders(buildGraph([sub, PUB]), id.typeName, HASH);
    expect(holders.map((h) => `${h.kind} ${h.nodeFq}`)).toEqual(["MP /ins_driver", "MS /logger"]);
  });
});
