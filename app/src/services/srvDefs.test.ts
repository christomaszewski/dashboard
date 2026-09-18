import { describe, expect, it } from "vitest";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import { GET_TYPE_DESCRIPTION_SRV, STATIC_SRVS } from "./srvDefs";

describe("bundled GetTypeDescription schema", () => {
  it("round-trips the request", () => {
    const writer = new MessageWriter(GET_TYPE_DESCRIPTION_SRV.requestDefs);
    const reader = new MessageReader(GET_TYPE_DESCRIPTION_SRV.requestDefs);
    const req = { type_name: "vendor_msgs/srv/DoThing", type_hash: "RIHS01_ab", include_type_sources: false };
    expect(reader.readMessage(writer.writeMessage(req))).toMatchObject(req);
  });

  it("round-trips a response with a nested type description", () => {
    const writer = new MessageWriter(GET_TYPE_DESCRIPTION_SRV.responseDefs);
    const reader = new MessageReader(GET_TYPE_DESCRIPTION_SRV.responseDefs);
    const response = {
      successful: true,
      failure_reason: "",
      type_description: {
        type_description: {
          type_name: "vendor_msgs/srv/DoThing",
          fields: [
            {
              name: "request_message",
              type: { type_id: 1, capacity: 0n, string_capacity: 0n, nested_type_name: "vendor_msgs/srv/DoThing_Request" },
              default_value: "",
            },
          ],
        },
        referenced_type_descriptions: [
          {
            type_name: "vendor_msgs/srv/DoThing_Request",
            fields: [
              { name: "count", type: { type_id: 7, capacity: 0n, string_capacity: 0n, nested_type_name: "" }, default_value: "" },
            ],
          },
        ],
      },
      type_sources: [],
      extra_information: [{ key: "k", value: "v" }],
    };
    expect(reader.readMessage(writer.writeMessage(response))).toMatchObject({
      successful: true,
      type_description: {
        type_description: { type_name: "vendor_msgs/srv/DoThing" },
        referenced_type_descriptions: [{ type_name: "vendor_msgs/srv/DoThing_Request" }],
      },
    });
  });
});

describe("bundled std_srvs", () => {
  it("an empty request encodes as the CDR placeholder byte", () => {
    const writer = new MessageWriter(STATIC_SRVS["std_srvs/srv/Trigger"].requestDefs);
    const bytes = writer.writeMessage({});
    expect(bytes).toHaveLength(5); // 4-byte encapsulation header + structure_needs_at_least_one_member
  });

  it("round-trips Trigger and SetBool", () => {
    const trigger = STATIC_SRVS["std_srvs/srv/Trigger"];
    const tw = new MessageWriter(trigger.responseDefs);
    const tr = new MessageReader(trigger.responseDefs);
    expect(tr.readMessage(tw.writeMessage({ success: true, message: "recording" }))).toMatchObject({
      success: true,
      message: "recording",
    });

    const setBool = STATIC_SRVS["std_srvs/srv/SetBool"];
    const sw = new MessageWriter(setBool.requestDefs);
    const sr = new MessageReader(setBool.requestDefs);
    expect(sr.readMessage(sw.writeMessage({ data: true }))).toMatchObject({ data: true });
  });
});
