import { describe, expect, it } from "vitest";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import { ServiceCallError } from "./errors";
import { srvCodecDefs, typeDescriptionToDefinitions, type FieldTypeMsg, type TypeDescriptionMsg } from "./typeDescription";

const ft = (overrides: Partial<FieldTypeMsg>): FieldTypeMsg => ({
  type_id: 0,
  capacity: 0,
  string_capacity: 0,
  nested_type_name: "",
  ...overrides,
});

const field = (name: string, type: FieldTypeMsg) => ({ name, type, default_value: "" });

// A fake vendor service exercising: nested msg, fixed array, bounded string, unbounded sequence.
const VENDOR_SRV: TypeDescriptionMsg = {
  type_description: {
    type_name: "vendor_msgs/srv/DoThing",
    fields: [
      field("request_message", ft({ type_id: 1, nested_type_name: "vendor_msgs/srv/DoThing_Request" })),
      field("response_message", ft({ type_id: 1, nested_type_name: "vendor_msgs/srv/DoThing_Response" })),
    ],
  },
  referenced_type_descriptions: [
    {
      type_name: "vendor_msgs/srv/DoThing_Request",
      fields: [
        field("status", ft({ type_id: 1, nested_type_name: "vendor_msgs/msg/VendorStatus" })),
        field("gains", ft({ type_id: 48 + 11, capacity: 3 })), // float64[3]
        field("mode", ft({ type_id: 21, string_capacity: 16 })), // string<=16
        field("ids", ft({ type_id: 144 + 6 })), // int32[] unbounded
      ],
    },
    {
      type_name: "vendor_msgs/srv/DoThing_Response",
      fields: [field("ok", ft({ type_id: 15 })), field("detail", ft({ type_id: 17 }))],
    },
    {
      type_name: "vendor_msgs/msg/VendorStatus",
      fields: [field("code", ft({ type_id: 3 })), field("stamp_ns", ft({ type_id: 8 }))],
    },
  ],
};

describe("typeDescriptionToDefinitions", () => {
  it("decomposes type_id into base + kind", () => {
    const defs = typeDescriptionToDefinitions(VENDOR_SRV);
    const request = defs.find((d) => d.name === "vendor_msgs/srv/DoThing_Request")!;
    expect(request.definitions).toEqual([
      { type: "vendor_msgs/msg/VendorStatus", name: "status", isComplex: true },
      { type: "float64", name: "gains", isArray: true, arrayLength: 3 },
      { type: "string", name: "mode", upperBound: 16 },
      { type: "int32", name: "ids", isArray: true },
    ]);
  });

  it("rejects unsupported wire types with the right error kind", () => {
    const bad: TypeDescriptionMsg = {
      type_description: {
        type_name: "vendor_msgs/msg/Bad",
        fields: [field("w", ft({ type_id: 18 }))], // WSTRING
      },
      referenced_type_descriptions: [],
    };
    try {
      typeDescriptionToDefinitions(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceCallError);
      expect((e as ServiceCallError).kind).toBe("unsupported-type");
    }
  });

  it("rejects an unset field type", () => {
    const bad: TypeDescriptionMsg = {
      type_description: { type_name: "vendor_msgs/msg/Bad", fields: [field("x", ft({ type_id: 0 }))] },
      referenced_type_descriptions: [],
    };
    expect(() => typeDescriptionToDefinitions(bad)).toThrow(/not set/);
  });
});

describe("srvCodecDefs", () => {
  it("builds request/response def lists that round-trip through writer+reader", () => {
    const { requestDefs, responseDefs } = srvCodecDefs(VENDOR_SRV);
    expect(requestDefs[0].name).toBe("vendor_msgs/srv/DoThing_Request");
    expect(responseDefs[0].name).toBe("vendor_msgs/srv/DoThing_Response");

    const request = {
      status: { code: 3, stamp_ns: 123456789n },
      gains: [0.5, 1.0, 2.0],
      mode: "auto",
      ids: [7, 8],
    };
    const decodedReq = new MessageReader(requestDefs).readMessage(new MessageWriter(requestDefs).writeMessage(request));
    expect(decodedReq).toMatchObject({ status: { code: 3 }, mode: "auto" });

    const response = { ok: true, detail: "done" };
    const decodedRes = new MessageReader(responseDefs).readMessage(
      new MessageWriter(responseDefs).writeMessage(response),
    );
    expect(decodedRes).toMatchObject(response);
  });

  it("fails type-unresolvable when the description lacks a request/response type", () => {
    const noResponse: TypeDescriptionMsg = {
      type_description: {
        type_name: "vendor_msgs/srv/DoThing",
        fields: [field("request_message", ft({ type_id: 1, nested_type_name: "vendor_msgs/srv/DoThing_Request" }))],
      },
      referenced_type_descriptions: [VENDOR_SRV.referenced_type_descriptions[0]],
    };
    try {
      srvCodecDefs(noResponse);
      expect.unreachable();
    } catch (e) {
      expect((e as ServiceCallError).kind).toBe("type-unresolvable");
    }
  });
});
