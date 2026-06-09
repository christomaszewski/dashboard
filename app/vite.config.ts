import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// zenoh-ts pulls a wasm keyexpr module; the wasm + top-level-await plugins let Vite handle it.
// (If a clean build shows they're unnecessary, drop them.)
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: { host: true, port: 5173 }, // host:true → reachable on the LAN during dev
  build: {
    outDir: "../deploy/www", // build straight into the dir the dashboard-web service serves
    emptyOutDir: true,
  },
});
