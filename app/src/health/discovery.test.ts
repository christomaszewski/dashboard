import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthDiscovery } from "./discovery";
import type { HealthService } from "./types";
import type { LivelinessEvent, Sample, Transport } from "../transport/types";

const KEY = "fleet/veh1/svc/cam_gige/health";
const snapshot = (sensorC: number, instance = "cam_gige") => ({
  schema_version: 1,
  service: "camera-service",
  instance,
  stamp_unix_ns: 1759200000000000000,
  level: 0,
  status: [
    { level: 0, name: `${instance}: camera`, message: `${sensorC} C`, hardware_id: "Basler sn 4", values: { "temp.sensor_c": sensorC, uptime_s: 12 } },
    { level: 0, name: `${instance}: stream`, message: "OK", hardware_id: "", values: { "fps.delivered": 24 } },
  ],
});
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function stubTransport() {
  let onToken: ((e: LivelinessEvent) => void) | null = null;
  let onState: ((s: Sample) => void) | null = null;
  const gets: string[] = [];
  const patterns: string[] = [];
  const transport = {
    subscribe: async (pattern: string, onSample: (s: Sample) => void) => {
      patterns.push(pattern);
      onState = onSample;
      return { close: async () => undefined };
    },
    get: async (keyexpr: string) => {
      gets.push(keyexpr);
      return [{ keyexpr, payload: enc(snapshot(40)) }];
    },
    liveliness: {
      subscribe: async (pattern: string, onEvent: (e: LivelinessEvent) => void) => {
        patterns.push(pattern);
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
    patterns,
    token: (e: LivelinessEvent) => onToken?.(e),
    publish: (keyexpr: string, payload: unknown) => onState?.({ keyexpr, payload: enc(payload), kind: "put" }),
  };
}

describe("HealthDiscovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function start(graceMs = 15_000) {
    const stub = stubTransport();
    const discovery = new HealthDiscovery(stub.transport, graceMs);
    let latest: HealthService[] = [];
    await discovery.start((s) => (latest = s));
    return { ...stub, discovery, latest: () => latest };
  }

  it("listens on the health token and state keys", async () => {
    const { patterns } = await start();
    expect(patterns).toEqual(["fleet/*/svc/*/health", "fleet/*/svc/*/health/state"]);
  });

  it("token PUT → snapshot get → one instance", async () => {
    const { token, gets, latest } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    expect(gets).toEqual([KEY]);
    expect(latest()).toHaveLength(1);
    expect(latest()[0]).toMatchObject({ key: KEY, vehicleId: "veh1", instance: "cam_gige", alive: true });
    expect(latest()[0].snapshot.status[0].values["temp.sensor_c"]).toBe(40);
  });

  it("every publication replaces the snapshot, stamps its arrival, and measures the period", async () => {
    const { publish, latest } = await start();
    vi.setSystemTime(1_000_000);
    publish(`${KEY}/state`, snapshot(41));
    expect(latest()[0]).toMatchObject({ receivedAtMs: 1_000_000, periodMs: undefined });
    vi.setSystemTime(1_001_000);
    publish(`${KEY}/state`, snapshot(41.5));
    expect(latest()[0]).toMatchObject({ receivedAtMs: 1_001_000, periodMs: 1000 });
    expect(latest()[0].snapshot.status[0].values["temp.sensor_c"]).toBe(41.5);
  });

  it("keeps a history of each temperature, and of nothing else", async () => {
    const { publish, discovery } = await start();
    vi.setSystemTime(1_000_000);
    publish(`${KEY}/state`, snapshot(41));
    vi.setSystemTime(1_001_000);
    publish(`${KEY}/state`, snapshot(41.5));
    expect(discovery.series(KEY, "cam_gige: camera", "temp.sensor_c")).toEqual([
      { t: 1_000_000, v: 41 },
      { t: 1_001_000, v: 41.5 },
    ]);
    expect(discovery.series(KEY, "cam_gige: camera", "uptime_s")).toEqual([]);
    expect(discovery.series(KEY, "cam_gige: stream", "fps.delivered")).toEqual([]);
  });

  it("ignores other keys, malformed snapshots, and an instance that does not match its key", async () => {
    const { token, publish, latest } = await start();
    token({ keyexpr: "fleet/veh1/svc/cam_gige/lifecycle", alive: true });
    publish(`${KEY}/state`, { hello: "world" });
    publish(`${KEY}/state`, snapshot(40, "cam_other"));
    await vi.runAllTimersAsync();
    expect(latest()).toHaveLength(0);
  });

  it("token DELETE keeps an offline entry and history for this browser session; re-PUT revives", async () => {
    const { token, latest, discovery } = await start(15_000);
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    token({ keyexpr: KEY, alive: false });
    expect(latest()[0].alive).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    token({ keyexpr: KEY, alive: true }); // crash restart re-advertises
    await vi.runAllTimersAsync();
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(true);
    expect(discovery.series(KEY, "cam_gige: camera", "temp.sensor_c")).toHaveLength(2);
    token({ keyexpr: KEY, alive: false });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(latest()).toHaveLength(1);
    expect(latest()[0].alive).toBe(false);
    expect(discovery.series(KEY, "cam_gige: camera", "temp.sensor_c")).toHaveLength(2);
  });
});


it("a delayed query cannot resurrect a withdrawn reporter or replace a newer publication", async () => {
  const stub = stubTransport();
  let reply: (value: any) => void = () => undefined;
  stub.transport.get = () => new Promise((resolve) => { reply = resolve; });
  const discovery = new HealthDiscovery(stub.transport);
  let latest: HealthService[] = [];
  await discovery.start((s) => { latest = s; });
  stub.publish(`${KEY}/state`, snapshot(40));
  stub.token({ keyexpr: KEY, alive: true });
  stub.publish(`${KEY}/state`, snapshot(43));
  reply([{ keyexpr: KEY, payload: enc(snapshot(10)) }]);
  await Promise.resolve();
  expect(latest[0].snapshot.status[0].values["temp.sensor_c"]).toBe(43);
  stub.token({ keyexpr: KEY, alive: true });
  stub.token({ keyexpr: KEY, alive: false });
  reply([{ keyexpr: KEY, payload: enc(snapshot(10)) }]);
  await Promise.resolve();
  expect(latest[0].alive).toBe(false);
  await discovery.stop();
});
