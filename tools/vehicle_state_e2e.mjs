// Harness for tools/test_vehicle_state.mjs (bundled by it; not run directly). Imports the real app
// modules, so the operator sessions below are the browser's own code paths running in Node.
import { spawn } from "node:child_process";
import { Config, Session } from "@eclipse-zenoh/zenoh-ts";
import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import { ros2jazzy } from "@foxglove/rosmsg-msgs-common";
import { ZenohRemoteApiTransport } from "../app/src/transport/zenohRemoteApi";
import { TopicStore } from "../app/src/ros/topicStore";
import { FlavorResolver } from "../app/src/schema/resolver";
import { ROS2_LIVELINESS_GLOB, buildGraph } from "../app/src/ros/graph";
import { VehicleStateClient } from "../app/src/vstate/client";
import { extractHeading, extractLatLon } from "../app/src/home/geo";

const SECONDS = Number(process.env.SECONDS || 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- metered WebSockets: every byte an operator session sends or receives ------------------------
const meters = [];
let label = "";
const size = (d) => (typeof d === "string" ? Buffer.byteLength(d) : d?.byteLength ?? d?.size ?? 0);
class MeteredWebSocket extends globalThis.WebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    const meter = { label, rx: 0, tx: 0, rxMessages: 0 };
    meters.push(meter);
    this.meter = meter;
    this.addEventListener("message", (e) => {
      meter.rx += size(e.data);
      meter.rxMessages += 1;
    });
  }
  send(data) {
    this.meter.tx += size(data);
    return super.send(data);
  }
}
globalThis.WebSocket = MeteredWebSocket;

async function open(locator, as) {
  for (let i = 0; ; i++) {
    label = as;
    try {
      return await ZenohRemoteApiTransport.open(locator, undefined, 3000);
    } catch (e) {
      if (i > 40) throw e;
      await sleep(250);
    }
  }
}

function measure(name) {
  const live = () => meters.filter((m) => m.label === name);
  const start = live().reduce((a, m) => ({ rx: a.rx + m.rx, tx: a.tx + m.tx, n: a.n + m.rxMessages }), { rx: 0, tx: 0, n: 0 });
  const t0 = performance.now();
  return () => {
    const end = live().reduce((a, m) => ({ rx: a.rx + m.rx, tx: a.tx + m.tx, n: a.n + m.rxMessages }), { rx: 0, tx: 0, n: 0 });
    const s = (performance.now() - t0) / 1000;
    return { rxPerS: (end.rx - start.rx) / s, txPerS: (end.tx - start.tx) / s, msgsPerS: (end.n - start.n) / s };
  }
}

// ---- processes -----------------------------------------------------------------------------------
const children = [];
function bridge(name, args) {
  if (process.env.BRIDGE_BIN) {
    const child = spawn(process.env.BRIDGE_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    children.push({ name, kill: () => child.kill("SIGTERM") });
    return;
  }
  const image = process.env.BRIDGE_IMAGE || "dashboard-zenoh:local";
  const container = `vstate-e2e-${name}-${process.pid}`;
  spawn("docker", ["run", "--rm", "--network", "host", "--name", container, image, ...args], { stdio: "ignore" });
  children.push({ name, kill: () => spawn("docker", ["rm", "-f", container], { stdio: "ignore" }) });
}

// ---- an rmw_zenoh-shaped publisher ----------------------------------------------------------------
function defs(root) {
  const out = [];
  const seen = new Set([root]);
  for (const queue = [root]; queue.length > 0; ) {
    const def = ros2jazzy[queue.shift()];
    out.push(def);
    for (const f of def.definitions) if (f.isComplex && !seen.has(f.type)) seen.add(f.type), queue.push(f.type);
  }
  return out;
}

const T0 = Date.now();
const PARKED = process.env.MOTION === "parked"; // sensor noise only: the change-only best case
const truth = (t) => {
  if (PARKED) t = 0;
  const yawEnuDeg = 30 + 10 * t; // turning at 10°/s
  return { yawEnuDeg, compass: (((90 - yawEnuDeg) % 360) + 360) % 360, lat: 40.4433 + t / 111_320, lon: -79.9436 };
};

export async function publisher(locator) {
  const session = await Session.open(new Config(locator, 3000));
  const zid = (await session.info()).zid().toString();
  const topics = {
    imu: { name: "imu/data", type: "sensor_msgs::msg::dds_::Imu_", hash: "RIHS01_a1", def: "sensor_msgs/Imu", node: "imu_driver" },
    fix: { name: "fix", type: "sensor_msgs::msg::dds_::NavSatFix_", hash: "RIHS01_b2", def: "sensor_msgs/NavSatFix", node: "gnss_driver" },
  };
  const pubs = {};
  let eid = 1;
  for (const [k, t] of Object.entries(topics)) {
    await session.liveliness().declareToken(
      `@ros2_lv/0/${zid}/${eid}/${eid}/MP/%/%/${t.node}/%${t.name.replaceAll("/", "%")}/${t.type}/${t.hash}/2:2:1,10`);
    eid += 1;
    pubs[k] = { writer: new MessageWriter(defs(t.def)), pub: await session.declarePublisher(`0/${t.name}/${t.type}/${t.hash}`) };
  }
  const header = (frame_id) => {
    const ms = Date.now();
    return { stamp: { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 }, frame_id };
  };
  const cov = Array(9).fill(0.01);
  const noise = (scale) => (Math.random() - 0.5) * scale;
  const imu = setInterval(() => {
    const yaw = ((truth((Date.now() - T0) / 1000).yawEnuDeg + noise(0.04)) * Math.PI) / 180;
    void pubs.imu.pub.put(pubs.imu.writer.writeMessage({
      header: header("imu_link"),
      orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
      orientation_covariance: cov,
      angular_velocity: { x: noise(0.01), y: noise(0.01), z: 0.1745 + noise(0.01) },
      angular_velocity_covariance: cov,
      linear_acceleration: { x: noise(0.1), y: noise(0.1), z: 9.81 + noise(0.1) },
      linear_acceleration_covariance: cov,
    }));
  }, 5); // ~200 Hz
  const fix = setInterval(() => {
    const p = truth((Date.now() - T0) / 1000);
    void pubs.fix.pub.put(pubs.fix.writer.writeMessage({
      header: header("gps"),
      status: { status: 2, service: 1 },
      latitude: p.lat + noise(2e-7),
      longitude: p.lon + noise(2e-7),
      altitude: 280 + noise(0.05),
      position_covariance: cov,
      position_covariance_type: 2,
    }));
  }, 100); // 10 Hz
  return { stopImu: () => clearInterval(imu), close: async () => { clearInterval(imu); clearInterval(fix); await session.close(); } };
}

// ---- operator sessions ---------------------------------------------------------------------------
async function graphOf(transport) {
  const tokens = new Set();
  const state = { graph: buildGraph([]) };
  const sub = await transport.liveliness.subscribe(ROS2_LIVELINESS_GLOB, (e) => {
    if (e.alive) tokens.add(e.keyexpr);
    else tokens.delete(e.keyexpr);
    state.graph = buildGraph(tokens);
  });
  return { state, close: () => sub.close() };
}

async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const heading = { topic: "/imu/data", fields: [{ p: "orientation", q: 1e-3 }, { p: "orientation_covariance.0" }] };
const position = { topic: "/fix", fields: [{ p: "latitude", q: 1e-7 }, { p: "longitude", q: 1e-7 }] };
const angleError = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function check(failures, name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

export async function run() {
  const base = 20_000 + Math.floor(Math.random() * 9_000);
  const ports = { router: base, public: base + 1, private: base + 2 };
  const key = "fleet/e2e/dash/dash/state";
  const failures = [];
  let pub;
  let serviceLog = "";
  let client;
  let items = [];
  try {
    // The vehicle: a router that also serves the public WebSocket, and the private state bridge.
    bridge("router", ["--mode", "peer", "--listen", `tcp/127.0.0.1:${ports.router}`, "--no-multicast-scouting", "--ws-port", `127.0.0.1:${ports.public}`]);
    // A client-mode bridge exits when no router answers at startup (compose restarts it on a vehicle).
    label = "probe";
    await (await open(`ws/127.0.0.1:${ports.public}`, "probe")).close();
    bridge("state", ["--mode", "client", "--connect", `tcp/127.0.0.1:${ports.router}`, "--no-multicast-scouting", "--ws-port", `127.0.0.1:${ports.private}`]);
    const service = spawn(process.execPath, [process.env.STATE_BUNDLE], {
      env: { ...process.env, DASH_STATE_KEY: key, DASH_STATE_LOCATOR: `ws/127.0.0.1:${ports.private}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", (d) => (serviceLog += d));
    service.stderr.on("data", (d) => (serviceLog += d));
    children.push({ name: "dashboard-state", kill: () => service.kill("SIGTERM") });
    label = "publisher";
    pub = await publisher(`ws/127.0.0.1:${ports.public}`);

    // 1. Direct: what the browser does today — raw samples through the shared TopicStore.
    const direct = await open(`ws/127.0.0.1:${ports.public}`, "direct");
    const dg = await graphOf(direct);
    await until(() => dg.state.graph.topics.length === 2, "the direct graph");
    const store = new TopicStore({ transport: direct, resolver: new FlavorResolver(direct) });
    const entries = ["/imu/data", "/fix"].map((n) => dg.state.graph.topics.find((t) => t.name === n));
    const handles = entries.map((e) => store.acquire(e));
    await until(() => store.getSnapshot(entries[0].dataKeyexpr)?.message, "a decoded direct IMU message");
    await sleep(2000);
    const directBytes = measure("direct");
    await sleep(SECONDS * 1000);
    const d = directBytes();
    const directHeading = extractHeading(store.getSnapshot(entries[0].dataKeyexpr).message, {});
    handles.forEach((h) => h.release());
    store.closeAll();
    await dg.close();
    await direct.close();

    // 2. Vehicle state: the same two widgets (the map's position and heading) through dashboard-state.
    const vehicle = await open(`ws/127.0.0.1:${ports.public}`, "vehicle");
    const vg = await graphOf(vehicle); // phase 1 browsers still follow the graph for other tabs
    client = new VehicleStateClient({ transport: vehicle, base: key });
    items = [heading, position].map((s) => client.acquire(s));
    await until(() => items.every((i) => client.getSnapshot(i.key)?.message), "vehicle-state values", 20_000);
    await sleep(2000);
    const vehicleBytes = measure("vehicle");
    await sleep(SECONDS * 1000);
    const v = vehicleBytes();

    const now = truth((Date.now() - T0) / 1000);
    const h = extractHeading(client.getSnapshot(items[0].key).message, {});
    const p = extractLatLon(client.getSnapshot(items[1].key).message, "latitude", "longitude");
    console.log("");
    console.log("operator WebSocket, steady state (bytes/s)   received     sent   messages/s");
    for (const [name, r] of [["direct (raw topics)", d], ["vehicle state", v]])
      console.log(`  ${name.padEnd(40)} ${r.rxPerS.toFixed(0).padStart(8)} ${r.txPerS.toFixed(0).padStart(8)} ${r.msgsPerS.toFixed(1).padStart(12)}`);
    console.log(`  reduction in received bytes: ${(d.rxPerS / v.rxPerS).toFixed(1)}×\n`);

    check(failures, "vehicle state receives under a tenth of the direct bytes", v.rxPerS * 10 < d.rxPerS,
      `${v.rxPerS.toFixed(0)} vs ${d.rxPerS.toFixed(0)} B/s`);
    check(failures, "vehicle heading tracks the turning IMU", h !== null && angleError(h, now.compass) < 3,
      `${h?.toFixed(2)}° vs ${now.compass.toFixed(2)}°`);
    check(failures, "direct and vehicle headings agree on the same data", directHeading !== null);
    check(failures, "vehicle position tracks the moving fix", p !== null && Math.abs(p.lat - now.lat) < 3e-6 && Math.abs(p.lon - now.lon) < 1e-6,
      p ? `Δlat ${((p.lat - now.lat) * 111_320).toFixed(2)} m` : "no fix");
    check(failures, "only requested fields cross the link", Object.keys(client.getSnapshot(items[0].key).message).sort().join() === "orientation,orientation_covariance");

    // 3. Silence becomes state: stop the IMU; the fix keeps publishing.
    pub.stopImu();
    await sleep(7000);
    check(failures, "a silent IMU is marked stale", client.getSnapshot(items[0].key).stale === true);
    check(failures, "a live fix is not stale", !client.getSnapshot(items[1].key).stale);

    // 4. A service restart costs one re-registration, not a reload.
    service.kill("SIGTERM");
    await sleep(500);
    const again = spawn(process.execPath, [process.env.STATE_BUNDLE], {
      env: { ...process.env, DASH_STATE_KEY: key, DASH_STATE_LOCATOR: `ws/127.0.0.1:${ports.private}` }, stdio: "ignore" });
    children.push({ name: "dashboard-state (restarted)", kill: () => again.kill("SIGTERM") });
    const before = client.getSnapshot(items[1].key);
    await until(() => client.getSnapshot(items[1].key) !== before && !client.getSnapshot(items[1].key).error, "values after the service restart", 20_000);
    check(failures, "values resume after a service restart", true);

    client.close();
    await vg.close();
    await vehicle.close();
  } catch (e) {
    console.error("FAIL:", e);
    failures.push(String(e));
    for (const i of items) console.log("snapshot:", JSON.stringify(client?.getSnapshot(i.key), (_, v) => (typeof v === "bigint" ? `${v}` : v)));
  } finally {
    if (failures.length) console.log(`\ndashboard-state log:\n${serviceLog}`);
    await pub?.close().catch(() => undefined);
    for (const c of children.reverse()) c.kill();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  return failures.length ? 1 : 0;
}
