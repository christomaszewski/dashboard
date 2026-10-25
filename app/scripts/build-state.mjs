// Bundles the vehicle-side state service (src/vstate/node/main.ts) into one Node ESM file with its
// dependencies, including the patched zenoh-ts from node_modules. Used by deploy/Dockerfile.state;
// tools/test_vehicle_state.mjs reuses bundleForNode for its harness.
//   node scripts/build-state.mjs [outfile]      (default: dist-state/dashboard-state.mjs)
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// zenoh-ts ships wasm-bindgen "bundler" output (`import * as wasm from "./x_bg.wasm"`), which Node 22
// cannot import. Inline each module and instantiate it synchronously with its JS imports, exporting
// the instance's exports under their own names — what a wasm-aware bundler does for the browser.
export const wasmEsm = {
  name: "wasm-esm",
  setup(b) {
    b.onLoad({ filter: /\.wasm$/ }, async ({ path }) => {
      const bytes = await readFile(path);
      const module = new WebAssembly.Module(bytes);
      const sources = [...new Set(WebAssembly.Module.imports(module).map((i) => i.module))];
      const lines = sources.map((s, i) => `import * as i${i} from ${JSON.stringify(s)};`);
      lines.push(`const instance = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64")), {`);
      lines.push(...sources.map((s, i) => `  ${JSON.stringify(s)}: i${i},`), "});");
      for (const { name } of WebAssembly.Module.exports(module)) {
        lines.push(`const e_${name.replace(/\W/g, "_")} = instance.exports[${JSON.stringify(name)}];`);
        lines.push(`export { e_${name.replace(/\W/g, "_")} as ${JSON.stringify(name)} };`);
      }
      return { contents: lines.join("\n"), loader: "js", resolveDir: dirname(path) };
    });
  },
};

/** Native modules the bundle loads at runtime instead of inlining (image frames: sharp/libvips). */
export const RUNTIME_MODULES = ["sharp"];

/** One self-contained Node 22 ESM file; bare imports resolve from app/node_modules. */
export async function bundleForNode(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
    // Bundled CommonJS dependencies may require() Node built-ins, which plain ESM output cannot do.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [wasmEsm],
    external: RUNTIME_MODULES,
    logLevel: "warning",
  });
}

/** package.json pinning the runtime modules to the versions installed here (deploy/Dockerfile.state). */
export async function runtimePackage(outDir) {
  const dependencies = {};
  for (const name of RUNTIME_MODULES) {
    const pkg = JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"));
    dependencies[name] = pkg.version;
  }
  const file = join(outDir, "package.json");
  await writeFile(file, JSON.stringify({ name: "dashboard-state-runtime", private: true, type: "module", dependencies }, null, 2) + "\n");
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outfile = process.argv[2] ?? "dist-state/dashboard-state.mjs";
  await bundleForNode(fileURLToPath(new URL("../src/vstate/node/main.ts", import.meta.url)), outfile);
  const pkg = await runtimePackage(dirname(outfile));
  console.log(`build-state: wrote ${outfile} and ${pkg}`);
}
