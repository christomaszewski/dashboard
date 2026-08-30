/**
 * Sliding-window arrival-rate monitor (same math as TopicInspector's Hz pill). Pure, injectable
 * timestamps — record with any monotonic ms clock and query hz() with the same one.
 */
export class RateMonitor {
  private arrivals: number[] = [];

  constructor(private readonly windowMs = 5000) {}

  record(t: number): void {
    this.arrivals.push(t);
    if (this.arrivals.length > 512) this.arrivals.splice(0, 256);
  }

  /** Measured rate over the window, or undefined with fewer than two arrivals in it. */
  hz(now: number): number | undefined {
    this.arrivals = this.arrivals.filter((t) => now - t <= this.windowMs);
    const n = this.arrivals.length;
    if (n < 2) return undefined;
    return ((n - 1) / (now - this.arrivals[0])) * 1000;
  }
}
