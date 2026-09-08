import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import { describe, expect, it } from "vitest";
import { fieldSpecs, fieldText, initialTexts, parseFieldText, zeroMessage } from "./fields";

// rosbag2_interfaces/srv/Resume request: a nested Time, an int32 with a default, a string.
const TIME: MessageDefinition = {
  name: "builtin_interfaces/msg/Time",
  definitions: [
    { type: "int32", name: "sec" },
    { type: "uint32", name: "nanosec" },
  ],
};
const RESUME_REQ: MessageDefinition = {
  name: "rosbag2_interfaces/srv/Resume_Request",
  definitions: [
    { type: "builtin_interfaces/msg/Time", name: "resume_time", isComplex: true },
    { type: "int32", name: "resume_mode", defaultValue: 0 },
    { type: "string", name: "tracking_topic_name" },
    { type: "int32", name: "NOW", isConstant: true, value: 0, valueText: "0" },
  ],
};
const KITCHEN: MessageDefinition = {
  name: "test/srv/Kitchen_Request",
  definitions: [
    { type: "bool", name: "enable", defaultValue: true },
    { type: "float64", name: "gain" },
    { type: "int64", name: "stamp_ns" },
    { type: "float32", name: "matrix", isArray: true, arrayLength: 2 },
    { type: "string", name: "names", isArray: true },
    { type: "uint8", name: "data", isArray: true },
  ],
};

describe("fieldSpecs", () => {
  it("flattens the root request into editable fields: kinds, 64-bit flag, nested zero values, declared defaults; constants skipped", () => {
    const specs = fieldSpecs([RESUME_REQ, TIME]);
    expect(specs.map((s) => [s.name, s.type, s.kind, s.big])).toEqual([
      ["resume_time", "builtin_interfaces/msg/Time", "json", false],
      ["resume_mode", "int32", "int", false],
      ["tracking_topic_name", "string", "string", false],
    ]);
    expect(specs[0].initial).toEqual({ sec: 0, nanosec: 0 });
    const k = fieldSpecs([KITCHEN]);
    expect(k.map((s) => [s.name, s.type, s.kind, s.big, s.initial])).toEqual([
      ["enable", "bool", "bool", false, true],
      ["gain", "float64", "float", false, 0],
      ["stamp_ns", "int64", "int", true, 0n],
      ["matrix", "float32[2]", "json", false, [0, 0]],
      ["names", "string[]", "json", false, []],
      ["data", "uint8[]", "json", false, []],
    ]);
    expect(fieldSpecs([])).toEqual([]);
    // an empty request (Trigger, Pause, IsPaused) carries rosidl's placeholder byte: not a form field
    expect(fieldSpecs([{ name: "std_srvs/srv/Trigger_Request", definitions: [{ type: "uint8", name: "structure_needs_at_least_one_member" }] }])).toEqual([]);
    expect(zeroMessage(RESUME_REQ, [RESUME_REQ, TIME])).toEqual({ resume_time: { sec: 0, nanosec: 0 }, resume_mode: 0, tracking_topic_name: "" });
  });

  it("initial texts: config request defaults win over zero values, rendered as input text", () => {
    const specs = fieldSpecs([RESUME_REQ, TIME]);
    expect(initialTexts(specs)).toEqual({ resume_time: '{"sec":0,"nanosec":0}', resume_mode: "0", tracking_topic_name: "" });
    expect(initialTexts(specs, { resume_mode: 1, tracking_topic_name: "/rosout" })).toMatchObject({ resume_mode: "1", tracking_topic_name: "/rosout" });
    expect(fieldText(fieldSpecs([KITCHEN])[2], 12345678901234567890n)).toBe("12345678901234567890");
  });
});

describe("parseFieldText", () => {
  it("parses each kind back into what the CDR writer expects — and the writer accepts it", () => {
    const [enable, gain, stamp, matrix, names, data] = fieldSpecs([KITCHEN]);
    const request = {
      enable: parseFieldText(enable, "false"),
      gain: parseFieldText(gain, "0.5"),
      stamp_ns: parseFieldText(stamp, "12345678901234567890"),
      matrix: parseFieldText(matrix, "[1.5, 2]"),
      names: parseFieldText(names, '["a", "b"]'),
      data: parseFieldText(data, ""), // empty = the initial value
    };
    expect(request).toEqual({ enable: false, gain: 0.5, stamp_ns: 12345678901234567890n, matrix: [1.5, 2], names: ["a", "b"], data: [] });
    expect(() => new MessageWriter([KITCHEN]).writeMessage(request)).not.toThrow();
    expect(parseFieldText(enable, "1")).toBe(true);
    expect(parseFieldText(gain, "")).toBe(0);
    expect(parseFieldText(fieldSpecs([RESUME_REQ, TIME])[2], "  /rosout ")).toBe("  /rosout ");
  });

  it("rejects what the type cannot take, naming the field and the type", () => {
    const [enable, gain, stamp, matrix] = fieldSpecs([KITCHEN]);
    expect(() => parseFieldText(enable, "yes")).toThrow(/enable: true or false/);
    expect(() => parseFieldText(gain, "fast")).toThrow(/gain: a number \(float64\)/);
    expect(() => parseFieldText(stamp, "1.5")).toThrow(/stamp_ns: an integer \(int64\)/);
    expect(() => parseFieldText(matrix, "[1,")).toThrow(/matrix: JSON for float32\[2\]/);
  });
});
