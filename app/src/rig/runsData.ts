// The run registry's FILES, served by Caddy at /rig-data/ (deploy/docker-compose.rig-data.yml mounts
// data_dir read-only; `file_server browse` answers JSON to Accept: application/json — the same call
// the Clouds tab makes). Registry ROWS come from the agent over zenoh; this module only lists
// directories and builds download links. Pure: `fetch` is injectable for tests.

export const RIG_DATA_URL = "/rig-data";

export interface DirEntry {
  name: string;
  size: number;
  isDir: boolean;
  modTime?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function join(segments: readonly string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** `/rig-data/<a>/<b>/` — a directory listing URL. */
export function dirUrl(segments: readonly string[]): string {
  return segments.length === 0 ? `${RIG_DATA_URL}/` : `${RIG_DATA_URL}/${join(segments)}/`;
}

/** `/rig-data/<a>/<b>` — a file URL (download link). */
export function fileUrl(segments: readonly string[]): string {
  return `${RIG_DATA_URL}/${join(segments)}`;
}

/** Caddy's JSON listing for one directory; null when the mount is absent (404) or not JSON. */
export async function listDir(segments: readonly string[], fetchFn: FetchFn = fetch): Promise<DirEntry[] | null> {
  try {
    const res = await fetchFn(dirUrl(segments), { headers: { Accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const listing: unknown = await res.json();
    if (!Array.isArray(listing)) return null;
    return listing
      .filter(
        (e): e is { name: string; size?: number; is_dir?: boolean; mod_time?: string } =>
          typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string",
      )
      .map((e) => ({
        name: e.name,
        size: typeof e.size === "number" ? e.size : 0,
        isDir: e.is_dir === true,
        modTime: typeof e.mod_time === "string" ? e.mod_time : undefined,
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  } catch {
    return null;
  }
}

/** Is the registry mounted at all? (One listing of the root.) */
export async function probeRigData(fetchFn: FetchFn = fetch): Promise<boolean> {
  return (await listDir([], fetchFn)) !== null;
}

/** camera-service's per-session sidecar (`<prefix>.json` next to the recordings). */
export interface RecordingSidecar {
  frames?: number;
  segments?: number;
  truncated?: boolean;
  error?: string | null;
  drops?: Record<string, number>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lenient: the session block nests `frames_recorded`/`segments`/`truncated`/`error`; `drops` is
 *  top-level counters. Flat `frames` is accepted too. null = not a sidecar. */
export function parseSidecar(json: unknown): RecordingSidecar | null {
  if (!isRecord(json)) return null;
  const session = isRecord(json.session) ? json.session : json;
  const out: RecordingSidecar = {};
  const frames = session.frames_recorded ?? session.frames;
  if (typeof frames === "number") out.frames = frames;
  if (typeof session.segments === "number") out.segments = session.segments;
  else if (Array.isArray(session.files)) out.segments = session.files.length;
  if (typeof session.truncated === "boolean") out.truncated = session.truncated;
  if (typeof session.error === "string") out.error = session.error;
  if (isRecord(json.drops)) {
    const drops: Record<string, number> = {};
    for (const [k, v] of Object.entries(json.drops)) if (typeof v === "number") drops[k] = v;
    out.drops = drops;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function loadSidecar(segments: readonly string[], fetchFn: FetchFn = fetch): Promise<RecordingSidecar | null> {
  try {
    const res = await fetchFn(fileUrl(segments), { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return parseSidecar(await res.json());
  } catch {
    return null;
  }
}

export function isSidecarName(name: string): boolean {
  return name.toLowerCase().endsWith(".json");
}
