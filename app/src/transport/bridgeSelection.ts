import type { Transport } from "./types";

export interface BridgeTransport extends Transport {
  bridgeId(): Promise<string>;
  verifyVehicle(id: string): Promise<void>;
  useVehicleProbe(id: string): void;
}

export interface BridgeSelectionOptions {
  vehicleLocator: string;
  localLocator?: string;
  open: (locator: string, signal: AbortSignal, timeoutMs: number) => Promise<BridgeTransport>;
  onSelected?: (locator: string) => void;
  loadVehicleId?: () => string | undefined;
  saveVehicleId?: (id: string) => void;
  localTimeoutMs?: number;
  vehicleTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

/** Select a bridge without exposing an unverified local bus to the UI. On first use, learn the
 * vehicle bridge's Zenoh identity directly; afterwards a small routed query validates the local
 * path. A failed local path tries the vehicle first on reconnect. Healthy sessions stay put. */
export class BridgeSelection {
  private readonly lifetime = new AbortController();
  private vehicleId?: string;
  private selected?: string;

  constructor(private readonly opts: BridgeSelectionOptions) {
    this.vehicleId = opts.loadVehicleId?.();
  }

  close(): void { this.lifetime.abort(); }

  private bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
    dispose: (value: T) => void = () => undefined): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener("abort", abort);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.abort();
        reject(new Error(message));
      };
      const abort = () => fail("Bridge selection cancelled");
      const timer = setTimeout(() => fail(`Bridge attempt exceeded ${timeoutMs} ms`), timeoutMs);
      this.lifetime.signal.addEventListener("abort", abort, { once: true });
      if (this.lifetime.signal.aborted) { abort(); return; }
      let pending: Promise<T>;
      try { pending = work(controller.signal); } catch (error) {
        settled = true;
        cleanup();
        controller.abort();
        reject(error);
        return;
      }
      void pending.then(value => {
        if (settled) { dispose(value); return; }
        settled = true;
        cleanup();
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.abort();
        reject(error);
      });
    });
  }

  private dial(locator: string, timeoutMs: number): Promise<BridgeTransport> {
    return this.bounded(signal => this.opts.open(locator, signal, timeoutMs), timeoutMs,
      t => { void t.close().catch(() => undefined); });
  }

  private async vehicle(): Promise<BridgeTransport> {
    const t = await this.dial(this.opts.vehicleLocator, this.opts.vehicleTimeoutMs ?? 8_000);
    try {
      // Identity lookup is optional for direct use: an older bridge can still serve the page.
      this.vehicleId = await this.bounded(() => t.bridgeId(), this.opts.verifyTimeoutMs ?? 4_000);
      this.opts.saveVehicleId?.(this.vehicleId);
    } catch {
      this.vehicleId = undefined;
    }
    if (this.lifetime.signal.aborted) { await t.close(); throw new Error("Bridge selection cancelled"); }
    return t;
  }

  private choose(t: BridgeTransport, locator: string): BridgeTransport {
    this.selected = locator;
    this.opts.onSelected?.(locator);
    return t;
  }

  async open(): Promise<BridgeTransport> {
    const { localLocator, vehicleLocator } = this.opts;
    if (this.lifetime.signal.aborted) throw new Error("Bridge selection cancelled");
    // A localhost failure should promptly take the other route, even if localhost still accepts
    // WebSockets but its vehicle uplink has died.
    if (localLocator && this.selected === localLocator) {
      try { return this.choose(await this.vehicle(), vehicleLocator); } catch { /* try local too */ }
    }
    let local: BridgeTransport | undefined;
    let direct: BridgeTransport | undefined;
    try {
      if (localLocator) {
        local = await this.dial(localLocator, this.opts.localTimeoutMs ?? 1_200);
        if (!this.vehicleId) direct = await this.vehicle();
        const id = this.vehicleId;
        if (!id) throw new Error("Vehicle bridge identity unavailable");
        await this.bounded(() => local!.verifyVehicle(id), this.opts.verifyTimeoutMs ?? 4_000);
        if (this.lifetime.signal.aborted) throw new Error("Bridge selection cancelled");
        local.useVehicleProbe(id);
        if (direct) { void direct.close().catch(() => undefined); direct = undefined; }
        return this.choose(local, localLocator);
      }
    } catch {
      if (local) void local.close().catch(() => undefined);
    }
    if (this.lifetime.signal.aborted) {
      if (direct) void direct.close().catch(() => undefined);
      throw new Error("Bridge selection cancelled");
    }
    return this.choose(direct ?? await this.vehicle(), vehicleLocator);
  }
}
