// Precompress the built bundle at maximum levels (Brotli 11, gzip 9) so dashboard-web serves the
// smallest file without compressing per request (deploy/Caddyfile: `file_server { precompressed }`).
// Browsers accept Brotli over HTTPS only; plain HTTP gets the gzip copy.
//   node scripts/precompress.mjs [dist]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = process.argv[2] ?? "dist";
const COMPRESSIBLE = /\.(js|mjs|css|html|wasm|svg|json|map)$/;
let before = 0, gz = 0, br = 0, files = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!COMPRESSIBLE.test(entry.name) || statSync(path).size < 1024) continue;
    const data = readFileSync(path);
    const g = gzipSync(data, { level: 9 });
    const b = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    writeFileSync(`${path}.gz`, g);
    writeFileSync(`${path}.br`, b);
    before += data.length; gz += g.length; br += b.length; files += 1;
  }
}
walk(root);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`precompress: ${files} files, ${kb(before)} -> gzip ${kb(gz)}, brotli ${kb(br)}`);
