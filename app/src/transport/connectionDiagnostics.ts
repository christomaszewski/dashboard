/** Local, bounded connection metadata. Never records ROS payloads, service arguments or log text. */
export interface DiagnosticEvent {
  at: string;
  event: string;
  build: DiagnosticBuild;
  detail: Record<string, unknown>;
}

export interface DiagnosticBuild { revision: string; dirty: boolean; builtAt: string; sourceHash: string }
declare const __DASHBOARD_BUILD__: DiagnosticBuild | undefined;
export const dashboardBuild: DiagnosticBuild = typeof __DASHBOARD_BUILD__ === "undefined"
  ? { revision: "development", dirty: false, builtAt: "unknown", sourceHash: "unknown" } : __DASHBOARD_BUILD__!;

const STORAGE_KEY = "dashboard.connection-diagnostics.v1";
const MAX_EVENTS = 240;
const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const encodedSize = (text: string) => new TextEncoder().encode(text).byteLength;
const RESERVED = /^(payload|attachment|request|response|body|text|authorization|cookie)$/i;

function metadata(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 3) return "[omitted]";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary omitted]";
  if (Array.isArray(value)) return value.slice(0, 20).map(v => metadata(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30)
    .filter(([key]) => !RESERVED.test(key)).map(([key, v]) => [key.slice(0, 100), metadata(v, depth + 1)]));
  return undefined;
}

const noteworthy = (event: string) => /(?:failure|deadline|drop)$/.test(event) || event === "ws-error" || event === "ws-close";
const persistEvent = (event: string) => noteworthy(event) || event === "connection-status" || event === "bridge-selected";
function savedBuild(value: unknown): DiagnosticBuild {
  const build = value && typeof value === "object" ? value as Partial<DiagnosticBuild> : {};
  return { revision: typeof build.revision === "string" ? build.revision.slice(0, 100) : "unknown",
    dirty: build.dirty === true, builtAt: typeof build.builtAt === "string" ? build.builtAt.slice(0, 40) : "unknown",
    sourceHash: typeof build.sourceHash === "string" ? build.sourceHash.slice(0, 100) : "unknown" };
}
function boundedEvent(entry: DiagnosticEvent): DiagnosticEvent {
  if (encodedSize(JSON.stringify(entry)) <= MAX_EVENT_BYTES) return entry;
  const primitive = Object.entries(entry.detail).filter(([, value]) => value === null ||
    ["string", "number", "boolean"].includes(typeof value)).slice(0, 16);
  const result: DiagnosticEvent = { ...entry, detail: { ...Object.fromEntries(primitive.map(([key, value]) =>
    [key.slice(0, 40), typeof value === "string" ? value.slice(0, 80) : value])), truncated: true } };
  // JSON escapes can occupy six bytes per character, even for short ASCII strings.
  for (const key of Object.keys(result.detail).filter(key => key !== "truncated").reverse()) {
    if (encodedSize(JSON.stringify(result)) <= MAX_EVENT_BYTES) break;
    delete result.detail[key];
  }
  return result;
}

export class ConnectionDiagnostics {
  private events: DiagnosticEvent[] = [];
  private persistenceQueued = false;
  constructor(private options: {
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    now?: () => number;
    context?: () => Record<string, unknown>;
    write?: (event: DiagnosticEvent) => void;
    build?: DiagnosticBuild;
  } = {}) {
    try {
      const stored = options.storage?.getItem(STORAGE_KEY);
      if (!stored || encodedSize(stored) > MAX_STORAGE_BYTES) return;
      const doc: unknown = JSON.parse(stored);
      if (!doc || typeof doc !== "object" || !("events" in doc) || !Array.isArray(doc.events)) return;
      this.events = doc.events.slice(-MAX_EVENTS).flatMap((e: unknown) => {
        if (!e || typeof e !== "object" || !("at" in e) || !("event" in e) || !("detail" in e)
          || typeof e.at !== "string" || typeof e.event !== "string" || !e.detail || typeof e.detail !== "object") return [];
        return [boundedEvent({ at: e.at.slice(0, 40), event: e.event.slice(0, 100), build: savedBuild("build" in e ? e.build : undefined),
          detail: metadata(e.detail) as Record<string, unknown> })];
      });
    } catch { /* Private browsing, quota limits and malformed old logs must not affect the link. */ }
  }

  record = (event: string, detail: Record<string, unknown> = {}): void => {
    try {
      const entry = boundedEvent({ at: new Date(this.options.now?.() ?? Date.now()).toISOString(), event: event.slice(0, 100),
        build: savedBuild(this.options.build ?? dashboardBuild),
        detail: metadata({ ...this.options.context?.(), ...detail }) as Record<string, unknown> });
      this.events.push(entry);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      if (persistEvent(event) && !this.persistenceQueued) {
        this.persistenceQueued = true;
        queueMicrotask(() => { this.persistenceQueued = false; this.persist(); });
      }
      if (noteworthy(event)) this.options.write?.(entry);
    } catch { /* Diagnostics must never reject a declaration, query, or connection. */ }
  };

  snapshot(): { version: 1; build: DiagnosticBuild; events: DiagnosticEvent[] } {
    return JSON.parse(JSON.stringify({ version: 1, build: this.options.build ?? dashboardBuild, events: this.events }));
  }

  persist(): void {
    try {
      let events = this.events;
      let json = JSON.stringify({ version: 1, events });
      while (encodedSize(json) > MAX_STORAGE_BYTES && events.length > 1) {
        events = events.slice(Math.ceil(events.length / 4));
        json = JSON.stringify({ version: 1, events });
      }
      this.options.storage?.setItem(STORAGE_KEY, json);
    } catch { /* Session storage is best effort; the live ring remains available. */ }
  }

  clear(): void {
    this.events = [];
    try { this.options.storage?.removeItem(STORAGE_KEY); } catch { /* optional storage */ }
  }
}

interface BrowserDiagnostics {
  snapshot(): ReturnType<ConnectionDiagnostics["snapshot"]>;
  download(): void;
  clear(): void;
}
declare global { interface Window { dashboardConnectionDiagnostics?: BrowserDiagnostics } }

let browserDiagnostics: ConnectionDiagnostics | undefined;
export function connectionDiagnostics(): ConnectionDiagnostics {
  if (browserDiagnostics) return browserDiagnostics;
  let storage: Storage | undefined;
  try { if (typeof window !== "undefined") storage = window.sessionStorage; } catch { /* optional */ }
  browserDiagnostics = new ConnectionDiagnostics({ storage,
    context: () => typeof document === "undefined" ? {} : {
      tab: window.location.hash || "#/home", visibility: document.visibilityState,
    },
    write: entry => console.warn("[dashboard connection]", entry.event, JSON.stringify(entry)),
  });
  if (typeof window !== "undefined") {
    window.dashboardConnectionDiagnostics = {
      snapshot: () => browserDiagnostics!.snapshot(),
      clear: () => browserDiagnostics!.clear(),
      download: () => {
        const blob = new Blob([JSON.stringify(browserDiagnostics!.snapshot(), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = `dashboard-connection-${Date.now()}.json`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    };
  }
  return browserDiagnostics;
}

/** Timer drift can explain a missed heartbeat; hidden tabs are recorded, not called network failures. */
export function monitorConnectionPage(record: ConnectionDiagnostics["record"]): () => void {
  if (typeof window === "undefined") return () => {};
  const changed = () => record("page-context", { tab: window.location.hash || "#/home", visibility: document.visibilityState });
  const hiding = () => { record("page-hide"); connectionDiagnostics().persist(); };
  window.addEventListener("hashchange", changed);
  window.addEventListener("pagehide", hiding);
  document.addEventListener("visibilitychange", changed);
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), lagMs = Math.max(0, now - last - 1000);
    last = now;
    if (lagMs >= 250) record("browser-timer-delay", { lagMs: Math.round(lagMs), visibility: document.visibilityState });
  }, 1000);
  return () => {
    clearInterval(timer);
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("pagehide", hiding);
    document.removeEventListener("visibilitychange", changed);
  };
}
