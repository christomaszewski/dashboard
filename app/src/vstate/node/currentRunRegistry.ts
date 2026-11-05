import { parse } from "yaml";
import { NO_CURRENT_RUN, type CurrentRunFields } from "../currentRun";

// Loaded only by the Node service. Local types keep the browser tsconfig free of Node globals.
interface Stat { isDirectory(): boolean; isSymbolicLink(): boolean; size: number }
interface RegistryFs {
  stat(path: string): Promise<Stat>;
  lstat(path: string): Promise<Stat>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}
interface Paths { join(...parts: string[]): string; dirname(path: string): string; basename(path: string): string; isAbsolute(path: string): boolean }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const optionalString = (value: unknown): string | null => value === undefined || value === null || value === "" ? null : String(value);

export async function currentRunReader(dataDir: string): Promise<() => Promise<CurrentRunFields>> {
  const fsModule = "node:fs/promises", pathModule = "node:path";
  const fs = await import(/* @vite-ignore */ fsModule) as RegistryFs;
  const path = await import(/* @vite-ignore */ pathModule) as Paths;
  if (!path.isAbsolute(dataDir)) throw new Error("RIG_DATA_DIR must be an absolute host path");
  return async () => {
    if (!(await fs.stat(dataDir)).isDirectory()) throw new Error(`${dataDir}: registry is not a directory`);
    const current = path.join(dataDir, "current");
    let link: Stat;
    try { link = await fs.lstat(current); }
    catch (error) { if (missing(error)) return { ...NO_CURRENT_RUN }; throw error; }
    if (!link.isSymbolicLink()) throw new Error(`${current} exists but is not a symlink`);
    let directory: string;
    try { directory = await fs.realpath(current); }
    catch (error) { if (missing(error)) return { ...NO_CURRENT_RUN }; throw error; }
    // Rig treats a dangling/non-directory target as no open run. A live target must be a direct
    // child of the resolved runs directory; resolving preserves the host path from the identity mount.
    try { if (!(await fs.stat(directory)).isDirectory()) return { ...NO_CURRENT_RUN }; }
    catch (error) { if (missing(error)) return { ...NO_CURRENT_RUN }; throw error; }
    const runs = await fs.realpath(path.join(dataDir, "runs"));
    if (path.dirname(directory) !== runs) throw new Error(`${current} points outside the registry (${directory})`);
    const manifest = path.join(directory, "manifest.yaml");
    let doc: Record<string, unknown> = {};
    try {
      if ((await fs.stat(manifest)).size > 256 * 1024) throw new Error("manifest exceeds 256 KiB");
      const text = await fs.readFile(manifest, "utf8");
      if (text.length > 256 * 1024) throw new Error("manifest exceeds 256 KiB");
      const parsed: unknown = parse(text, { maxAliasCount: 100 });
      if (parsed !== null && parsed !== undefined) {
        if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top level must be a mapping");
        doc = parsed as Record<string, unknown>;
        if (doc.corrupt === true) throw new Error("manifest is marked corrupt");
      }
    } catch (error) {
      if (!missing(error)) throw new Error(`current run manifest is unreadable or corrupt: ${manifest}: ${String(error)}`);
    }
    return { ok: true, run_id: path.basename(directory), run_dir: directory,
      label: optionalString(doc.label), started: optionalString(doc.started), error: null };
  };
}
