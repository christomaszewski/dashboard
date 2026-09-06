import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackDiscovery } from "./discovery";
import type { PlaybackService } from "./types";
import type { LivelinessEvent, Sample, Transport } from "../transport/types";

const KEY = "fleet/veh1/svc/cam0/playback";
const PLAYING = {
  schema_version: 1, service: "camera-service", instance: "cam0", source: "pcap",
  state: "playing", controls: ["pause", "set_speed", "set_loop", "restart"], speed: 1, position_s: 0.5,
};
const PAUSED = { ...PLAYING, state: "paused", controls: ["resume", "set_speed", "set_loop", "restart"] };
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
      return [{ keyexpr, payload: enc(PLAYING) }];
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

describe("PlaybackDiscovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function start(graceMs = 15_000) {
    const stub = stubTransport();
    const discovery = new PlaybackDiscovery(stub.transport, graceMs);
    let latest: PlaybackService[] = [];
    await discovery.start((s) => (latest = s));
    return { ...stub, discovery, latest: () => latest };
  }

  it("token PUT → descriptor get → one controllable source", async () => {
    const { token, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    expect(gets).toEqual([KEY]);
    expect(latest()[0]).toMatchObject({ key: KEY, vehicleId: "veh1", instance: "cam0", alive: true });
    expect(latest()[0].descriptor.state).toBe("playing");
  });

  it("a state publication (a change, or the 1 Hz position) updates without a second get", async () => {
    const { token, publish, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    publish(KEY + "/state", PAUSED);
    expect(gets).toHaveLength(1);
    expect(latest()[0].descriptor.state).toBe("paused");
    expect(latest()[0].descriptor.controls[0]).toBe("resume");
    publish(KEY + "/state", { ...PLAYING, position_s: 2.5 });
    expect(latest()[0].descriptor.position_s).toBe(2.5);
  });

  it("only the playback keyspace, only a matching instance", async () => {
    const { token, publish, gets, latest } = await start();
    token({ keyexpr: "fleet/veh1/svc/cam0/lifecycle", alive: true });   // the sibling: not ours
    publish("fleet/veh1/svc/cam0/playback/state", { ...PLAYING, instance: "other" });  // contract violation
    await vi.runAllTimersAsync();
    expect(gets).toEqual([]);
    expect(latest()).toHaveLength(0);
  });

  it("token DELETE → offline, removed after the grace unless it comes back", async () => {
    const { token, latest } = await start(1000);
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    token({ keyexpr: KEY, alive: false });
    expect(latest()[0].alive).toBe(false);
    token({ keyexpr: KEY, alive: true });               // a producer restart re-advertises
    await vi.runAllTimersAsync();
    expect(latest()[0].alive).toBe(true);
    token({ keyexpr: KEY, alive: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(latest()).toHaveLength(0);
  });
});
