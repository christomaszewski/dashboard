// Harness for tools/test_vehicle_state_link.mjs (bundled by it; not run directly). What an operator
// sees through an impaired radio hop, raw topics vs vehicle state, against a RUNNING bench stack
// (dash-up with `vehicle_state: true`). Two operator sessions built from the app's own transport,
// TopicStore and VehicleStateClient, each through its own radio (tools/radio_link.sh) with the same
// netem profile:
//   vehicle state — the IMU stamp plus the map's heading and position items
//   direct        — raw /imu/data and /fix through TopicStore, as a page without vehicle state
// The synthetic publisher stamps every IMU message with this machine's wall clock, so the age of the
// value an operator would display is now − header.stamp. Sampled every 100 ms.
import { spawn, spawnSync } from "node:child_process";
import { ZenohRemoteApiTransport } from "../app/src/transport/zenohRemoteApi";
import { TopicStore } from "../app/src/ros/topicStore";
import { FlavorResolver } from "../app/src/schema/resolver";
import { ROS2_LIVELINESS_GLOB, buildGraph } from "../app/src/ros/graph";
import { VehicleStateClient } from "../app/src/vstate/client";
import { publisher } from "./vehicle_state_e2e.mjs";

let RADIO = ""; // tools/radio_link.sh, passed in by the launcher (this file runs from a bundle elsewhere)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_PROFILES = [
  { name: "clean", netem: null },
  { name: "latency ~300ms RTT", netem: "delay 150ms 20ms" },
  { name: "loss 5%", netem: "delay 50ms loss 5%" },
  { name: "loss 15%", netem: "delay 50ms loss 15%" },
  { name: "narrow 400kbit + 1% loss", netem: "delay 50ms loss 1% rate 400kbit" },
  { name: "very narrow 128kbit", netem: "delay 100ms rate 128kbit" },
  { name: "flapping 6s up/3s down", netem: "delay 50ms", flap: [6, 3, 2] },
  { name: "outage 12s", netem: "delay 50ms", outage: 12 },
];

// ---- metered WebSockets ------------------------------------------------------------------------
const meters = [];
let label = "";
const size = (d) => (typeof d === "string" ? Buffer.byteLength(d) : d?.byteLength ?? d?.size ?? 0);
class MeteredWebSocket extends globalThis.WebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    const meter = { label, rx: 0, tx: 0, closed: false };
    meters.push(meter);
    this.linkMeter = meter;
    this.addEventListener("message", (e) => (meter.rx += size(e.data)));
    this.addEventListener("close", () => (meter.closed = true));
  }
  send(data) {
    this.linkMeter.tx += size(data);
    return super.send(data);
  }
}
globalThis.WebSocket = MeteredWebSocket;
const bytes = (name) => meters.filter((m) => m.label === name).reduce((a, m) => ({ rx: a.rx + m.rx, tx: a.tx + m.tx }), { rx: 0, tx: 0 });
const socketClosed = (name) => meters.some((m) => m.label === name && m.closed);

async function open(locator, as) {
  label = as;
  return ZenohRemoteApiTransport.open(locator, undefined, 5000);
}
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
async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function radio(...args) {
  const out = spawnSync(RADIO, args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`radio_link.sh ${args.join(" ")}: ${out.stderr || out.stdout}`);
  return out.stdout;
}
const exited = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
const stampMs = (sec, nanosec) => (sec !== undefined ? Number(sec) * 1000 + Number(nanosec) / 1e6 : NaN);
const at = (msg, path) => msg?.[path] ?? path.split(".").reduce((o, k) => o?.[k], msg);
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN);

export async function run({ key, sidecarPort, radioPorts, window, profiles, publish, radioScript }) {
  RADIO = radioScript;
  const radios = ["a", "b"];
  const cleanup = [];
  try {
    radios.forEach((r, i) => radio("up", `link-${r}`, String(radioPorts[i]), String(sidecarPort)));
    cleanup.push(() => radios.forEach((r) => spawnSync(RADIO, ["down", `link-${r}`])));
    if (publish) {
      label = "publisher";
      const pub = await publisher(`ws/127.0.0.1:${sidecarPort}`);
      cleanup.push(() => pub.close().catch(() => undefined));
    }

    // Vehicle state through radio a.
    const va = await open(`ws/127.0.0.1:${radioPorts[0]}`, "vehicle");
    const vg = await graphOf(va); // phase-1 pages still follow the graph for other tabs
    const client = new VehicleStateClient({ transport: va, base: key });
    const stamp = client.acquire({ topic: "/imu/data", fields: [{ p: "header.stamp.sec" }, { p: "header.stamp.nanosec" }] });
    client.acquire({ topic: "/imu/data", fields: [{ p: "orientation", q: 1e-3 }, { p: "orientation_covariance.0" }] });
    client.acquire({ topic: "/fix", fields: [{ p: "latitude", q: 1e-7 }, { p: "longitude", q: 1e-7 }] });
    cleanup.push(async () => { client.close(); await vg.close(); await va.close().catch(() => undefined); });
    const vehicleShown = () => {
      const s = client.getSnapshot(stamp.key);
      return { at: stampMs(at(s?.message, "header.stamp.sec"), at(s?.message, "header.stamp.nanosec")), err: s?.error, stale: s?.stale };
    };

    // Raw topics through radio b.
    const db = await open(`ws/127.0.0.1:${radioPorts[1]}`, "direct");
    const dg = await graphOf(db);
    await until(() => ["/imu/data", "/fix"].every((n) => dg.state.graph.topics.some((t) => t.name === n)), "/imu/data and /fix in the graph");
    const store = new TopicStore({ transport: db, resolver: new FlavorResolver(db) });
    const entries = ["/imu/data", "/fix"].map((n) => dg.state.graph.topics.find((t) => t.name === n));
    entries.forEach((e) => store.acquire(e));
    cleanup.push(async () => { store.closeAll(); await dg.close(); await db.close().catch(() => undefined); });
    const directShown = () => {
      const s = store.getSnapshot(entries[0].dataKeyexpr);
      return { at: stampMs(s?.message?.header?.stamp?.sec, s?.message?.header?.stamp?.nanosec), err: s?.error };
    };

    await until(() => Number.isFinite(vehicleShown().at) && Number.isFinite(directShown().at), "values on both paths");
    const rows = [];
    for (const prof of profiles) {
      for (const r of radios) radio(prof.netem ? "set" : "clear", `link-${r}`, ...(prof.netem ? prof.netem.split(" ") : []));
      await sleep(3000);
      const b0 = { v: bytes("vehicle"), d: bytes("direct") };
      const t0 = Date.now();
      const events = [];
      if (prof.flap) for (const r of radios) events.push(spawn(RADIO, ["flap", `link-${r}`, ...prof.flap.map(String)], { stdio: "ignore" }));
      if (prof.outage) for (const r of radios) events.push(spawn(RADIO, ["outage", `link-${r}`, String(prof.outage)], { stdio: "ignore" }));
      const ages = { v: [], d: [] };
      const notes = { vErr: 0, vStale: 0, dErr: 0, vErrText: new Set() };
      while (Date.now() - t0 < window * 1000) {
        const now = Date.now();
        const v = vehicleShown();
        const d = directShown();
        ages.v.push(now - v.at);
        ages.d.push(now - d.at);
        if (v.err) (notes.vErr += 1), notes.vErrText.add(v.err.slice(0, 60));
        if (v.stale) notes.vStale += 1;
        if (d.err) notes.dErr += 1;
        await sleep(100);
      }
      await Promise.all(events.map(exited));
      const s = (Date.now() - t0) / 1000;
      const b1 = { v: bytes("vehicle"), d: bytes("direct") };
      // Drain: a clean link, then the time until each path shows a value under a second old again.
      for (const r of radios) radio("clear", `link-${r}`);
      const tDrain = Date.now();
      const drained = { v: NaN, d: NaN };
      while (Date.now() - tDrain < 90_000 && (Number.isNaN(drained.v) || Number.isNaN(drained.d))) {
        const now = Date.now();
        if (Number.isNaN(drained.v) && now - vehicleShown().at < 1000) drained.v = (now - tDrain) / 1000;
        if (Number.isNaN(drained.d) && now - directShown().at < 1000) drained.d = (now - tDrain) / 1000;
        await sleep(100);
      }
      const row = (k) => {
        const xs = ages[k].sort((x, y) => x - y);
        return {
          p50: pct(xs, 50), p95: pct(xs, 95), max: xs.at(-1), over1s: xs.filter((a) => a > 1000).length / xs.length,
          rx: (b1[k].rx - b0[k].rx) / s, tx: (b1[k].tx - b0[k].tx) / s, drain: drained[k],
        };
      };
      rows.push({ name: prof.name, v: row("v"), d: row("d"), notes: { ...notes, vErrText: [...notes.vErrText] },
        closed: { v: socketClosed("vehicle"), d: socketClosed("direct") } });
      console.log(`done: ${prof.name}`);
    }
    return rows;
  } finally {
    for (const c of cleanup.reverse()) await c();
  }
}
