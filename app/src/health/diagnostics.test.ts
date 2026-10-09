import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRos2StaticDecoder } from "../schema/decoders/staticDefs";
import { buildGraph } from "../ros/graph";
import type { Sample, Transport } from "../transport/types";
import { HealthDiscovery } from "./discovery";
import { diagnosticStatuses } from "./diagnostics";
import { healthVerdict, statusCurrent, type HealthService } from "./types";
import { RosHealthSource } from "./rosSource";
import { parseHealthOptions } from "./config";
import fixtures from "./ros-fixtures.json";

const topic = buildGraph(["@ros2_lv/0/z/1/2/MP/%/%/reporter/%diagnostics/diagnostic_msgs::msg::dds_::DiagnosticArray_/hash/::,10::::"]).topics[0];
const row = (instance: string, component = "camera", level = 0, extras: Record<string, string> = {}) => ({
  level, name: `${instance}: ${component}`, message: level === 2 ? "fault" : "OK", hardware_id: "sensor",
  values: Object.entries({ "health.vehicle_id": "v1", "health.instance": instance, "health.service": "sensor",
    "health.publisher_id": instance + "-boot", "health.sequence": "1", "health.sample_id": "sample-1",
    "health.sample_age_s": "0", "health.stale_after_s": "5", "temp.device_c": "42", ...extras }).map(([key, value]) => ({ key, value })),
});
const transport = () => ({ liveliness: { subscribe: vi.fn(async () => ({ close: vi.fn() })) }, subscribe: vi.fn(async () => ({ close: vi.fn() })) }) as unknown as Transport;
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
afterEach(() => vi.useRealTimers());

async function store() {
  const t = transport(), d = new HealthDiscovery(t);
  let services: HealthService[] = [];
  await d.start((s) => { services = s; });
  return { d, t, services: () => services };
}

describe("ROS diagnostics interoperability", () => {
  it("decodes actual Lyrical CDR from the Ouster producer, including nested KeyValue and byte levels", async () => {
    const decoder = await buildRos2StaticDecoder("diagnostic_msgs/msg/DiagnosticArray");
    const { d, services } = await store();
    d.ingestRos(topic, decoder.decode(bytes(fixtures.diagnostics)));
    expect(decoder.lastWarning?.()).toBeUndefined();
    expect(services()).toHaveLength(1);
    const sensor = services()[0];
    expect(sensor.instance).toBe("lidar");
    expect(sensor.snapshot.status.find((s) => s.name.endsWith(": power"))?.values["supply.power_w"]).toBe(17.893348);
    expect(healthVerdict(sensor, sensor.snapshot.status, Date.now()).text).toBe("ERROR");
    const temperature = await buildRos2StaticDecoder("sensor_msgs/msg/Temperature");
    expect(temperature.decode(bytes(fixtures.temperature))).toMatchObject({ temperature: 45.5, variance: 0 });
  });

  it("merges publishers and components independently, retaining faults when another component expires", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const { d, services } = await store();
    d.ingestRos(topic, { status: [row("a"), row("a", "power", 2)] });
    d.ingestRos(topic, { status: [row("b")] });
    expect(services()).toHaveLength(2);
    vi.setSystemTime(-1000000); // wall-clock corrections must not extend freshness
    vi.advanceTimersByTime(6000);
    d.ingestRos(topic, { status: [row("a", "power", 2, { "health.sequence": "2" })] });
    const a = services()[0];
    expect(a.snapshot.status).toHaveLength(2);
    expect(statusCurrent(a, a.snapshot.status.find((s) => s.name === "a: camera")!, 16000)).toBe(false);
    expect(healthVerdict(a, a.snapshot.status, 16000)).toMatchObject({ text: "ERROR · STALE", level: "err" });
  });

  it("ignores duplicates, older publications and retired boots; cached observations add no trend points", async () => {
    const { d, services } = await store();
    const emit = (extras: Record<string, string> = {}) => d.ingestRos(topic, { status: [row("a", "camera", 0, extras)] });
    emit(); emit(); emit({ "health.sequence": "0", "temp.device_c": "10" });
    emit({ "health.sequence": "2", "health.sample_age_s": "3" });
    expect(d.series(services()[0].key, "a: camera", "temp.device_c")).toHaveLength(1);
    emit({ "health.publisher_id": "new-boot", "health.sample_id": "new-sample", "temp.device_c": "43" });
    emit({ "health.sequence": "99", "temp.device_c": "10" });
    expect(services()[0].snapshot.status[0].values["temp.device_c"]).toBe(43);
  });

  it("keeps unknown ROS fields as strings and separates domains without fleet metadata", async () => {
    const parsed = diagnosticStatuses({ status: [{ level: 0, name: "custom", values: [{ key: "serial", value: "00123" }, { key: "supply.power_w", value: "NaN" }] }] });
    expect(parsed[0].values).toEqual({ serial: "00123", "supply.power_w": null });
    const { d, services } = await store();
    for (const domainId of [0, 1]) d.ingestRos({ ...topic, domainId }, { status: [{ level: 0, name: "custom", values: [] }] });
    expect(services()).toHaveLength(2);
    expect(healthVerdict(services()[0], [], Date.now()).text).toBe("unknown");
  });

  it("starts a new component inventory on reporter restart without resurrecting old-boot alerts", async () => {
    const { d, services } = await store();
    d.ingestRos(topic, { status: [row("a", "alert/OLD", 2)] });
    d.ingestRos(topic, { status: [row("a", "service", 0, { "health.publisher_id": "boot-2" })] });
    d.ingestRos(topic, { status: [row("a", "alert/OLD", 2, { "health.sequence": "99" })] });
    expect(services()[0].snapshot.status.map((s) => s.name)).toEqual(["a: service"]);
    expect(d.events.some((e) => e.name === "a: alert/OLD")).toBe(true);
  });

  it("deduplicates bounded sensor log events and preserves explicit clears", async () => {
    const { d } = await store();
    const log = JSON.stringify([{ id: "ERR", cursor: 1, active: true, level: "ERROR", msg: "fault" }, { id: "ERR", cursor: 2, active: false, level: "ERROR", msg: "fault" }]);
    for (const sequence of [1, 2]) d.ingestRos(topic, { status: [row("a", "sensor alerts", 0, { "health.sequence": String(sequence), "alerts.log": log })] });
    expect(d.events.map((e) => e.message)).toEqual(["cleared · fault", "triggered · fault"]);
  });

  it("feeds every array from the raw stream pool rather than coalescing publishers", async () => {
    const { d, t, services } = await store();
    let receive: (s: Sample) => void = () => undefined;
    t.subscribe = vi.fn(async (_key, cb) => { receive = cb; return { close: async () => undefined }; });
    const source = new RosHealthSource(t, { resolve: async () => ({ decode: (b) => JSON.parse(new TextDecoder().decode(b)) }) }, d, () => undefined);
    source.update([topic]);
    await new Promise((r) => setTimeout(r, 0));
    for (const name of ["a", "b"]) receive({ keyexpr: topic.dataKeyexpr, kind: "put", payload: new TextEncoder().encode(JSON.stringify({ status: [row(name)] })) });
    expect(services()).toHaveLength(2);
    source.close();
  });

  it("validates explicit topic/domain selection and the generic diagnostic timeout", () => {
    expect(parseHealthOptions({ ros_topics: ["/diagnostics"], ros_domains: [0], ros_stale_after_s: 30 })).toMatchObject({ ros_stale_after_s: 30 });
    for (const bad of [{ ros_stale_after_s: 0 }, { ros_domains: [-1] }, { ros_topics: ["relative"] }]) expect(() => parseHealthOptions(bad)).toThrow();
  });
});
