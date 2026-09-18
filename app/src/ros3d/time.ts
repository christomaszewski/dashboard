/** Source time is separate from arrival time. A paused ROS clock never decays scan history. */
export class SceneTime {
  stamp: bigint | undefined;
  epoch = 0;
  reason = "waiting for clock";
  private lastArrival: number | undefined;
  private rate = 1;
  constructor(readonly mode: "live" | "ros_clock") {}
  setRate(rate: number): void { if (Number.isFinite(rate) && rate > 0) this.rate = rate; }
  update(stamp: bigint, arrival = performance.now()): boolean {
    let reset = false;
    if (this.stamp !== undefined) {
      const delta = Number(stamp - this.stamp) / 1e9;
      const elapsed = Math.max(0, arrival - (this.lastArrival ?? arrival)) / 1000;
      // Explicit controls reset before seeking. This also catches externally driven jumps.
      // The 2 s allowance tolerates clock bursts; max-rate bag playback should use explicit resets.
      if (delta < 0 || delta > elapsed * this.rate + 2) {
        this.reset(delta < 0 ? "clock moved backward / playback loop" : "clock jumped forward"); reset = true;
      }
    }
    this.stamp = stamp; this.lastArrival = arrival;
    if (!reset) this.reason = "ROS clock";
    return reset;
  }
  reset(reason: string): void { this.epoch++; this.reason = reason; this.stamp = undefined; this.lastArrival = undefined; }
  observeCloud(stamp: bigint): void {
    if (this.mode === "live" && (this.stamp === undefined || stamp > this.stamp)) this.stamp = stamp;
  }
}
