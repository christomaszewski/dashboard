// dashboard-state: the vehicle side of vehicle state (docs/VEHICLE_STATE.md). Bundled for Node by
// `npm run build:state` and run by deploy/Dockerfile.state next to its own loopback-only
// remote-api bridge, so it sees full-rate topics whatever the public sidecar's rate caps are.
//
//   DASH_STATE_KEY      fleet/<vehicle>/dash/<name>/state   (required; dash-up derives it)
//   DASH_STATE_LOCATOR  ws/127.0.0.1:10001                  (the private bridge)
import { ZenohRemoteApiTransport } from "../../transport/zenohRemoteApi";
import { FlavorResolver } from "../../schema/resolver";
import { TopicStore } from "../../ros/topicStore";
import { STATE_KEY_RE, stateKeys } from "../protocol";
import { LiveGraph, VehicleStateServer, serveQuery } from "../server";
import { FrameServer, serveFrameQuery, type FrameEncoder } from "../frames";
import { loadSharpEncoder, unavailableEncoder } from "./sharpEncoder";
import { HealthHub } from "../healthHub";
import { EMPTY_GRAPH, type RosGraph } from "../../ros/graph";

// The few Node globals used here, declared locally so the app's DOM-only tsconfig stays as is.
declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
  on(event: "SIGTERM" | "SIGINT", cb: () => void): void;
};

const base = process.env.DASH_STATE_KEY ?? "";
const locator = process.env.DASH_STATE_LOCATOR || "ws/127.0.0.1:10001";

const log = (message: string) => console.log(`${new Date().toISOString()} dashboard-state: ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`no answer within ${ms} ms`)))]);
}

// Crash-only: once serving, a closed socket to the bridge ends the process at once (Docker restarts
// it with a new epoch; every browser re-registers on its next poll). Waiting for the probe instead
// left pages on "service not reachable" for ~12 s after a bridge restart.
let serving = false;
let stopping = false;
function onSocketEvent(event: string, detail: Record<string, unknown>): void {
  if (event !== "ws-close" || !serving || stopping) return;
  log(`bridge socket closed (code ${String(detail.code)}); exiting for a clean restart`);
  process.exit(1);
}

/** The bridge may start after us (compose order is not readiness); keep dialing. */
async function connect(): Promise<ZenohRemoteApiTransport> {
  for (let delay = 500; ; delay = Math.min(delay * 2, 2000)) {
    try {
      return await ZenohRemoteApiTransport.open(locator, undefined, 5000, onSocketEvent);
    } catch (e) {
      log(`bridge ${locator} not reachable (${errorText(e)}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
}

async function main(): Promise<void> {
  if (!STATE_KEY_RE.test(base)) {
    console.error(`dashboard-state: DASH_STATE_KEY must be a plain Zenoh key (got '${base}')`);
    process.exit(2);
  }
  const transport = await connect();
  // Types outside the bundle resolve through a node that uses them (its ~/get_type_description).
  let latest: RosGraph = EMPTY_GRAPH;
  const resolver = new FlavorResolver(transport, { graph: () => latest });
  const store = new TopicStore({ transport, resolver });
  const health = new HealthHub(transport, resolver, log);
  const server = new VehicleStateServer({ store, health });
  let encoder: FrameEncoder;
  try {
    encoder = await loadSharpEncoder();
  } catch (e) {
    log(`image frames disabled: sharp did not load (${errorText(e)})`);
    encoder = unavailableEncoder("sharp is not installed");
  }
  const frames = new FrameServer({ store, resolver, encoder, epoch: server.epoch });
  const graph = new LiveGraph(transport, (g) => {
    latest = g;
    server.setGraph(g);
    frames.setGraph(g);
    health.setGraph(g);
  });
  await graph.start();

  let sent = 0;
  let frameBytes = 0;
  const keys = stateKeys(base);
  const queryables = await Promise.all([
    ...(["view", "poll"] as const).map((op) =>
      transport.declareQueryable(keys[op], (q) => void serveQuery(server, op, q).then(
        (n) => void (sent += n),
        (e) => log(`could not answer a ${op} query (${errorText(e)})`),
      ))),
    transport.declareQueryable(keys.frame, (q) => void serveFrameQuery(frames, q).then(
      (n) => void (frameBytes += n),
      (e) => log(`could not answer a frame query (${errorText(e)})`),
    )),
  ]);
  serving = true;
  log(`connected to ${locator}; serving ${keys.view}, ${keys.poll} and ${keys.frame} (epoch ${server.epoch})`);

  const housekeeping = setInterval(() => {
    server.tick();
    frames.tick();
  }, 1000);
  const report = setInterval(() => {
    const s = server.stats();
    const f = frames.stats();
    log(`views=${s.views} items=${s.items} topics=${s.topics} registers=${s.registers} polls=${s.polls} sent=${sent}B` +
      ` frame-topics=${f.topics} frame-requests=${f.requests} frames=${f.frames} encodes=${f.encodes} frame-sent=${frameBytes}B`);
  }, 60_000);
  // Crash-only: a session that stops answering ends the process. Docker restarts it with a new
  // epoch, and every browser re-registers on its next poll.
  let failures = 0;
  const probe = setInterval(() => {
    withTimeout(transport.checkConnection(), 3000).then(
      () => void (failures = 0),
      (e) => {
        log(`bridge probe failed (${errorText(e)})`);
        if (++failures >= 2) {
          log("bridge stopped answering; exiting for a clean restart");
          process.exit(1);
        }
      },
    );
  }, 5000);

  const shutdown = async () => {
    stopping = true;
    clearInterval(housekeeping);
    clearInterval(report);
    clearInterval(probe);
    server.close();
    frames.close();
    store.closeAll();
    await Promise.allSettled([graph.close(), ...queryables.map((q) => q.close())]);
    await transport.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  console.error("dashboard-state: fatal:", e);
  process.exit(1);
});
