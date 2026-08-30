import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";
import { buildGraph } from "../ros/graph";
import { decodeAttachment, encodeAttachment, type RmwAttachment } from "./attachment";
import { GET_TYPE_DESCRIPTION_SRV, STATIC_SRVS } from "./srvDefs";
import { callService, ServiceCallError } from "./callService";

const ZID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH_TRIGGER = "RIHS01_1111111111111111111111111111111111111111111111111111111111111111";
const HASH_VENDOR = "RIHS01_2222222222222222222222222222222222222222222222222222222222222222";
const HASH_GTD = "RIHS01_3333333333333333333333333333333333333333333333333333333333333333";
const QOS = "::,10:,:,:,:";

const TOKENS = [
  `@ros2_lv/0/${ZID}/3/22/SS/%/%/recorder/%recorder%start/std_srvs::srv::dds_::Trigger_/${HASH_TRIGGER}/${QOS}`,
  `@ros2_lv/0/${ZID}/4/30/SS/%/%/vendor_node/%vendor%do_thing/vendor_msgs::srv::dds_::DoThing_/${HASH_VENDOR}/${QOS}`,
  `@ros2_lv/0/${ZID}/4/31/SS/%/%/vendor_node/%vendor_node%get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH_GTD}/${QOS}`,
];
const GRAPH = buildGraph(TOKENS);

const TRIGGER_KEY = `0/recorder/start/std_srvs::srv::dds_::Trigger_/${HASH_TRIGGER}`;
const VENDOR_KEY = `0/vendor/do_thing/vendor_msgs::srv::dds_::DoThing_/${HASH_VENDOR}`;
const GTD_KEY = `0/vendor_node/get_type_description/type_description_interfaces::srv::dds_::GetTypeDescription_/${HASH_GTD}`;

// The vendor srv description a fake ~/get_type_description serves back.
const ft = (type_id: number, nested = "") => ({ type_id, capacity: 0n, string_capacity: 0n, nested_type_name: nested });
const VENDOR_DESCRIPTION = {
  type_description: {
    type_name: "vendor_msgs/srv/DoThing",
    fields: [
      { name: "request_message", type: ft(1, "vendor_msgs/srv/DoThing_Request"), default_value: "" },
      { name: "response_message", type: ft(1, "vendor_msgs/srv/DoThing_Response"), default_value: "" },
    ],
  },
  referenced_type_descriptions: [
    {
      type_name: "vendor_msgs/srv/DoThing_Request",
      fields: [{ name: "count", type: ft(7), default_value: "" }],
    },
    {
      type_name: "vendor_msgs/srv/DoThing_Response",
      fields: [
        { name: "ok", type: ft(15), default_value: "" },
        { name: "detail", type: ft(17), default_value: "" },
      ],
    },
  ],
};

type Handler = (payload: Uint8Array, attachment: RmwAttachment, opts: TransportGetOptions) => GetReply[] | "hang";

/** A fake rmw service server: dispatches gets by keyexpr, validating the client attachment. */
function stubTransport(handlers: Record<string, Handler>) {
  const seen: { keyexpr: string; attachment: RmwAttachment; opts: TransportGetOptions }[] = [];
  const transport: Transport = {
    subscribe: () => Promise.resolve({ close: () => Promise.resolve() }),
    get: (keyexpr, opts) => {
      if (!opts?.payload || !opts.attachment) throw new Error("service query without payload/attachment");
      const attachment = decodeAttachment(opts.attachment); // throws on malformed, like rmw_zenoh
      seen.push({ keyexpr, attachment, opts });
      const handler = handlers[keyexpr];
      if (!handler) return Promise.resolve([]);
      const result = handler(opts.payload, attachment, opts);
      if (result === "hang") {
        vi.advanceTimersByTime(opts.timeoutMs ?? 10_000); // query runs to its timeout, zero replies
        return Promise.resolve([]);
      }
      return Promise.resolve(result);
    },
    liveliness: {
      subscribe: () => Promise.resolve({ close: () => Promise.resolve() }),
      get: () => Promise.resolve([]),
    },
    close: () => Promise.resolve(),
  };
  return { transport, seen };
}

const echo = (a: RmwAttachment) =>
  encodeAttachment({ sequenceNumber: a.sequenceNumber, sourceTimestamp: a.sourceTimestamp, gid: a.gid });

function triggerHandler(success = true): Handler {
  const writer = new MessageWriter(STATIC_SRVS["std_srvs/srv/Trigger"].responseDefs);
  return (_payload, attachment) => [
    { keyexpr: TRIGGER_KEY, payload: writer.writeMessage({ success, message: "started" }), attachment: echo(attachment) },
  ];
}

function gtdHandler(calls: { count: number }): Handler {
  const reader = new MessageReader(GET_TYPE_DESCRIPTION_SRV.requestDefs);
  const writer = new MessageWriter(GET_TYPE_DESCRIPTION_SRV.responseDefs);
  return (payload, attachment) => {
    calls.count += 1;
    const req = reader.readMessage(payload) as { type_name: string; type_hash: string };
    expect(req.type_name).toBe("vendor_msgs/srv/DoThing");
    expect(req.type_hash).toBe(HASH_VENDOR);
    const response = {
      successful: true,
      failure_reason: "",
      type_description: VENDOR_DESCRIPTION,
      type_sources: [],
      extra_information: [],
    };
    return [{ keyexpr: GTD_KEY, payload: writer.writeMessage(response), attachment: echo(attachment) }];
  };
}

function vendorHandler(): Handler {
  const reqDefs = [
    { name: "vendor_msgs/srv/DoThing_Request", definitions: [{ type: "uint32", name: "count" }] },
  ];
  const resDefs = [
    {
      name: "vendor_msgs/srv/DoThing_Response",
      definitions: [
        { type: "bool", name: "ok" },
        { type: "string", name: "detail" },
      ],
    },
  ];
  const reader = new MessageReader(reqDefs);
  const writer = new MessageWriter(resDefs);
  return (payload, attachment) => {
    const req = reader.readMessage(payload) as { count: number };
    return [
      { keyexpr: VENDOR_KEY, payload: writer.writeMessage({ ok: true, detail: `count=${req.count}` }), attachment: echo(attachment) },
    ];
  };
}

describe("callService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls a statically-bundled service end to end, dialing the right keyexpr", async () => {
    const { transport, seen } = stubTransport({ [TRIGGER_KEY]: triggerHandler() });
    const result = await callService(transport, GRAPH, "/recorder/start", {});
    expect(result.response).toMatchObject({ success: true, message: "started" });
    expect(result.serverKeyexpr).toBe(TRIGGER_KEY);
    expect(result.warning).toBeUndefined();
    expect(seen[0].opts).toMatchObject({ target: "all-complete", consolidation: "none", timeoutMs: 5000 });
  });

  it("sends a well-formed rmw attachment with monotonic sequence numbers and a stable gid", async () => {
    const { transport, seen } = stubTransport({ [TRIGGER_KEY]: triggerHandler() });
    await callService(transport, GRAPH, "/recorder/start", {});
    await callService(transport, GRAPH, "/recorder/start", {});
    expect(seen).toHaveLength(2);
    expect(seen[1].attachment.sequenceNumber).toBe(seen[0].attachment.sequenceNumber + 1n);
    expect(seen[1].attachment.gid).toEqual(seen[0].attachment.gid);
    expect(seen[0].attachment.gid).toHaveLength(16);
  });

  it("resolves a vendor type dynamically via the serving node's ~/get_type_description, then caches it", async () => {
    const gtdCalls = { count: 0 };
    const { transport, seen } = stubTransport({
      [GTD_KEY]: gtdHandler(gtdCalls),
      [VENDOR_KEY]: vendorHandler(),
    });
    const r1 = await callService(transport, GRAPH, "/vendor/do_thing", { count: 41 });
    expect(r1.response).toMatchObject({ ok: true, detail: "count=41" });
    expect(gtdCalls.count).toBe(1);
    const r2 = await callService(transport, GRAPH, "/vendor/do_thing", { count: 42 });
    expect(r2.response).toMatchObject({ detail: "count=42" });
    expect(gtdCalls.count).toBe(1); // codec cached by RIHS — no second gtd round-trip
    expect(seen.filter((s) => s.keyexpr === VENDOR_KEY)).toHaveLength(2);
  });

  it("no-server: a name the graph does not advertise", async () => {
    const { transport } = stubTransport({});
    await expect(callService(transport, GRAPH, "/nope", {})).rejects.toMatchObject({ kind: "no-server" });
  });

  it("timeout vs no-reply are distinguished by elapsed time", async () => {
    const { transport } = stubTransport({ [TRIGGER_KEY]: () => "hang" });
    await expect(callService(transport, GRAPH, "/recorder/start", {}, { timeoutMs: 2000 })).rejects.toMatchObject({
      kind: "timeout",
    });
    const { transport: t2 } = stubTransport({ [TRIGGER_KEY]: () => [] });
    await expect(callService(t2, GRAPH, "/recorder/start", {})).rejects.toMatchObject({ kind: "no-reply" });
  });

  it("reply-error carries the zenoh error payload", async () => {
    const { transport } = stubTransport({});
    transport.get = (_k, opts) => {
      opts?.onReplyError?.("queryable rejected the request");
      return Promise.resolve([]);
    };
    await expect(callService(transport, GRAPH, "/recorder/start", {})).rejects.toMatchObject({
      kind: "reply-error",
      message: "queryable rejected the request",
    });
  });

  it("decode-failed on a garbage reply payload", async () => {
    const { transport } = stubTransport({
      [TRIGGER_KEY]: (_p, a) => [{ keyexpr: TRIGGER_KEY, payload: new Uint8Array([1, 2]), attachment: echo(a) }],
    });
    await expect(callService(transport, GRAPH, "/recorder/start", {})).rejects.toMatchObject({ kind: "decode-failed" });
  });

  it("warns (does not fail) on a reply sequence mismatch", async () => {
    const writer = new MessageWriter(STATIC_SRVS["std_srvs/srv/Trigger"].responseDefs);
    const { transport } = stubTransport({
      [TRIGGER_KEY]: (_p, a) => [
        {
          keyexpr: TRIGGER_KEY,
          payload: writer.writeMessage({ success: true, message: "" }),
          attachment: encodeAttachment({ sequenceNumber: a.sequenceNumber + 99n, sourceTimestamp: 0n, gid: a.gid }),
        },
      ],
    });
    const result = await callService(transport, GRAPH, "/recorder/start", {});
    expect(result.response).toMatchObject({ success: true });
    expect(result.warning).toMatch(/sequence/);
  });

  it("errors thrown are ServiceCallError instances", async () => {
    const { transport } = stubTransport({});
    const err = await callService(transport, GRAPH, "/nope", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceCallError);
  });
});
