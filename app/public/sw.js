// Offline app shell (docs/SPOTTY_LINK.md): a reload while the vehicle's web server is out of reach
// still opens the dashboard, which then reconnects on its own. Registered only in secure contexts
// (HTTPS or localhost) — browsers allow service workers nowhere else.
//
//   page + /config/*  network first, with a short deadline; the last good copy when the vehicle is
//                     slow or unreachable (the Home layout and the vehicle-state key come from there)
//   /assets/*         cache first: names are content hashes, a cached file never goes stale
//   everything else   untouched (/clouds/, /rig-data/, the WebSocket)
const SHELL = "dashboard-shell-v1";
const ASSETS = "dashboard-assets-v1";
const NETWORK_DEADLINE_MS = 3000;
const MAX_ASSETS = 120;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return;
    await shell.put("/", res.clone());
    // The entry script, stylesheet and preloads the page names: enough to start offline.
    const html = await res.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const cache = await caches.open(ASSETS);
    await Promise.all(assets.map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url).catch(() => undefined);
    }));
  })().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL && name !== ASSETS) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") return event.respondWith(networkFirst(req, "/"));
  if (url.pathname.startsWith("/config/")) return event.respondWith(networkFirst(req, url.pathname));
  if (url.pathname.startsWith("/assets/")) return event.respondWith(cacheFirst(req));
});

async function networkFirst(req, key) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withDeadline(fetch(req, { cache: "no-store" }), NETWORK_DEADLINE_MS);
    // Keep the last good copy; a 404 config (none deployed) is a real answer too.
    if (res.ok || res.status === 404) await cache.put(key, res.clone());
    return res;
  } catch {
    const cached = await cache.match(key);
    if (cached) return cached;
    return new Response("The vehicle's dashboard is out of reach and was never loaded on this device.", {
      status: 503, headers: { "Content-Type": "text/plain" },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(old);
  }
  return res;
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
