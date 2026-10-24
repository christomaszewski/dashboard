// End-to-end check of vehicle state (docs/VEHICLE_STATE.md) with real Zenoh: a router that also
// serves the public WebSocket, the private state bridge, the bundled dashboard-state service, a
// publisher shaped like rmw_zenoh (200 Hz sensor_msgs/Imu, 10 Hz NavSatFix), and two operator
// sessions on the public WebSocket — one reading raw topics through the browser's TopicStore, one
// through vehicle state. Reports the bytes each operator socket carries and checks values,
// staleness and recovery from a service restart. No rig services or vehicle data are touched.
//
// Bridges: BRIDGE_BIN=/path/to/zenoh-bridge-remote-api (1.9.0), or Docker with host networking and
// BRIDGE_IMAGE (default dashboard-zenoh:local). Needs `npm ci` in app/ and Node 22+.
//   node tools/test_vehicle_state.mjs              # SECONDS=10 per measurement window
//   MOTION=parked node tools/test_vehicle_state.mjs  # sensor noise only (default: turning + driving)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleForNode } from "../app/scripts/build-state.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "vstate-e2e-"));
try {
  process.env.STATE_BUNDLE = join(dir, "dashboard-state.mjs");
  await bundleForNode(here("../app/src/vstate/node/main.ts"), process.env.STATE_BUNDLE);
  await bundleForNode(here("./vehicle_state_e2e.mjs"), join(dir, "harness.mjs"));
  const { run } = await import(pathToFileURL(join(dir, "harness.mjs")).href);
  process.exitCode = await run();
} finally {
  await rm(dir, { recursive: true, force: true });
}
// zenoh-ts keeps timers alive after its sessions close; the verdict is in.
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
