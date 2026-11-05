import { afterEach, expect, it, vi } from "vitest";
import { KeyExpr, Session, type Query } from "@eclipse-zenoh/zenoh-ts";
import { ZenohRemoteApiTransport } from "./zenohRemoteApi";

afterEach(() => vi.restoreAllMocks());

it("answers wildcard queries on the concrete JSON feed key and finalizes each query", async () => {
  let handler!: (query: Query) => void;
  const undeclare = vi.fn(async () => {});
  const publisher = { put: vi.fn(async () => {}), undeclare };
  const session = {
    declareQueryable: vi.fn(async (_key: KeyExpr, opts: { handler: (query: Query) => void }) => {
      handler = opts.handler; return { undeclare };
    }),
    declarePublisher: vi.fn(async () => publisher),
  };
  vi.spyOn(Session, "open").mockResolvedValue(session as unknown as Session);
  const transport = await ZenohRemoteApiTransport.open("ws/127.0.0.1:10001");
  const key = "fleet/7/rig/current_run";
  const payload = new TextEncoder().encode('{"ok":true}');
  let answered!: Promise<void>;
  const queryable = await transport.declareQueryable(key, q => { answered = q.reply(payload); }, { replyKey: key, encoding: "application/json" });
  const reply = vi.fn<Query["reply"]>().mockResolvedValue(undefined), finalize = vi.fn(async () => {});
  handler({ keyExpr: () => new KeyExpr("fleet/*/rig/current_run"), payload: () => undefined, reply, finalize } as unknown as Query);
  await answered;
  expect(reply).toHaveBeenCalledWith(expect.any(KeyExpr), payload, { encoding: "application/json" });
  expect(String(reply.mock.calls[0][0])).toBe(key);
  expect(finalize).toHaveBeenCalledOnce();
  const pub = await transport.declarePublisher(key, { encoding: "application/json" });
  expect(session.declarePublisher).toHaveBeenCalledWith(expect.any(KeyExpr), { encoding: "application/json" });
  await pub.put(payload);
  expect(publisher.put).toHaveBeenCalledWith(payload);
  await queryable.close(); await pub.close();
  expect(undeclare).toHaveBeenCalledTimes(2);
});
