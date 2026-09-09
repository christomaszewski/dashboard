import { MAX_CLOUD_BYTES, type ParsedCloud } from "./pointCloud";

export interface CloudJob {
  key: string; payload: Uint8Array; maxPoints: number; history: boolean;
  done: (cloud: ParsedCloud, warning?: string) => void; error: (message: string) => void; dropped: () => void;
}
/** A single worker with a bounded queue. Large shared transport buffers are copied only at dispatch. */
export class CloudPipeline {
  private worker: Worker | null = null;
  private queue: CloudJob[] = [];
  private active: { id: number; job: CloudJob } | null = null;
  private serial = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  constructor(private createWorker = () => new Worker(new URL("./cloudWorker.ts", import.meta.url), { type: "module" })) {}

  submit(job: CloudJob): void {
    if (job.payload.byteLength > MAX_CLOUD_BYTES) { job.error("cloud exceeds 64 MiB input budget"); return; }
    const own = this.queue.filter((j) => j.key === job.key);
    const keep = job.history ? 3 : 0;
    for (const old of own.slice(0, Math.max(0, own.length - keep))) this.evict(old);
    while (this.queue.length >= 8 || this.queue.reduce((n, j) => n + j.payload.byteLength, job.payload.byteLength) > MAX_CLOUD_BYTES) {
      if (!this.queue.length) break;
      this.evict(this.queue[0]);
    }
    this.queue.push(job); this.dispatch();
  }
  private evict(job: CloudJob): void { this.queue.splice(this.queue.indexOf(job), 1); job.dropped(); }
  cancel(key: string): void {
    this.queue = this.queue.filter((job) => job.key !== key);
    // Active jobs finish but their owning feed's generation guard rejects the result.
  }
  private dispatch(): void {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift()!;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<{ id: number; cloud?: ParsedCloud; error?: string; warning?: string }>) => {
          if (!this.active || event.data.id !== this.active.id) return;
          const current = this.active.job;
          this.active = null; clearTimeout(this.timeout);
          if (event.data.cloud) current.done(event.data.cloud, event.data.warning);
          else current.error(event.data.error ?? "cloud worker returned no data");
          this.dispatch();
        };
        this.worker.onerror = (event) => { event.preventDefault(); this.fail(event.message || "cloud worker failed"); };
        this.worker.onmessageerror = () => this.fail("cloud worker message could not be read");
      }
      const id = ++this.serial; this.active = { id, job };
      const payload = job.payload.slice();
      this.worker.postMessage({ id, payload, maxPoints: job.maxPoints }, [payload.buffer]);
      this.timeout = setTimeout(() => this.fail("cloud decode exceeded 10 seconds"), 10000);
    } catch (error) {
      if (!this.active) job.error(String(error));
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
  private fail(message: string): void {
    clearTimeout(this.timeout); this.worker?.terminate(); this.worker = null;
    const active = this.active; this.active = null;
    active?.job.error(message); this.dispatch();
  }
  close(): void {
    clearTimeout(this.timeout); this.worker?.terminate(); this.worker = null; this.active = null; this.queue = [];
  }
}
