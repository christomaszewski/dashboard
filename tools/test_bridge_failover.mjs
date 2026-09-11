// Integration check with two disposable Zenoh bridges; no rig containers or data are touched.
// Requires Docker, the dashboard-zenoh:local image, npm ci in app/, and Node 26:
//   node tools/test_bridge_failover.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from '../app/node_modules/typescript/lib/typescript.js';
import { Session, Config } from '../app/node_modules/@eclipse-zenoh/zenoh-ts/dist/index.js';

// These transport modules have no runtime imports of one another. Compile the actual app source
// in memory, resolving the SDK explicitly so the generated data URL needs no node_modules path.
async function sourceModule(name) {
  const source = readFileSync(new URL(`../app/src/transport/${name}.ts`, import.meta.url), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const sdk = new URL('../app/node_modules/@eclipse-zenoh/zenoh-ts/dist/index.js', import.meta.url).href;
  js = js.replaceAll('"@eclipse-zenoh/zenoh-ts"', JSON.stringify(sdk));
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { BridgeSelection } = await sourceModule('bridgeSelection');
const { ReconnectingTransport } = await sourceModule('reconnecting');
const { ZenohRemoteApiTransport } = await sourceModule('zenohRemoteApi');

const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { timeout: 30_000 })).stdout.trim();
const name = `dashboard-failover-${randomUUID().slice(0, 8)}`;
const vehicle = `${name}-vehicle`, laptop = `${name}-laptop`;
const image = process.env.BRIDGE_TEST_IMAGE || 'dashboard-zenoh:local';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
let selection, transport, publisher;
try {
  await docker('network', 'create', name);
  await docker('run', '-d', '--name', vehicle, '--network', name, '-p', '127.0.0.1::10000', image,
    '--mode', 'peer', '--listen', 'tcp/0.0.0.0:7447', '--no-multicast-scouting');
  // Keep the laptop's published WebSocket on Docker's default network. Its second network is
  // the native uplink, which we can disconnect while leaving localhost WebSocket access intact.
  await docker('create', '--name', laptop, '--network', 'bridge', '-p', '127.0.0.1::10000', image,
    '--mode', 'client', '--connect', `tcp/${vehicle}:7447`, '--no-multicast-scouting');
  await docker('network', 'connect', name, laptop);
  await docker('start', laptop);
  const vehicleLocator = `ws/${await docker('port', vehicle, '10000/tcp')}`;
  const localLocator = `ws/${await docker('port', laptop, '10000/tcp')}`;
  await sleep(2_000);
  const selected = [];
  selection = new BridgeSelection({ vehicleLocator, localLocator,
    open: (locator, signal, timeout) => ZenohRemoteApiTransport.open(locator, signal, timeout),
    onSelected: locator => selected.push(locator),
  });
  transport = new ReconnectingTransport({ open: () => selection.open(), probeMs: 1_000, retryBaseMs: 100 });
  await transport.start();
  await until(() => transport.status() === 'connected', 'initial connection');
  assert.equal(selected[0], localLocator, 'the verified local bridge should be selected');
  console.log('PASS: selected local bridge after a real routed vehicle identity query');

  publisher = await Session.open(Object.assign(new Config(vehicleLocator, 3_000), { openTimeoutMs: 3_000 }));
  const samples = [];
  const key = `dashboard/test/${name}`;
  await transport.subscribe(key, s => samples.push(new TextDecoder().decode(s.payload)));
  await sleep(300);
  await publisher.put(key, 'before');
  await until(() => samples.includes('before'), 'sample through local bridge');

  await docker('network', 'disconnect', name, laptop);
  // Confirm the laptop bridge still accepts WebSockets after its native uplink is disconnected.
  const stillLocal = await Session.open(Object.assign(new Config(localLocator, 3_000), { openTimeoutMs: 3_000 }));
  await stillLocal.close();
  await until(() => selected.at(-1) === vehicleLocator && transport.status() === 'connected', 'vehicle fallback');
  await sleep(300);
  await publisher.put(key, 'after');
  await until(() => samples.includes('after'), 'restored subscription after fallback');
  console.log('PASS: live localhost socket with dead native uplink falls back and restores samples');
} catch (error) {
  for (const container of [vehicle, laptop]) {
    const result = await exec('docker', ['logs', '--tail', '8', container], { timeout: 10_000 }).catch(() => null);
    if (result) console.error(container, result.stdout, result.stderr);
  }
  throw error;
} finally {
  selection?.close();
  await transport?.close();
  await publisher?.close();
  await docker('rm', '-f', laptop, vehicle).catch(() => undefined);
  await docker('network', 'rm', name).catch(() => undefined);
}
