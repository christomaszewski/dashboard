#!/usr/bin/env node
// Build exact Git snapshots without changing the checkout. Optional native bridge comparison
// exercises each snapshot's transport, TopicStore and ROS service client over the same TCP shaper.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { baseline: "2ca7709", candidate: "c88b07f", image: "localhost:5000/dashboard-zenoh:runtime-opt-20261020" };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--network") options.network = true;
  else if (arg === "--allow-download") options.allowDownload = true;
  else if (["--baseline", "--candidate", "--out", "--image"].includes(arg)) {
    const value = process.argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2)] = value;
  } else throw new Error(`Unknown argument ${arg}`);
}
const out = resolve(options.out ?? `/private/tmp/dashboard-build-comparison-${randomUUID().slice(0, 8)}`);
if (existsSync(out)) throw new Error(`Output must be a new directory: ${out}`);
mkdirSync(out, { recursive: true });
const run = promisify(execFile);
const command = async (name, args, cwd = repo) => (await run(name, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 180000 })).stdout.trim();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function inventory(directory, prefix = "") {
  return readdirSync(directory).sort().flatMap(name => {
    const full = join(directory, name), relative = prefix + name;
    return statSync(full).isDirectory() ? inventory(full, relative + "/") : [{ path: relative,
      bytes: statSync(full).size, sha256: sha(readFileSync(full)) }];
  });
}

async function build(label, ref) {
  const commit = await command("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  const source = join(out, `${label}-${commit.slice(0, 8)}`);
  mkdirSync(source);
  const archive = spawnSync("git", ["archive", commit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(archive.stderr.toString());
  const unpack = spawnSync("tar", ["-xf", "-", "-C", source], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
  // A working checkout may already have a newer SDK patch. Install the archived lockfile and
  // execute its own postinstall, rather than borrowing that potentially modified node_modules.
  console.log(`Installing cached dependencies for ${label}`);
  try {
    const result = await run("npm", ["ci", options.allowDownload ? "--prefer-offline" : "--offline", "--no-audit", "--no-fund", "--logs-dir", join(out, "npm-logs")],
      { cwd: join(source, "app"), maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    writeFileSync(join(out, `${label}-install.log`), result.stdout + result.stderr);
  } catch (error) {
    writeFileSync(join(out, `${label}-install.log`), String(error.stdout ?? "") + String(error.stderr ?? error));
    throw error;
  }
  console.log(`Building ${label}: ${commit}`);
  try {
    const result = await run("npm", ["run", "build"], { cwd: join(source, "app"),
      env: { ...process.env, VITE_BUILD_LABEL: `${label}-${commit.slice(0, 8)}` },
      maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    writeFileSync(join(out, `${label}-build.log`), result.stdout + result.stderr);
  } catch (error) {
    writeFileSync(join(out, `${label}-build.log`), String(error.stdout ?? "") + String(error.stderr ?? error));
    throw error;
  }
  const dist = join(source, "app/dist");
  const info = { label, requestedRef: ref, commit, node: process.version, source, dist,
    dependencyMode: `isolated npm ci ${options.allowDownload ? "--prefer-offline" : "--offline"}; archived lockfile and SDK postinstall patch`,
    lockSha256: sha(readFileSync(join(source, "app/package-lock.json"))),
    sdkPatchSha256: sha(readFileSync(join(source, "app/patches/zenoh-ts.mjs"))) };
  // Explicit provenance endpoint; no app behavior is changed to inject a label.
  json(join(dist, "comparison-build.json"), info);
  const imageContext = join(out, `${label}-web-image`);
  mkdirSync(imageContext);
  cpSync(dist, join(imageContext, "dist"), { recursive: true });
  cpSync(join(source, "deploy/Caddyfile"), join(imageContext, "Caddyfile"));
  writeFileSync(join(imageContext, "Dockerfile"), `FROM caddy:2-alpine\nCOPY Caddyfile /etc/caddy/Caddyfile\nCOPY dist /srv\n`);
  const files = inventory(dist);
  const result = { ...info, imageContext, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  json(join(out, `${label}-inventory.json`), result);
  return result;
}

async function sourceModules(snapshot) {
  const require = createRequire(join(snapshot.source, "app/package.json"));
  const dependencies = join(snapshot.source, "app/node_modules");
  const esbuild = require("esbuild");
  const source = join(snapshot.source, "app/src");
  const entry = join(out, `${snapshot.label}-network-entry.ts`);
  writeFileSync(entry, `
export { ReconnectingTransport } from ${JSON.stringify(join(source, "transport/reconnecting"))};
export { ZenohRemoteApiTransport } from ${JSON.stringify(join(source, "transport/zenohRemoteApi"))};
export { TopicStore } from ${JSON.stringify(join(source, "ros/topicStore"))};
export { buildGraph } from ${JSON.stringify(join(source, "ros/graph"))};
export { callService } from ${JSON.stringify(join(source, "services/callService"))};
export { serviceQueryKeyexpr } from ${JSON.stringify(join(source, "services/keyexpr"))};
export { encodeAttachment } from ${JSON.stringify(join(source, "services/attachment"))};
export { buildRos2StaticDecoder } from ${JSON.stringify(join(source, "schema/decoders/staticDefs"))};
`);
  const output = join(out, `${snapshot.label}-network-source.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: output,
    plugins: [{ name: "reuse-sdk", setup(build) {
      build.onResolve({ filter: /^@eclipse-zenoh\/zenoh-ts(?:\/ext)?$/ }, args => ({
        path: pathToFileURL(join(dependencies, "@eclipse-zenoh/zenoh-ts/dist", args.path.endsWith("/ext") ? "ext/index.js" : "index.js")).href,
        external: true,
      }));
    } }] });
  return import(pathToFileURL(output).href);
}

async function network(snapshots) {
  const dependencies = join(snapshots[0].source, "app/node_modules");
  const sdk = await import(pathToFileURL(join(dependencies, "@eclipse-zenoh/zenoh-ts/dist/index.js")).href);
  const docker = (...args) => command("docker", args);
  const imageIdentity = JSON.parse(await docker("image", "inspect", options.image))[0];
  const name = `dashboard-build-compare-${randomUUID().slice(0, 8)}`;
  let publisher;
  const results = [];
  try {
    await docker("run", "-d", "--name", name, "-p", "127.0.0.1::10000", imageIdentity.Id,
      "--mode", "peer", "--no-multicast-scouting");
    const port = Number((await docker("port", name, "10000/tcp")).split(":").at(-1));
    await sleep(1500);
    publisher = await sdk.Session.open(Object.assign(new sdk.Config(`ws/127.0.0.1:${port}`, 3000), { openTimeoutMs: 8000 }));
    for (const snapshot of snapshots) {
      const modules = await sourceModules(snapshot);
      for (const test of [{ label: "fast-image-and-service", downlink: 0, imageBytes: 65536 },
        { label: "slow-service-only", downlink: 16384, imageBytes: 0 },
        { label: "slow-image-and-service", downlink: 16384, imageBytes: 65536 }]) {
        console.log(`Network ${snapshot.label}: ${test.label}`);
        results.push(await scenario(snapshot, modules, test, publisher, port, name));
        json(join(out, "network-results.json"), { image: options.image, imageId: imageIdentity.Id, results });
      }
    }
  } finally {
    try { await publisher?.close(); }
    finally {
      try {
        const logs = await run("docker", ["logs", "--timestamps", name], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        writeFileSync(join(out, "bridge-container.log"), logs.stdout + logs.stderr);
      } catch { /* Container creation may have failed; cleanup must still run. */ }
      await docker("rm", "-f", name).catch(() => {});
    }
  }
  return results;
}

async function scenario(snapshot, modules, test, publisher, port, name) {
  const sockets = new Set(), timers = new Set();
  const begin = performance.now(), states = [], queries = [];
  let transferred = 0, received = 0, lastTransfer = 0, maxQueuedBytes = 0, published = 0;
  let interval, stopped = false, store, queryable;
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const proxy = net.createServer(client => {
    const server = net.connect(port, "127.0.0.1");
    sockets.add(client); sockets.add(server);
    const close = () => { client.destroy(); server.destroy(); sockets.delete(client); sockets.delete(server); };
    for (const socket of [client, server]) { socket.on("error", close); socket.on("close", close); }
    client.on("data", data => later(() => { if (!server.destroyed) server.write(data); }, test.downlink ? 200 : 0));
    const queue = []; let queuedBytes = 0;
    server.on("data", data => {
      queue.push({ data, offset: 0, at: performance.now() + (test.downlink ? 200 : 0) });
      queuedBytes += data.length; maxQueuedBytes = Math.max(maxQueuedBytes, queuedBytes);
      if (queuedBytes > 4 * 1024 * 1024) server.pause();
    });
    const pump = () => {
      if (client.destroyed) return;
      let budget = test.downlink ? Math.floor(test.downlink / 50) : Infinity;
      while (queue.length && queue[0].at <= performance.now() && budget > 0) {
        const head = queue[0], count = Math.min(budget, head.data.length - head.offset);
        const writable = client.write(head.data.subarray(head.offset, head.offset + count));
        head.offset += count; budget -= count; queuedBytes -= count; transferred += count;
        lastTransfer = performance.now() - begin;
        if (head.offset === head.data.length) queue.shift();
        if (!writable) break;
      }
      if (queuedBytes < 2 * 1024 * 1024) server.resume();
      later(pump, 20);
    };
    pump();
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const locator = `ws/127.0.0.1:${proxy.address().port}`;
  const transport = new modules.ReconnectingTransport({ open: () => modules.ZenohRemoteApiTransport.open(locator),
    onStatus: (status, error) => states.push({ atMs: Math.round(performance.now() - begin), status, error,
      transferred, received, lastTransferMs: Math.round(lastTransfer) }) });
  // Identical key lengths avoid attributing a build label's bytes to application traffic.
  const node = name.replaceAll("-", "_");
  const graph = modules.buildGraph([
    `@ros2_lv/91/z/1/1/MP/%/%/${node}/%${node}%image/sensor_msgs::msg::dds_::Image_/RIHS01_image/2:2:1,10`,
    `@ros2_lv/91/z/1/2/SS/%/%/${node}/%${node}%is_paused/rosbag2_interfaces::srv::dds_::IsPaused_/RIHS01_paused/::,:,:,,:,`,
  ]);
  const topic = graph.topics[0], service = graph.services[0];
  try {
    queryable = await publisher.declareQueryable(modules.serviceQueryKeyexpr(service.servers[0]), { complete: true,
      handler: async query => {
        try { await query.reply(query.keyExpr(), new Uint8Array([0, 1, 0, 0, 0]), { attachment: query.attachment() }); }
        finally { await query.finalize(); }
      } });
    await transport.start();
    assert.equal(transport.status(), "connected");
    if (test.imageBytes) {
      const decoder = await modules.buildRos2StaticDecoder("sensor_msgs/msg/Image");
      store = new modules.TopicStore({ transport, resolver: { resolve: async () => decoder } });
      store.acquire(topic);
      store.subscribe(topic.dataKeyexpr, () => store.getSnapshot(topic.dataKeyexpr));
      // Count delivery without adding a second transport subscription: the raw stream pool fans out
      // inside TopicStore; its snapshot's traffic count is new-only, so wrap the decoder for both.
      const original = decoder.decode;
      decoder.decode = bytes => { received++; return original(bytes); };
    }
    const poll = async () => {
      const start = performance.now();
      try {
        const result = await modules.callService(transport, graph, service.name, {}, { timeoutMs: 2000, domainId: 91 });
        queries.push({ atMs: Math.round(start - begin), elapsedMs: Math.round(performance.now() - start), paused: result.response.paused });
      } catch (error) {
        queries.push({ atMs: Math.round(start - begin), elapsedMs: Math.round(performance.now() - start), error: String(error.message ?? error) });
      }
      if (!stopped) later(() => void poll(), 3000);
    };
    void poll();
    await sleep(1000);
    if (test.imageBytes) {
      // CDR sensor_msgs/Image, mono8 256x256; the exact serialized payload is identical in both runs.
      const payload = new Uint8Array(test.imageBytes + 52);
      const view = new DataView(payload.buffer);
      payload[1] = 1; view.setUint32(12, 1, true); // empty frame_id string
      view.setUint32(20, 256, true); view.setUint32(24, 256, true);
      view.setUint32(28, 6, true); payload.set(new TextEncoder().encode("mono8"), 32);
      view.setUint32(40, 256, true); view.setUint32(44, test.imageBytes, true);
      // data starts at offset48; keep no trailing padding (the array's length is exact).
      const wire = payload.subarray(0, test.imageBytes + 48);
      const attachment = modules.encodeAttachment({ gid: new Uint8Array(16).fill(1), sequenceNumber: 1n, sourceTimestamp: 0n });
      interval = setInterval(() => { published++; void publisher.put(topic.dataKeyexpr, wire, { attachment }).catch(() => {}); }, 100);
    }
    await sleep(10500);
    const snapshotResult = test.imageBytes ? store.getSnapshot(topic.dataKeyexpr) : undefined;
    return { revision: snapshot.commit, build: snapshot.label, scenario: test.label,
      downlinkBytesPerSecond: test.downlink || "unlimited", oneWayDelayMs: test.downlink ? 200 : 0,
      imageBytes: test.imageBytes, publicationHz: test.imageBytes ? 10 : 0, published,
      decodedFlushes: received, decodeError: snapshotResult?.error ?? null,
      transferredBytes: transferred, maxQueuedBytes, states, queries,
      reconnects: states.filter(state => state.status === "reconnecting").length };
  } finally {
    stopped = true; clearInterval(interval); store?.closeAll();
    await transport.close();
    await queryable?.undeclare();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
}

try {
  const builds = [];
  builds.push(await build("baseline", options.baseline));
  builds.push(await build("candidate", options.candidate));
  json(join(out, "comparison.json"), { options, output: out, builds });
  if (options.network) await network(builds);
  console.log(`Evidence: ${out}`);
} catch (error) {
  writeFileSync(join(out, "failure.log"), String(error.stack ?? error));
  throw error;
}
