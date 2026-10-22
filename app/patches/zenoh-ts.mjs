// zenoh-ts 1.9.0 owns an unbounded WebSocket retry loop. The dashboard owns retries and
// endpoint selection, so make each SDK dial bounded and cancellable. Keep the wire protocol
// upstream. Applied after npm ci, including in the web image; fail closed on SDK upgrades.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@eclipse-zenoh/zenoh-ts/', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
if (version !== '1.9.0') throw new Error(`Review the dashboard connection patch for zenoh-ts ${version}`);
const marker = '// dashboard: bounded, cancellable connection attempts';
function patch(file, edit, patchMarker = marker) {
  const path = fileURLToPath(new URL(`dist/${file}`, root));
  const source = readFileSync(path, 'utf8');
  if (source.includes(patchMarker)) return;
  const result = edit(source);
  if (result === source) throw new Error(`zenoh-ts patch no longer matches ${file}`);
  writeFileSync(path, `${patchMarker}\n${result}`);
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

// Separate marker also upgrades an existing node_modules containing the original connection
// patch. Observers only collect metadata: no timeout, wire protocol or reconnect policy changes.
const diagnosticsMarker = '// dashboard: passive WebSocket diagnostics v1';
patch('link.js', source => {
  source = replace(source, '    static async new(locator, timeoutMs = 3000, signal) {',
    '    static async new(locator, timeoutMs = 3000, signal, onDiagnostic) {');
  source = replace(source, '        ws.binaryType = "arraybuffer";',
    '        ws.binaryType = "arraybuffer";\n        dashboardObserveSocket(ws, onDiagnostic);');
  source = replace(source, '            const fail = (message) => {', '            const fail = (message, cause) => {');
  source = replace(source, '                try { ws.close(); } catch { /* already closed */ }',
    '                if (ws.readyState !== WebSocket.CLOSED) dashboardSocketDiagnostics.get(ws)?.requestClose(cause);\n                try { ws.close(); } catch { /* already closed */ }');
  source = replace(source, 'const abort = () => fail("Connection cancelled");',
    'const abort = () => fail("Connection cancelled", "abort");');
  source = replace(source, 'setTimeout(() => fail("WebSocket connection timeout"), timeoutMs)',
    'setTimeout(() => fail("WebSocket connection timeout", "dial-timeout"), timeoutMs)');
  source = replace(source, 'const close = () => { try { ws.close(); } catch {} };',
    'const close = () => { dashboardSocketDiagnostics.get(ws)?.requestClose("abort"); try { ws.close(); } catch {} };');
  source = replace(source, 'fail("WebSocket connection failed or browser access denied")',
    'fail("WebSocket connection failed or browser access denied", "dial-error")');
  source = replace(source, 'fail("WebSocket closed before connecting")',
    'fail("WebSocket closed before connecting", "dial-closed")');
  source = replace(source, '        this.ws.send(msg);',
    '        this.ws.send(msg);\n        dashboardSocketDiagnostics.get(this.ws)?.sent(msg);');
  source = replace(source, '        if (this.ws.readyState === WebSocket.CLOSED) return;',
    '        if (this.ws.readyState === WebSocket.CLOSED) return;\n        dashboardSocketDiagnostics.get(this.ws)?.requestClose("sdk-close");');
  return source + `
const dashboardSocketDiagnostics = new WeakMap();
function dashboardObserveSocket(ws, onDiagnostic) {
    if (typeof onDiagnostic !== "function") return;
    let rxBytes = 0, rxMessages = 0, txBytes = 0, txMessages = 0;
    let lastReceivedAt = null, appInitiated = false, timer = null;
    const size = data => {
        if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
        if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
        return 0;
    };
    const snapshot = () => ({ rxBytes, rxMessages, txBytes, txMessages,
        lastReceivedAgeMs: lastReceivedAt === null ? null : Math.max(0, Date.now() - lastReceivedAt),
        bufferedAmount: ws.bufferedAmount, readyState: ws.readyState, appInitiated });
    const emit = (event, detail = {}) => {
        try { onDiagnostic(event, { ...snapshot(), ...detail }); } catch { /* diagnostics cannot affect transport */ }
    };
    const stopTimer = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const opened = () => {
        emit("ws-open");
        if (timer === null) timer = setInterval(() => emit("ws-snapshot"), 5000);
    };
    const errored = () => emit("ws-error");
    const received = event => { rxMessages++; rxBytes += size(event.data); lastReceivedAt = Date.now(); };
    const closed = event => {
        emit("ws-snapshot");
        emit("ws-close", { code: event.code, reason: event.reason, wasClean: event.wasClean });
        stopTimer();
        ws.removeEventListener("open", opened);
        ws.removeEventListener("error", errored);
        ws.removeEventListener("message", received);
        ws.removeEventListener("close", closed);
        dashboardSocketDiagnostics.delete(ws);
    };
    dashboardSocketDiagnostics.set(ws, {
        sent: data => { txMessages++; txBytes += size(data); },
        requestClose: cause => {
            appInitiated = true;
            emit("ws-close-request", { cause });
            // Keep the close listener until the browser supplies its actual close code, but do
            // not retain a periodic timer if the browser leaves a closing socket pending.
            stopTimer();
        },
    });
    ws.addEventListener("open", opened);
    ws.addEventListener("error", errored);
    ws.addEventListener("message", received);
    ws.addEventListener("close", closed);
}
`;
}, diagnosticsMarker);

patch('session_inner.js', source => {
  source = replace(source, 'static async open(locator, messageResponseTimeoutMs, openTimeoutMs, signal) {',
    'static async open(locator, messageResponseTimeoutMs, openTimeoutMs, signal, onDiagnostic) {');
  return replace(source, 'RemoteLink.new(locator, openTimeoutMs, signal)',
    'RemoteLink.new(locator, openTimeoutMs, signal, onDiagnostic)');
}, diagnosticsMarker);

patch('session.js', source => replace(source,
  'SessionInner.open(config.locator, config.messageResponseTimeoutMs, config.openTimeoutMs, config.signal)',
  'SessionInner.open(config.locator, config.messageResponseTimeoutMs, config.openTimeoutMs, config.signal, config.onDiagnostic)'), diagnosticsMarker);
