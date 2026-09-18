import { describe, expect, it } from "vitest";
import type { GetReply, Transport } from "../transport/types";
import { TransportError } from "../transport/reconnecting";
import { buildGraph } from "../ros/graph";
import { callService, ServiceCallError } from "./callService";

const ZID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH = "RIHS01_1111111111111111111111111111111111111111111111111111111111111111";
const GRAPH = buildGraph([`@ros2_lv/0/${ZID}/3/22/SS/%/%/recorder/%recorder%start/std_srvs::srv::dds_::Trigger_/${HASH}/::,10:,:,:,:`]);

/** A transport whose every query fails the way a bad link makes it fail. */
function failing(err: unknown): Transport {
  return {
    subscribe: async () => ({ close: async () => undefined }),
    get: async (): Promise<GetReply[]> => {
      throw err;
    },
    liveliness: { subscribe: async () => ({ close: async () => undefined }), get: async () => [] },
    close: async () => undefined,
  };
}

describe("callService over a lost link", () => {
  // The bad-wireless-link case: before this, a query sent into a dead WebSocket never came back and
  // the button stayed "calling…" forever. The transport now refuses or fails it; the call names it.
  it("a refused or dropped query is a 'disconnected' call error, a client deadline a 'timeout'", async () => {
    const down = callService(failing(new TransportError("disconnected", "link reconnecting: probe lost")), GRAPH, "/recorder/start", {});
    await expect(down).rejects.toMatchObject({ name: "ServiceCallError", kind: "disconnected", serviceName: "/recorder/start" });
    const late = callService(failing(new TransportError("deadline", "query: no answer within 6000 ms")), GRAPH, "/recorder/start", {});
    await expect(late).rejects.toMatchObject({ kind: "timeout" });
    // anything else stays what it was
    const other = callService(failing(new Error("boom")), GRAPH, "/recorder/start", {});
    await expect(other).rejects.toThrow("boom");
    await expect(other).rejects.not.toBeInstanceOf(ServiceCallError);
  });
});
