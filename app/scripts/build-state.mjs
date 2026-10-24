// Bundles the vehicle-side state service (src/vstate/node/main.ts) into one Node ESM file with its
// dependencies, including the patched zenoh-ts from node_modules. Used by deploy/Dockerfile.state.
//   node scripts/build-state.mjs [outfile]      (default: dist-state/dashboard-state.mjs)
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

// zenoh-ts ships wasm-bindgen "bundler" output (`import * as wasm from "./x_bg.wasm"`), which Node 22
// cannot import. Inline each module and instantiate it synchronously with its JS imports, exporting
// the instance's exports under their own names — what a wasm-aware bundler does for the browser.
const wasmEsm = {
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

const outfile = process.argv[2] ?? "dist-state/dashboard-state.mjs";
await build({
  entryPoints: [new URL("../src/vstate/node/main.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CommonJS dependencies may require() Node built-ins, which plain ESM output cannot do.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [wasmEsm],
  logLevel: "warning",
});
console.log(`build-state: wrote ${outfile}`);
