// Small pure formatters for the Rig tab / widget.

/** "42s" / "12m" / "3h07m" since a unix-seconds instant. */
export function ago(unixS: number | null | undefined, nowMs: number = Date.now()): string {
  if (unixS === null || unixS === undefined) return "";
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixS));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/** Same, from an ISO timestamp (rig manifests use `datetime.isoformat`). */
export function agoIso(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : ago(t / 1000, nowMs);
}

export function fmtKb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined || !Number.isFinite(kb)) return "";
  return fmtBytes(kb * 1024);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "";
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}

/** ISO → "2026-09-02 14:30:00Z" (seconds, UTC marker kept), or the raw string. */
export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** `20260902T143000Z_flight1` → "flight1" is the label; this yields the stamp part for display. */
export function runStamp(runId: string): string {
  const i = runId.indexOf("_");
  return i > 0 ? runId.slice(0, i) : runId;
}
