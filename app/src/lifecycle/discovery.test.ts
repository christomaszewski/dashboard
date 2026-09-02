import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleDiscovery } from "./discovery";
import type { LifecycleService } from "./types";
import type { LivelinessEvent, Sample, Transport } from "../transport/types";

const KEY = "fleet/veh1/svc/cam0/lifecycle";
const INACTIVE = {
  schema_version: 1,
  service: "camera-service",
  instance: "cam0",
  state: "inactive",
  transitions: ["activate"],
};
const ACTIVE = { ...INACTIVE, state: "active", transitions: ["deactivate"], recording: { prefix: "run-1", frames: 10 } };
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function stubTransport() {
  let onToken: ((e: LivelinessEvent) => void) | null = null;
  let onState: ((s: Sample) => void) | null = null;
  const gets: string[] = [];
  const transport = {
    subscribe: async (_pattern: string, onSample: (s: Sample) => void) => {
      onState = onSample;
      return { close: async () => undefined };
    },
    get: async (keyexpr: string) => {
      gets.push(keyexpr);
      return [{ keyexpr, payload: enc(INACTIVE) }];
    },
    liveliness: {
      subscribe: async (_pattern: string, onEvent: (e: LivelinessEvent) => void) => {
        onToken = onEvent;
        return { close: async () => undefined };
      },
      get: async () => [],
    },
    close: async () => undefined,
  } as unknown as Transport;
  return {
    transport,
    gets,
    token: (e: LivelinessEvent) => onToken?.(e),
    publish: (keyexpr: string, payload: unknown) => onState?.({ keyexpr, payload: enc(payload), kind: "put" }),
  };
}

describe("LifecycleDiscovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function start(graceMs = 15_000) {
    const stub = stubTransport();
    const discovery = new LifecycleDiscovery(stub.transport, graceMs);
    let latest: LifecycleService[] = [];
    await discovery.start((s) => (latest = s));
    return { ...stub, discovery, latest: () => latest };
  }

  it("token PUT → descriptor get → one service", async () => {
    const { token, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    expect(gets).toEqual([KEY]);
    expect(latest()).toHaveLength(1);
    expect(latest()[0]).toMatchObject({ key: KEY, vehicleId: "veh1", instance: "cam0", alive: true });
    expect(latest()[0].descriptor.state).toBe("inactive");
  });

  it("a state publication updates the descriptor without a second get", async () => {
    const { token, publish, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    publish(`${KEY}/state`, ACTIVE);
    expect(gets).toHaveLength(1);
    expect(latest()[0].descriptor.state).toBe("active");
    expect(latest()[0].descriptor.recording?.prefix).toBe("run-1");
  });

  it("a state publication for an unseen key creates the entry", async () => {
    const { publish, latest } = await start();
    publish("fleet/veh1/svc/cam1/lifecycle/state", { ...INACTIVE, instance: "cam1" });
    expect(latest()).toHaveLength(1);
    expect(latest()[0].instance).toBe("cam1");
  });

  it("ignores non-lifecycle keys and malformed descriptors", async () => {
    const { token, publish, latest } = await start();
    token({ keyexpr: "fleet/veh1/media/cam0", alive: true });
    publish("fleet/veh1/svc/cam0/lifecycle/state", { hello: "world" });
    await vi.runAllTimersAsync();
    expect(latest()).toHaveLength(0);
  });

  it("token DELETE → offline, removed after the grace; a re-PUT inside it revives", async () => {
    const { token, latest } = await start(15_000);
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    token({ keyexpr: KEY, alive: false });
    expect(latest()[0].alive).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    token({ keyexpr: KEY, alive: true }); // crash restart re-advertises
    await vi.runAllTimersAsync();
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(true);
    token({ keyexpr: KEY, alive: false });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(latest()).toHaveLength(0);
  });
});
