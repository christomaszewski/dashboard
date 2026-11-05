import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentRunWatcher, NO_CURRENT_RUN, type CurrentRunFields } from "./currentRun";
import { STATE_KEY_RE, validateViewSpec, type PollReply } from "./protocol";
import { VehicleStateServer } from "./server";
import { FakeStore } from "./testkit";

const ok = (reply: PollReply) => { if ("error" in reply) throw new Error(reply.error); return reply; };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("validates current-run items separately from ROS topics", () => {
  expect(validateViewSpec({ v: 1, items: [{ current_run: true }] }).items).toEqual([{ current_run: true }]);
  expect(() => validateViewSpec({ v: 1, items: [{ current_run: false }] })).toThrow("must be true");
  expect(() => validateViewSpec({ v: 1, items: [{ current_run: true, topic: "/x" }] })).toThrow("exactly one");
});

it("preserves dotted vehicle identities in the state service key", () => {
  expect(STATE_KEY_RE.test("fleet/rover.3/dash/dashboard/state")).toBe(true);
  expect(STATE_KEY_RE.test("fleet/-rover.3/dash/dashboard/state")).toBe(true);
  for (const key of ["fleet/*/dash/dashboard/state", "fleet/rover?3/dash/dashboard/state", "fleet//dash/dashboard/state"])
    expect(STATE_KEY_RE.test(key)).toBe(false);
});

it("sends an initial run, only meaningful changes, and a fresh complete run on reconnect", async () => {
  let fields: CurrentRunFields = { ...NO_CURRENT_RUN, run_id: "r1", run_dir: "/data/runs/r1" };
  const source = new CurrentRunWatcher({ vehicleId: "1", read: async () => fields });
  await source.refresh();
  const store = new FakeStore();
  const server = new VehicleStateServer({ store, currentRun: source, epoch: "e1" });
  const { view } = server.register({ v: 1, items: [{ current_run: true }] });
  const poll = (since: number, epoch = "e1") => server.poll({ v: 1, view, since, epoch });
  const initial = ok(await poll(0));
  expect(initial.items[0][1].run?.run_id).toBe("r1");
  expect(store.acquired).toEqual([]);
  const held = poll(initial.seq);
  await vi.advanceTimersByTimeAsync(1000);
  await source.refresh(); // observation timestamp changes, run does not
  await vi.advanceTimersByTimeAsync(1000);
  expect(ok(await held).items).toEqual([]);
  const reconnect = ok(await poll(999, "old"));
  expect(reconnect.items[0][1].run?.at_unix_s).toBe(source.current().at_unix_s);
  const changed = poll(initial.seq);
  fields = NO_CURRENT_RUN;
  await source.refresh();
  await vi.advanceTimersByTimeAsync(10);
  expect(ok(await changed).items[0][1].run).toMatchObject({ ok: true, run_id: null, revision: 3 });
  server.close(); source.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports an absent registry source instead of fabricating an idle run", async () => {
  const server = new VehicleStateServer({ store: new FakeStore(), epoch: "e1" });
  const { view } = server.register({ v: 1, items: [{ current_run: true }] });
  const reply = ok(await server.poll({ v: 1, view, epoch: "e1", since: 0 }));
  expect(reply.items).toEqual([[0, { e: "current run is not configured on this vehicle" }]]);
  server.close();
});

it("sends a stalled registry observation error and its recovery through the optimized item", async () => {
  let finish!: (fields: CurrentRunFields) => void;
  const read = vi.fn<() => Promise<CurrentRunFields>>().mockResolvedValueOnce(NO_CURRENT_RUN)
    .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const source = new CurrentRunWatcher({ vehicleId: "1", read });
  await source.refresh();
  const server = new VehicleStateServer({ store: new FakeStore(), currentRun: source, epoch: "e1" });
  const { view } = server.register({ v: 1, items: [{ current_run: true }] });
  const poll = (since: number) => server.poll({ v: 1, view, since, epoch: "e1" });
  const initial = ok(await poll(0));
  source.start();
  await vi.advanceTimersByTimeAsync(12_000);
  const stale = ok(await poll(initial.seq));
  expect(stale.items[0][1].run).toMatchObject({ ok: false, error: "run registry observation is stale" });
  finish(NO_CURRENT_RUN);
  await vi.advanceTimersByTimeAsync(0);
  expect(ok(await poll(stale.seq)).items[0][1].run).toMatchObject({ ok: true, run_id: null, revision: 4 });
  expect(read).toHaveBeenCalledTimes(2);
  server.close(); source.close();
});
