import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repo = fileURLToPath(new URL("..", import.meta.url));
let revision = process.env.DASHBOARD_BUILD_REVISION || "unknown";
let dirty = false;
try {
  if (revision === "unknown") revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  dirty = !!execFileSync("git", ["status", "--porcelain", "--", "app"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch { /* Source archives and Docker contexts need not include .git. */ }
// Docker builds omit .git; the content fingerprint still identifies the exact frontend sources.
const app = fileURLToPath(new URL(".", import.meta.url));
const hash = createHash("sha256");
function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(join(path, entry.name)) : entry.isFile() ? [join(path, entry.name)] : []);
}
for (const file of [...sourceFiles(join(app, "src")), ...sourceFiles(join(app, "patches")),
  ...["package.json", "package-lock.json", "vite.config.ts"].map(name => join(app, name))].sort()) {
  hash.update(relative(app, file)); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0");
}
const sourceHash = hash.digest("hex");

// zenoh-ts pulls a wasm keyexpr module; the wasm + top-level-await plugins let Vite handle it.
// (If a clean build shows they're unnecessary, drop them.)
export default defineConfig({
  define: { __DASHBOARD_BUILD__: JSON.stringify({ revision, dirty, builtAt: new Date().toISOString(), sourceHash }) },
  plugins: [react(), wasm(), topLevelAwait()],
  worker: { format: "es" }, // PointCloud2 worker lazily imports the bundled ROS message definitions.
  server: { host: true, port: 5173 }, // host:true → reachable on the LAN during dev
  // build outDir = default (app/dist); deploy/Dockerfile.web bakes the bundle into the dashboard-web image.
});
