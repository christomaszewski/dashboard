import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleDiscovery } from "./discovery";
import type { LifecycleService } from "./types";
import type { GetReply, LivelinessEvent, Sample, Subscription, Transport } from "../transport/types";

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
  const discoveries: LifecycleDiscovery[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await Promise.all(discoveries.splice(0).map((d) => d.stop()));
    vi.useRealTimers();
  });

  async function start(graceMs = 15_000) {
    const stub = stubTransport();
    const discovery = new LifecycleDiscovery(stub.transport, graceMs);
    discoveries.push(discovery);
    let latest: LifecycleService[] = [];
    await discovery.start((s) => (latest = s));
    return { ...stub, discovery, latest: () => latest };
  }

  it("token PUT → descriptor get → one service", async () => {
    const { token, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toEqual([KEY]);
    expect(latest()).toHaveLength(1);
    expect(latest()[0]).toMatchObject({ key: KEY, vehicleId: "veh1", instance: "cam0", alive: true });
    expect(latest()[0].descriptor.state).toBe("inactive");
  });

  it("a state publication updates the descriptor without a second get", async () => {
    const { token, publish, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toHaveLength(0);
  });

  it("rejects a descriptor whose instance does not match the key segment", async () => {
    const { publish, latest } = await start();
    publish("fleet/veh1/svc/cam1/lifecycle/state", { ...INACTIVE, instance: "cam0" });
    expect(latest()).toHaveLength(0);
  });

  it("token DELETE → offline, removed after the grace; a re-PUT inside it revives", async () => {
    const { token, latest } = await start(15_000);
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(0);
    token({ keyexpr: KEY, alive: false });
    expect(latest()[0].alive).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    token({ keyexpr: KEY, alive: true }); // crash restart re-advertises
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(true);
    token({ keyexpr: KEY, alive: false });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(latest()).toHaveLength(0);
  });

  it.each(["empty", "rejected"])("recovers a %s initial descriptor without another token or transition", async (failure) => {
    const { transport, token, latest } = await start();
    const get = vi.fn<Transport["get"]>();
    if (failure === "empty") get.mockResolvedValueOnce([]);
    else get.mockRejectedValueOnce(new Error("temporary link failure"));
    get.mockResolvedValue([{ keyexpr: KEY, payload: enc(ACTIVE) }]);
    transport.get = get;
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latest()[0]?.descriptor.state).toBe("active");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reconciles a lost transition publication with a read-only descriptor query", async () => {
    const { transport, token, latest } = await start();
    const get = vi.fn<Transport["get"]>().mockResolvedValueOnce([{ keyexpr: KEY, payload: enc(INACTIVE) }])
      .mockResolvedValue([{ keyexpr: KEY, payload: enc(ACTIVE) }]);
    transport.get = get;
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()[0].descriptor.state).toBe("inactive");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(latest()[0].descriptor.state).toBe("active");
    expect(get.mock.calls.map(([key]) => key)).toEqual([KEY, KEY]);
  });

  it("does not let delayed queries overwrite publications or resurrect withdrawn services", async () => {
    const { transport, token, publish, latest } = await start();
    let finish!: (replies: GetReply[]) => void;
    transport.get = () => new Promise((resolve) => { finish = resolve; });
    token({ keyexpr: KEY, alive: true });
    publish(`${KEY}/state`, ACTIVE);
    finish([{ keyexpr: KEY, payload: enc(INACTIVE) }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()[0].descriptor.state).toBe("active");

    token({ keyexpr: KEY, alive: true });
    token({ keyexpr: KEY, alive: false });
    finish([{ keyexpr: KEY, payload: enc(INACTIVE) }]);
    publish(`${KEY}/state`, ACTIVE);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest()[0].alive).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(latest()).toHaveLength(0);
  });

  it("never overlaps descriptor queries and stops refreshes and late updates on close", async () => {
    const { discovery, transport, token, latest } = await start();
    let finish!: (replies: GetReply[]) => void;
    const get = vi.fn<Transport["get"]>(() => new Promise((resolve) => { finish = resolve; }));
    transport.get = get;
    token({ keyexpr: KEY, alive: true });
    token({ keyexpr: KEY, alive: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(get).toHaveBeenCalledTimes(1);
    await discovery.stop();
    finish([{ keyexpr: KEY, payload: enc(ACTIVE) }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(latest()).toHaveLength(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a subscription that finishes declaring after stop", async () => {
    const { transport } = stubTransport();
    let declared!: (sub: Subscription) => void;
    transport.liveliness.subscribe = () => new Promise((resolve) => { declared = resolve; });
    const subscribe = vi.fn(transport.subscribe);
    transport.subscribe = subscribe;
    const discovery = new LifecycleDiscovery(transport);
    discoveries.push(discovery);
    const starting = discovery.start(() => undefined);
    await discovery.stop();
    const close = vi.fn(async () => undefined);
    declared({ close });
    await starting;
    expect(close).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
