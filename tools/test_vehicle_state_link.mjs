// Vehicle state over a bad radio (docs/VEHICLE_STATE.md, "On an impaired link"): the age of what an
// operator sees, raw topics vs vehicle state, through simulated radios (tools/radio_link.sh) with
// latency, loss, narrow bandwidth, flapping and outages. Bench only: runs against a stack started by
// dash-up with `vehicle_state: true` and publishes synthetic /imu/data and /fix through its sidecar,
// so do not point it at a vehicle with real publishers of those topics.
//
//   STATE_KEY=fleet/<vehicle>/dash/<name>/state node tools/test_vehicle_state_link.mjs [profiles.json]
//     STATE_KEY     the key dash-up prints as vehicle-state=…            (required)
//     SIDECAR_PORT  the stack's ws_port                                    (default 10000)
//     RADIO_PORTS   laptop ports for the two radios                        (default 12000,12001)
//     WINDOW        seconds measured per profile                           (default 20)
//     PUBLISH=0     use publishers already running instead of the synthetic ones
//   profiles.json: [{ "name": "...", "netem": "delay 50ms loss 5%" | null, "flap": [up, down, cycles]?,
//                     "outage": seconds? }]   (default: tools/vehicle_state_link.mjs DEFAULT_PROFILES)
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleForNode } from "../app/scripts/build-state.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const key = process.env.STATE_KEY;
if (!key) throw new Error("set STATE_KEY to the key dash-up prints as vehicle-state=…");
const dir = await mkdtemp(join(tmpdir(), "vstate-link-"));
try {
  await bundleForNode(here("./vehicle_state_link.mjs"), join(dir, "harness.mjs"));
  const { run, DEFAULT_PROFILES } = await import(pathToFileURL(join(dir, "harness.mjs")).href);
  const profiles = process.argv[2] ? JSON.parse(await readFile(process.argv[2], "utf8")) : DEFAULT_PROFILES;
  const rows = await run({
    key,
    sidecarPort: Number(process.env.SIDECAR_PORT || 10000),
    radioPorts: (process.env.RADIO_PORTS || "12000,12001").split(",").map(Number),
    window: Number(process.env.WINDOW || 20),
    profiles,
    publish: process.env.PUBLISH !== "0",
    radioScript: here("./radio_link.sh"),
  });
  const s = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2).padStart(6) : "   n/a");
  const kb = (b) => (b / 1024).toFixed(1).padStart(7);
  console.log("\nage of the displayed IMU value (s)               p50    p95    max  >1s%  rx KB/s tx KB/s  drain s");
  for (const r of rows) {
    for (const [k, path] of [["v", "vehicle state"], ["d", "direct"]]) {
      const x = r[k];
      const drain = Number.isFinite(x.drain) ? x.drain.toFixed(1).padStart(7) : "    >90";
      console.log(`${(k === "v" ? r.name : "").padEnd(28)} ${path.padEnd(13)} ${s(x.p50)} ${s(x.p95)} ${s(x.max)} ${(x.over1s * 100).toFixed(0).padStart(4)}% ${kb(x.rx)} ${kb(x.tx)} ${drain}`);
    }
    const n = r.notes;
    if (n.vErr || n.vStale || n.dErr || r.closed.v || r.closed.d)
      console.log(`${"".padEnd(28)} notes: vehicle errors=${n.vErr} stale=${n.vStale} ${n.vErrText.join("; ")} | direct errors=${n.dErr} | sockets closed vehicle=${r.closed.v} direct=${r.closed.d}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
// zenoh-ts keeps timers alive after its sessions close; the table is printed.
setTimeout(() => process.exit(0), 500).unref();
