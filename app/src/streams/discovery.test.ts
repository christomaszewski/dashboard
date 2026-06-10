import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamDiscovery } from "./discovery";
import type { DiscoveredStream } from "./types";
import type { LivelinessEvent, Transport } from "../transport/types";

const KEY = "fleet/veh1/media/cam0";
const DESCRIPTOR = {
  schema_version: 1,
  id: "cam0",
  producer: "camera-service",
  protocol: "gstwebrtc-api",
  signalling: "ws://veh:8445",
  producer_id: "1-cam0",
};

function stubTransport() {
  let handler: ((e: LivelinessEvent) => void) | null = null;
  const transport = {
    subscribe: async () => ({ close: async () => undefined }),
    get: async () => [{ keyexpr: KEY, payload: new TextEncoder().encode(JSON.stringify(DESCRIPTOR)) }],
    liveliness: {
      subscribe: async (_pattern: string, onEvent: (e: LivelinessEvent) => void) => {
        handler = onEvent;
        return { close: async () => undefined };
      },
      get: async () => [],
    },
    close: async () => undefined,
  } as unknown as Transport;
  return { transport, fire: (e: LivelinessEvent) => handler?.(e) };
}

describe("StreamDiscovery offline grace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function startWithStream(graceMs: number) {
    const { transport, fire } = stubTransport();
    const discovery = new StreamDiscovery(transport, "fleet/*/media/*", graceMs);
    let latest: DiscoveredStream[] = [];
    await discovery.start((s) => (latest = s));
    fire({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync(); // flush the descriptor fetch microtasks
    return { discovery, fire, latest: () => latest };
  }

  it("marks a dropped stream offline and only removes it after the grace", async () => {
    const { fire, latest } = await startWithStream(45_000);
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(true);

    fire({ keyexpr: KEY, alive: false });
    expect(latest()).toHaveLength(1); // still listed…
    expect(latest()[0].alive).toBe(false); // …but offline

    await vi.advanceTimersByTimeAsync(44_000);
    expect(latest()).toHaveLength(1); // grace not over

    await vi.advanceTimersByTimeAsync(2_000);
    expect(latest()).toHaveLength(0); // grace expired → removed
  });

  it("a re-advertise inside the grace revives the stream and cancels removal", async () => {
    const { fire, latest } = await startWithStream(45_000);
    fire({ keyexpr: KEY, alive: false });
    expect(latest()[0].alive).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    fire({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync(); // descriptor refetch + would-be removal timers
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000); // well past the original grace
    expect(latest()).toHaveLength(1); // removal was cancelled
  });

  it("a delete for an unknown key is ignored", async () => {
    const { transport, fire } = stubTransport();
    const discovery = new StreamDiscovery(transport, "fleet/*/media/*", 45_000);
    let latest: DiscoveredStream[] = [];
    await discovery.start((s) => (latest = s));
    fire({ keyexpr: "fleet/veh1/media/ghost", alive: false });
    expect(latest).toHaveLength(0);
  });
});
