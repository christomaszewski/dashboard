import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RigCurrentRun } from "../rig/types";
import type { IncomingQuery, Subscription } from "../transport/types";
import { CurrentRunWatcher, NO_CURRENT_RUN, currentRunKey, serveCurrentRun, type CurrentRunFields } from "./currentRun";
import { decodeMessage } from "./protocol";

const OPEN: CurrentRunFields = { ok: true, run_id: "r1", run_dir: "/data/runs/r1", label: "drive", started: "2026-11-05", error: null };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());

it("orders meaningful changes, refreshes observation time, and gives every process a new epoch", async () => {
  let fields = OPEN;
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read: async () => fields });
  const changed = vi.fn();
  watcher.subscribe(changed);
  await watcher.refresh();
  const initial = watcher.current();
  expect(initial).toMatchObject({ ...OPEN, schema_version: 1, vehicle_id: "7", revision: 2, at_unix_s: 100 });
  await vi.advanceTimersByTimeAsync(2000);
  await watcher.refresh();
  expect(watcher.current()).toMatchObject({ revision: 2, at_unix_s: 102 });
  expect(changed).toHaveBeenCalledTimes(1);
  fields = { ...OPEN, run_id: "r2", run_dir: "/data/runs/r2" };
  await watcher.refresh();
  fields = NO_CURRENT_RUN;
  await watcher.refresh();
  expect(watcher.current()).toMatchObject({ ...NO_CURRENT_RUN, revision: 4, epoch: initial.epoch });
  const next = new CurrentRunWatcher({ vehicleId: "7", read: async () => fields });
  expect(next.current().epoch).not.toBe(initial.epoch);
  watcher.close(); next.close();
});

it("reports filesystem errors and recovers without overlapping a stalled observation", async () => {
  let finish!: (fields: CurrentRunFields) => void;
  const read = vi.fn<() => Promise<CurrentRunFields>>().mockResolvedValueOnce(OPEN)
    .mockRejectedValueOnce(new Error("permission denied"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(NO_CURRENT_RUN);
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read });
  watcher.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(watcher.current().ok).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(watcher.current()).toMatchObject({ ok: false, run_id: null, error: "run registry: permission denied", revision: 3 });
  const observedAt = watcher.current().at_unix_s;
  await vi.advanceTimersByTimeAsync(14_000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(watcher.current()).toMatchObject({ ok: false, run_id: null, error: "run registry observation is stale", revision: 4, at_unix_s: observedAt });
  finish(OPEN);
  await vi.advanceTimersByTimeAsync(0);
  expect(watcher.current()).toMatchObject({ ...OPEN, revision: 5 });
  watcher.close();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("drops a filesystem result that arrives after shutdown", async () => {
  let finish!: (fields: CurrentRunFields) => void;
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read: () => new Promise(resolve => { finish = resolve; }) });
  const changed = vi.fn(); watcher.subscribe(changed);
  const pending = watcher.refresh();
  watcher.close(); finish(OPEN); await pending;
  expect(changed).not.toHaveBeenCalled();
  expect(watcher.current().ok).toBe(false);
});

function transportFake() {
  const publications: RigCurrentRun[] = [];
  const replyKeys: string[] = [];
  let callback!: (q: IncomingQuery) => void;
  const publisher = { put: vi.fn(async (bytes: Uint8Array) => { publications.push(decodeMessage(bytes) as RigCurrentRun); }), close: vi.fn(async () => {}) };
  const queryable: Subscription = { close: vi.fn(async () => {}) };
  const transport = {
    declarePublisher: vi.fn(async (_key: string) => publisher),
    declareQueryable: vi.fn(async (_key: string, cb: (q: IncomingQuery) => void, opts?: { replyKey?: string }) => {
      callback = cb;
      replyKeys.push(opts?.replyKey ?? "");
      return queryable;
    }),
  };
  return { transport, publications, publisher, queryable, replyKeys, query: () => {
    const replies: RigCurrentRun[] = [];
    callback({ keyexpr: "fleet/*/rig/current_run", reply: async bytes => { replies.push(decodeMessage(bytes) as RigCurrentRun); }, replyErr: async () => {} });
    return replies;
  } };
}

it("serves a concrete cached query, publishes changes and 30 s heartbeats, and retries failed puts", async () => {
  let fields = OPEN;
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read: async () => fields });
  watcher.start(); await vi.advanceTimersByTimeAsync(0);
  const fake = transportFake();
  const feed = await serveCurrentRun(watcher, fake.transport);
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.transport.declarePublisher).toHaveBeenCalledWith("fleet/7/rig/current_run", { encoding: "application/json" });
  expect(fake.replyKeys).toEqual(["fleet/7/rig/current_run"]);
  expect(fake.query()).toEqual([watcher.current()]);
  expect(fake.publications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fake.publications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.publications.map(d => d.revision)).toEqual([2, 2]);
  expect(fake.publications[1].at_unix_s).toBe(130);
  const put = fake.publisher.put.getMockImplementation()!;
  fake.publisher.put.mockRejectedValue(new Error("link lost"));
  fields = NO_CURRENT_RUN;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fake.publications).toHaveLength(2);
  fake.publisher.put.mockImplementation(put);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fake.publications[2]).toMatchObject({ ok: true, run_id: null, revision: 3 });
  await feed.close(); watcher.close();
  expect(fake.publisher.close).toHaveBeenCalledOnce();
  expect(fake.queryable.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a publisher when declaration fails and rejects unsafe vehicle identities", async () => {
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read: async () => OPEN });
  const fake = transportFake();
  fake.transport.declareQueryable.mockRejectedValueOnce(new Error("declare failed"));
  await expect(serveCurrentRun(watcher, fake.transport)).rejects.toThrow("declare failed");
  expect(fake.publisher.close).toHaveBeenCalledOnce();
  for (const id of ["", "a/b", "*", "vehicle?x", "veh$*"]) expect(() => currentRunKey(id)).toThrow();
  watcher.close();
});

it("advances revision when a query or publication exposed the placeholder before the initial read", async () => {
  let finish!: (fields: CurrentRunFields) => void;
  const watcher = new CurrentRunWatcher({ vehicleId: "7", read: () => new Promise(resolve => { finish = resolve; }) });
  watcher.start();
  const fake = transportFake();
  const feed = await serveCurrentRun(watcher, fake.transport);
  await vi.advanceTimersByTimeAsync(0);
  const initial = fake.query()[0];
  expect(initial).toMatchObject({ ok: false, revision: 1, error: "no registry observation yet" });
  expect(fake.publications).toEqual([initial]);
  finish(OPEN);
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.query()[0]).toMatchObject({ ...OPEN, revision: 2, epoch: initial.epoch });
  expect(fake.publications.map(d => d.revision)).toEqual([1, 2]);
  await feed.close(); watcher.close();
});
