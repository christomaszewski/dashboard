import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudPipeline, type CloudJob } from "./cloudPipeline";
const job = (key: string, history = false): CloudJob => ({ key, history, maxPoints: 10, payload: new Uint8Array([1, 2, 3]), done: vi.fn(), error: vi.fn(), dropped: vi.fn() });
function setup() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker;
  const factory = vi.fn(() => worker); return { worker, factory, pipeline: new CloudPipeline(factory) };
}
afterEach(() => vi.useRealTimers());
describe("bounded cloud worker", () => {
  it("copies shared transport bytes and replaces queued latest work", () => {
    const { worker, pipeline } = setup(); const a = job("a"); const b = job("a"); const c = job("a");
    pipeline.submit(a); pipeline.submit(b); pipeline.submit(c);
    const sent = vi.mocked(worker.postMessage).mock.calls[0][0]; expect(sent.payload).not.toBe(a.payload); expect(a.payload.byteLength).toBe(3);
    expect(b.dropped).toHaveBeenCalledTimes(1); expect(c.dropped).not.toHaveBeenCalled(); pipeline.close();
  });
  it("bounds accumulation backlog, cancels queued jobs, and recovers after a timeout", async () => {
    vi.useFakeTimers(); const { pipeline, worker, factory } = setup(); const jobs = Array.from({ length: 15 }, () => job("a", true));
    jobs.forEach((j) => pipeline.submit(j)); expect(jobs.filter((j) => vi.mocked(j.dropped).mock.calls.length).length).toBe(10);
    pipeline.cancel("a"); await vi.advanceTimersByTimeAsync(10001);
    expect(jobs[0].error).toHaveBeenCalledWith("cloud decode exceeded 10 seconds"); expect(worker.terminate).toHaveBeenCalledTimes(1);
    pipeline.submit(job("b")); expect(factory).toHaveBeenCalledTimes(2); pipeline.close();
  });
});
