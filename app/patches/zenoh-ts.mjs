// zenoh-ts 1.9.0 owns an unbounded WebSocket retry loop. The dashboard owns retries and
// endpoint selection, so make each SDK dial bounded and cancellable. Keep the wire protocol
// upstream. Applied after npm ci, including in the web image; fail closed on SDK upgrades.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@eclipse-zenoh/zenoh-ts/', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
if (version !== '1.9.0') throw new Error(`Review the dashboard connection patch for zenoh-ts ${version}`);
const marker = '// dashboard: bounded, cancellable connection attempts';
function patch(file, edit) {
  const path = fileURLToPath(new URL(`dist/${file}`, root));
  const source = readFileSync(path, 'utf8');
  if (source.includes(marker)) return;
  const result = edit(source);
  if (result === source) throw new Error(`zenoh-ts patch no longer matches ${file}`);
  writeFileSync(path, `${marker}\n${result}`);
}
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`zenoh-ts patch missing: ${from}`);
  return source.replace(from, to);
}

patch('link.js', source => {
  const start = source.indexOf('    static async new(locator) {');
  const end = source.indexOf('    onmessage(onmessage)', start);
  if (start < 0 || end < 0) throw new Error('zenoh-ts RemoteLink.new changed');
  source = source.slice(0, start) + `    static async new(locator, timeoutMs = 3000, signal) {
        if (signal?.aborted) throw new Error("Connection cancelled");
        const ws = new WebSocket(this.parseZenohLocator(locator));
        ws.binaryType = "arraybuffer";
        return await new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                ws.onopen = ws.onerror = ws.onclose = null;
            };
            const fail = (message) => {
                cleanup();
                signal?.removeEventListener("abort", abort);
                try { ws.close(); } catch { /* already closed */ }
                reject(new Error(message));
            };
            const abort = () => fail("Connection cancelled");
            const timer = setTimeout(() => fail("WebSocket connection timeout"), timeoutMs);
            signal?.addEventListener("abort", abort, { once: true });
            ws.onopen = () => {
                cleanup();
                signal?.removeEventListener("abort", abort);
                const close = () => { try { ws.close(); } catch {} };
                signal?.addEventListener("abort", close, { once: true });
                ws.addEventListener("close", () => signal?.removeEventListener("abort", close), { once: true });
                resolve(new RemoteLink(ws));
            };
            ws.onerror = () => fail("WebSocket connection failed or browser access denied");
            ws.onclose = () => fail("WebSocket closed before connecting");
        });
    }
` + source.slice(end);
  source = source.replaceAll('if (!this.isOk)', 'if (!this.isOk())');
  const closeStart = source.indexOf('    async close() {');
  const closeEnd = source.indexOf('    static parseZenohLocator', closeStart);
  if (closeStart < 0 || closeEnd < 0) throw new Error('zenoh-ts RemoteLink.close changed');
  source = source.slice(0, closeStart) + `    async close() {
        this.ws.onmessage = null;
        if (this.ws.readyState === WebSocket.CLOSED) return;
        await new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                this.ws.removeEventListener("close", finish);
                resolve();
            };
            const timer = setTimeout(finish, 250);
            this.ws.addEventListener("close", finish, { once: true });
            try { this.ws.close(); } catch { finish(); }
        });
    }
` + source.slice(closeEnd);
  const parseStart = source.indexOf('    static parseZenohLocator(locator) {');
  const parseEnd = source.indexOf('\n    }', parseStart);
  if (parseStart < 0 || parseEnd < 0) throw new Error('zenoh-ts locator parsing changed');
  return source.slice(0, parseStart) + `    static parseZenohLocator(locator) {
        return locator.replace(/^(wss?)\\/(?!\\/)/, "$1://");` + source.slice(parseEnd);
});

patch('session_inner.js', source => {
  source = replace(source, 'static async open(locator, messageResponseTimeoutMs) {',
    'static async open(locator, messageResponseTimeoutMs, openTimeoutMs, signal) {');
  source = replace(source, 'let link = await RemoteLink.new(locator);',
    'let link = await RemoteLink.new(locator, openTimeoutMs, signal);');
  source = replace(source, 'session.id = (await session.ping()).uuid; // verify connection',
    'try { session.id = (await session.ping()).uuid; } catch (error) { await link.close(); throw error; }');
  // A failed send must release its acknowledgement waiter. Otherwise its later rejection is
  // unhandled; a slow send can also let the acknowledgement deadline expire before .then attaches.
  source = replace(source, '        const p = new Promise((resolve, reject) => {',
    '        let responseTimer;\n        const p = new Promise((resolve, reject) => {');
  source = replace(source, 'let t = setTimeout(() => reject(), this.messageResponseTimeoutMs);',
    'responseTimer = setTimeout(() => reject(), this.messageResponseTimeoutMs);');
  source = replace(source, '                clearTimeout(t);', '                clearTimeout(responseTimer);');
  return replace(source, '        await this.link.send(serializer.finish().toBytes());', `        void p.catch(() => undefined);
        try { await this.link.send(serializer.finish().toBytes()); }
        catch (error) {
            clearTimeout(responseTimer);
            this.pendingMessageResponses.delete(msgId);
            throw error;
        }`);
});

patch('session.js', source => {
  source = replace(source, 'SessionInner.open(config.locator, config.messageResponseTimeoutMs)',
    'SessionInner.open(config.locator, config.messageResponseTimeoutMs, config.openTimeoutMs, config.signal)');
  return replace(source, '        this.inner.close();', '        await this.inner.close();');
});
