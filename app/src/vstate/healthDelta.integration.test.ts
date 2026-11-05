import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthDiscovery } from "../health/discovery";
import { reporterCurrent, sampleAgeMs, statusCurrent, type HealthService, type HealthStatus } from "../health/types";
import { buildGraph } from "../ros/graph";
import type { GetReply, Transport, TransportGetOptions } from "../transport/types";
import { VehicleStateClient } from "./client";
import { decodeMessage, encodeMessage, type PollReply } from "./protocol";
import { VehicleStateServer, type HealthSource } from "./server";
import { FakeStore, LoopbackTransport } from "./testkit";

const BASE = "fleet/rover.3/dash/main/state";
const CAMERA = "fleet/rover.3/svc/cam_front/health";
const LIDAR = "fleet/rover.3/svc/lidar/health";
const NO_TRANSPORT = {} as Transport;
const NODE = "@ros2_lv/0/z/1/0/NN/%/%/unrelated";
const DIAGNOSTICS = "@ros2_lv/0/z/1/1/MP/%/%/sensors/%diagnostics/diagnostic_msgs::msg::dds_::DiagnosticArray_/RIHS01_aa/2:2:1,10";

class FakeHealth implements HealthSource {
  private services: HealthService[] = [];
  private listeners = new Set<() => void>();
  retain() {}
  release() {}
  list() { return this.services; }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => void this.listeners.delete(cb); }
  set(services: HealthService[]) { this.services = services; for (const cb of this.listeners) cb(); }
}

/** Both clients run the real client loop. Hiding the advertisement models an older server. */
class MeasuredLink extends LoopbackTransport {
  readonly polls: { bytes: number; reply: Exclude<PollReply, { error: string }> }[] = [];
  constructor(server: VehicleStateServer, private legacy = false) { super(server); }
  override async get(key: string, options?: TransportGetOptions): Promise<GetReply[]> {
    const replies = await super.get(key, options);
    return replies.map((reply) => {
      if (key.endsWith("/view") && this.legacy) {
        const registration = decodeMessage(reply.payload) as Record<string, unknown>;
        delete registration.health_delta;
        return { ...reply, payload: encodeMessage(registration) };
      }
      if (key.endsWith("/poll")) {
        const poll = decodeMessage(reply.payload) as PollReply;
        if (!("error" in poll)) this.polls.push({ bytes: reply.payload.byteLength, reply: poll });
      }
      return reply;
    });
  }
}

function status(instance: string, component: string, sequence: number,
  values: HealthStatus["values"] = {}, sample = sequence, age = 0): HealthStatus {
  return {
    name: `${instance}: ${component}`, level: 0, message: "OK", hardware_id: `${instance}-serial-1234`,
    receivedAtMs: Date.now(), receivedMonoMs: performance.now(),
    values: {
      "health.vehicle_id": "rover.3", "health.instance": instance, "health.service": instance === "lidar" ? "ouster" : "camera-service",
      "health.publisher_id": `${instance}-c7eb190f-3199-4cbb-b87f`, "health.sequence": sequence,
      "health.sample_id": `${instance}:${component}:${sample}`, "health.sample_age_s": age,
      "health.publish_interval_s": 1, "health.stale_after_s": 5, "health.availability": "current",
      ...values,
    },
  };
}

function service(instance: string, statuses: HealthStatus[], sequence: number, ros = false): HealthService {
  return {
    key: `fleet/rover.3/svc/${instance}/health`, vehicleId: "rover.3", instance, alive: true,
    receivedAtMs: Date.now(), receivedMonoMs: performance.now(),
    source: ros ? "ros2" : "native", sourceLabel: ros ? "ROS 2 · domain 0 · /diagnostics" : "Zenoh JSON",
    ...(ros ? { fallbackTtlMs: 5000 } : { periodMs: 1000 }),
    snapshot: { schema_version: 1, service: ros ? "ouster" : "camera-service", instance,
      stamp_unix_ns: ros ? 0 : 1_750_000_000_000_000_000 + sequence * 1_000_000_000,
      level: 0, status: statuses },
  };
}

describe("health deltas through the real vehicle-state client and server", () => {
  let health: FakeHealth;
  let server: VehicleStateServer;
  const clients: VehicleStateClient[] = [];
  const discoveries: HealthDiscovery[] = [];
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const connect = (keys: string[], legacy = false) => {
    const link = new MeasuredLink(server, legacy);
    const client = new VehicleStateClient({ transport: link, base: BASE, minIntervalMs: 20, debounceMs: 0 });
    clients.push(client);
    const handles = keys.map((key) => client.acquire({ health: key }));
    return { client, link, handles, read: (index = 0) => client.getSnapshot(handles[index].key)!.health! };
  };
  const mirror = (connection: ReturnType<typeof connect>) => {
    const discovery = new HealthDiscovery(NO_TRANSPORT);
    discoveries.push(discovery);
    discovery.observe(() => undefined);
    connection.client.subscribe(connection.handles[0].key, () => {
      const current = connection.read();
      if (current) discovery.mirror(current);
    });
    return discovery;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    health = new FakeHealth();
    server = new VehicleStateServer({ store: new FakeStore(), health, epoch: "health-integration" });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    server.close();
    await Promise.all(discoveries.splice(0).map((discovery) => discovery.stop()));
    vi.useRealTimers();
  });

  it("keeps repeated observations fresh, then detects reporter silence despite successful unrelated polls", async () => {
    const publish = (sequence: number) => health.set([service("cam_front", [status("cam_front", "camera", sequence,
      { "temp.sensor_c": 40 })], sequence)]);
    publish(0);
    const connection = connect([CAMERA]);
    connection.client.acquire({ node: "/unrelated" });
    await advance(20);
    for (let sequence = 1; sequence <= 12; sequence++) {
      await advance(980);
      publish(sequence);
      await advance(20);
      const current = connection.read();
      expect(reporterCurrent(current, Date.now())).toBe(true);
      expect(statusCurrent(current, current.snapshot.status[0], Date.now())).toBe(true);
      expect(current.snapshot.status[0].values["health.sequence"]).toBe(sequence);
      expect(sampleAgeMs(current, current.snapshot.status[0], Date.now())).toBeLessThan(30);
    }
    expect(connection.link.polls.some(({ reply }) => reply.items.some(([, state]) => "hu" in state))).toBe(true);
    const lastReceived = connection.read().receivedMonoMs;
    const before = connection.link.polls.length;
    for (let i = 0; i < 7; i++) {
      await advance(980);
      server.setGraph(buildGraph(i % 2 === 0 ? [NODE] : []));
      await advance(20);
    }
    const silent = connection.read();
    expect(connection.link.polls.length - before).toBeGreaterThanOrEqual(7);
    expect(silent.receivedMonoMs).toBe(lastReceived);
    expect(reporterCurrent(silent, Date.now())).toBe(false);
    expect(statusCurrent(silent, silent.snapshot.status[0], Date.now())).toBe(false);
  });

  it("preserves independent ROS component ages when only one diagnostic row keeps arriving", async () => {
    const source = new HealthDiscovery(NO_TRANSPORT);
    discoveries.push(source);
    source.observe((services) => health.set(services));
    const topic = buildGraph([DIAGNOSTICS]).topics[0];
    const ingest = (rows: HealthStatus[]) => source.ingestRos(topic, { status: rows.map((row) => ({ ...row,
      values: Object.entries(row.values).map(([key, value]) => ({ key, value: String(value) })) })) }, 5000);
    ingest([status("lidar", "temperature", 0, { "temp.internal_c": 43 }), status("lidar", "power", 0, { "supply.voltage_v": 24 })]);
    const modern = connect([LIDAR]);
    const legacy = connect([LIDAR], true);
    await advance(20);
    for (let sequence = 1; sequence <= 7; sequence++) {
      await advance(980);
      ingest([status("lidar", "temperature", sequence, { "temp.internal_c": 43 })]);
      await advance(20);
      expect(modern.read()).toEqual(legacy.read());
    }
    const current = modern.read();
    const temperature = current.snapshot.status.find((row) => row.name.endsWith(": temperature"))!;
    const power = current.snapshot.status.find((row) => row.name.endsWith(": power"))!;
    expect(reporterCurrent(current, Date.now())).toBe(true);
    expect(statusCurrent(current, temperature, Date.now())).toBe(true);
    expect(statusCurrent(current, power, Date.now())).toBe(false);
    expect(sampleAgeMs(current, temperature, Date.now())).toBeLessThan(30);
    expect(sampleAgeMs(current, power, Date.now())).toBeGreaterThanOrEqual(7000);
  });

  it("keeps equal-valued new trend samples and replays alert events exactly once", async () => {
    const triggered = { id: "TEMP_HIGH", cursor: 1, active: true, level: "WARNING", msg: "temperature was high" };
    const cleared = { ...triggered, cursor: 2, active: false };
    const publish = (sequence: number, sample: number, age: number, clear = false) => health.set([service("cam_front", [
      status("cam_front", "camera", sequence, { "temp.sensor_c": 40 }, sample, age),
      status("cam_front", "sensor alerts", sequence, { "alerts.log": JSON.stringify(clear ? [triggered, cleared] : [triggered]),
        "alerts.epoch": "sensor-boot-1/0", "alerts.history_gap": false }, sample, age),
    ], sequence)]);
    publish(0, 0, 0);
    const modern = connect([CAMERA]);
    const legacy = connect([CAMERA], true);
    const compactMirror = mirror(modern);
    const fullMirror = mirror(legacy);
    await advance(20);
    for (let sequence = 1; sequence <= 3; sequence++) {
      await advance(980);
      publish(sequence, 0, sequence);
      await advance(20);
    }
    expect(compactMirror.series(CAMERA, "cam_front: camera", "temp.sensor_c")).toHaveLength(1);
    expect(compactMirror.events).toHaveLength(1);
    await advance(980);
    publish(4, 1, 0, true); // New observation with the same temperature is still a trend sample.
    await advance(20);
    await advance(980);
    publish(5, 1, 1, true);
    await advance(20);
    const points = compactMirror.series(CAMERA, "cam_front: camera", "temp.sensor_c");
    expect(points).toHaveLength(2);
    expect(points).toEqual(fullMirror.series(CAMERA, "cam_front: camera", "temp.sensor_c"));
    expect(compactMirror.events).toEqual(fullMirror.events);
    expect(compactMirror.events).toHaveLength(2);
    expect(compactMirror.events.map((event) => event.message)).toEqual([
      "cleared · temperature was high", "triggered · temperature was high",
    ]);
    expect(modern.read()).toEqual(legacy.read());
  });

  it("measures initial and steady poll bytes while reconstructing the same detailed services", async () => {
    // Ouster's bounded alert journal is a JSON string, alongside per-alert components; camera
    // stream/recording counters and temperatures change even during otherwise healthy operation.
    const journal = JSON.stringify(Array.from({ length: 32 }, (_, cursor) => ({ id: `SENSOR_ALERT_${cursor % 12}`,
      cursor, active: false, level: "WARNING", msg: `Sensor alert ${cursor % 12} cleared after recovery`,
      msg_verbose: "The sensor observation returned to its configured operating range; detailed historical context is retained.",
      realtime: String(1_750_000_000_000_000_000 + cursor * 1_000_000_000) })));
    const publish = (sequence: number) => {
      const camera = service("cam_front", [
        status("cam_front", "camera", sequence, { "temp.sensor_c": 40 + sequence / 10, "temp.mainboard_c": 42,
          "supply.voltage_v": 12, "supply.current_a": 0.5, "supply.power_w": 6, "ptp.state": "Slave" }),
        status("cam_front", "stream", sequence, { frames: sequence * 30, "fps.delivered": 30, "fps.expected": 30,
          frame_age_s: 0.01, source_gaps: 0, frames_missing: 0, publish_drops: 0, "aravis.n_completed_buffers": sequence * 30 }),
        status("cam_front", "recording", sequence, { state: "active", enabled: true, frames: sequence * 30,
          segments: 1, encoder: "h264", "disk.free_bytes": 120_000_000_000 - sequence * 1_000_000 }),
      ], sequence);
      const lidar = service("lidar", [
        status("lidar", "service", sequence, { state: "active", target: "active" }),
        status("lidar", "stream", sequence, { "packets.received": sequence * 1024, packet_age_s: 0.001 }),
        status("lidar", "temperature", sequence, { "temp.internal_c": 46 }),
        status("lidar", "power", sequence, { "supply.voltage_v": 24, "supply.current_a": 0.8, "supply.power_w": 19.2 }),
        status("lidar", "sensor alerts", sequence, { "alerts.active": 0, "alerts.history_gap": false,
          "alerts.epoch": "sensor-boot/0", "alerts.log": journal }),
        ...Array.from({ length: 12 }, (_, i) => status("lidar", `alert/SENSOR_ALERT_${i}`, sequence,
          { "alert.code": `SENSOR_ALERT_${i}`, "alert.category": "SENSOR", "alert.active": false,
            "alert.severity": "WARNING", "alert.detail": "The sensor has recovered and the alert is cleared.", "alert.cursor": i })),
      ], sequence, true);
      health.set([camera, lidar]);
    };
    publish(0);
    const compact = connect([CAMERA, LIDAR]);
    const full = connect([CAMERA, LIDAR], true);
    await advance(20);
    expect(compact.link.polls).toHaveLength(1);
    expect(full.link.polls).toHaveLength(1);
    const initialCompact = compact.link.polls[0].bytes;
    const initialFull = full.link.polls[0].bytes;
    for (let sequence = 1; sequence <= 20; sequence++) {
      await advance(980);
      publish(sequence);
      await advance(20);
      for (let i = 0; i < 2; i++) {
        expect(compact.read(i)).toEqual(full.read(i));
        expect(reporterCurrent(compact.read(i), Date.now())).toBe(true);
      }
    }
    expect(compact.link.polls).toHaveLength(21);
    expect(full.link.polls).toHaveLength(21);
    expect(compact.link.calls.filter((call) => call.op === "poll").every((call) =>
      (call.body as { health_delta?: number }).health_delta === 1)).toBe(true);
    expect(full.link.calls.filter((call) => call.op === "poll").every((call) =>
      (call.body as { health_delta?: number }).health_delta === undefined)).toBe(true);
    const steadyCompact = compact.link.polls.slice(1).reduce((sum, poll) => sum + poll.bytes, 0);
    const steadyFull = full.link.polls.slice(1).reduce((sum, poll) => sum + poll.bytes, 0);
    expect(steadyCompact).toBeLessThan(steadyFull * 0.5);
    expect(compact.read(1).snapshot.status.find((row) => row.name.endsWith(": sensor alerts"))!.values["alerts.log"]).toBe(journal);
    console.info(`Health delta encoded poll replies: initial full=${initialFull} B compact=${initialCompact} B; ` +
      `20 steady replies full=${steadyFull} B compact=${steadyCompact} B; reduction=${((1 - steadyCompact / steadyFull) * 100).toFixed(2)}%; ` +
      `total full=${initialFull + steadyFull} B compact=${initialCompact + steadyCompact} B`);
  });
});
