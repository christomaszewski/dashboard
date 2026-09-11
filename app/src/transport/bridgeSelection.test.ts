import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeSelection, type BridgeTransport } from "./bridgeSelection";

const LOCAL = "ws/127.0.0.1:10000";
const VEHICLE = "ws/vehicle:10000";
function bridge(id = "abc"): BridgeTransport {
  return {
    bridgeId: vi.fn(async () => id),
    verifyVehicle: vi.fn(async () => undefined),
    useVehicleProbe: vi.fn(),
    subscribe: vi.fn(async () => ({ close: async () => undefined })),
    get: vi.fn(async () => []),
    liveliness: { get: vi.fn(async () => []), subscribe: vi.fn(async () => ({ close: async () => undefined })) },
    close: vi.fn(async () => undefined),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bridge selection", () => {
  it("verifies a local bridge against the identity learned directly from this vehicle", async () => {
    const local = bridge("def"), direct = bridge();
    const open = vi.fn(async (locator: string) => locator === LOCAL ? local : direct);
    const save = vi.fn(), selected = vi.fn();
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, open, saveVehicleId: save, onSelected: selected });
    expect(await selector.open()).toBe(local);
    expect(open.mock.calls.map(c => c[0])).toEqual([LOCAL, VEHICLE]);
    expect(local.verifyVehicle).toHaveBeenCalledWith("abc");
    expect(local.useVehicleProbe).toHaveBeenCalledWith("abc");
    expect(save).toHaveBeenCalledWith("abc");
    expect(direct.close).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith(LOCAL);
  });

  it("uses a verified local path without opening the wireless WebSocket when identity is cached", async () => {
    const local = bridge();
    const open = vi.fn(async () => local);
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, open, loadVehicleId: () => "abc" });
    expect(await selector.open()).toBe(local);
    expect(open).toHaveBeenCalledTimes(1);
    expect(local.verifyVehicle).toHaveBeenCalledWith("abc");
  });

  it("falls back on refusal, browser denial, or an incompatible localhost service", async () => {
    const direct = bridge();
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL,
      open: async locator => { if (locator === LOCAL) throw new Error("denied"); return direct; } });
    expect(await selector.open()).toBe(direct);
  });

  it("rejects a local bridge that reaches a different bus, reusing the direct connection", async () => {
    const local = bridge("def"), direct = bridge();
    vi.mocked(local.verifyVehicle).mockRejectedValue(new Error("no matching vehicle reply"));
    const open = vi.fn(async (locator: string) => locator === LOCAL ? local : direct);
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, open });
    expect(await selector.open()).toBe(direct);
    expect(local.close).toHaveBeenCalledOnce();
    expect(direct.close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("bounds a silent local endpoint, aborts its dial, and closes a late result", async () => {
    const local = bridge(), direct = bridge();
    let resolve!: (t: BridgeTransport) => void;
    let signal!: AbortSignal;
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL,
      open: async (locator, s) => {
        if (locator !== LOCAL) return direct;
        signal = s;
        return new Promise(r => { resolve = r; });
      } });
    const pending = selector.open();
    await vi.advanceTimersByTimeAsync(1_201);
    expect(await pending).toBe(direct);
    expect(signal.aborted).toBe(true);
    resolve(local);
    await vi.advanceTimersByTimeAsync(0);
    expect(local.close).toHaveBeenCalledOnce();
  });

  it("bounds a silent vehicle verification and falls back without subscriptions on localhost", async () => {
    const local = bridge(), direct = bridge();
    vi.mocked(local.verifyVehicle).mockImplementation(() => new Promise(() => undefined));
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, loadVehicleId: () => "abc",
      open: async locator => locator === LOCAL ? local : direct });
    const pending = selector.open();
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await pending).toBe(direct);
    expect(local.close).toHaveBeenCalledOnce();
    expect(local.subscribe).not.toHaveBeenCalled();
  });

  it("tries the vehicle first after loss of a selected local connection", async () => {
    const local = bridge(), direct = bridge();
    const open = vi.fn(async (locator: string) => locator === LOCAL ? local : direct);
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, open, loadVehicleId: () => "abc" });
    expect(await selector.open()).toBe(local);
    expect(await selector.open()).toBe(direct);
    expect(open.mock.calls.map(c => c[0])).toEqual([LOCAL, VEHICLE]);
  });

  it("refreshes a stale cached identity on fallback and uses it on the next selection", async () => {
    const local = bridge(), direct = bridge("def");
    vi.mocked(local.verifyVehicle).mockImplementation(async id => { if (id !== "def") throw new Error("old vehicle process"); });
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, loadVehicleId: () => "abc",
      open: async locator => locator === LOCAL ? local : direct });
    expect(await selector.open()).toBe(direct);
    expect(await selector.open()).toBe(local);
    expect(local.verifyVehicle).toHaveBeenLastCalledWith("def");
  });

  it("reports failure when neither endpoint connects", async () => {
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL,
      open: async () => { throw new Error("unreachable"); } });
    await expect(selector.open()).rejects.toThrow("unreachable");
  });

  it("cancels an in-flight selection without dialing the fallback or selecting a late connection", async () => {
    let resolve!: (t: BridgeTransport) => void;
    const local = bridge();
    const open = vi.fn(() => new Promise<BridgeTransport>(r => { resolve = r; }));
    const selected = vi.fn();
    const selector = new BridgeSelection({ vehicleLocator: VEHICLE, localLocator: LOCAL, open, onSelected: selected });
    const pending = selector.open().catch(e => e);
    selector.close();
    expect(await pending).toBeInstanceOf(Error);
    resolve(local);
    await vi.advanceTimersByTimeAsync(0);
    expect(local.close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
  });
});
