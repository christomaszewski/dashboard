import { defineConfig } from "vitest/config";

// Standalone vitest config on purpose: vite.config.ts pulls in the wasm/top-level-await plugins for
// zenoh-ts, which the node-environment unit tests neither need nor want.
export default defineConfig({
  test: {
    environment: "node",
    // Keep real map/dashboard styles available to the stacking-context regression test.
    css: { include: [/index\.css/, /leaflet\.css/] },
    include: ["src/**/*.test.{ts,tsx}"], // .tsx component tests opt into jsdom per file
  },
});
