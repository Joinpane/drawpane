import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * This build's id, compiled in and written beside the app as `version.json`,
 * so an open tab can tell that a newer build was deployed (app/updates.ts).
 */
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function buildVersion(): Plugin {
  return {
    name: "drawpane-build-version",
    apply: "build",
    config: () => ({ define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } }),
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ build: BUILD_ID })}\n`,
      });
    },
  };
}

// In development the Worker runs under `wrangler dev` on :8787; Vite proxies
// API and websocket traffic to it so the app and API share one origin, as in
// production.
export default defineConfig({
  plugins: [react(), buildVersion()],
  // HarfBuzz finds its .wasm next to its module (new URL(…, import.meta.url)):
  // pre-bundling would move the module away from it.
  optimizeDeps: { exclude: ["harfbuzzjs"] },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787" },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  // The .fig reader runs in a module Worker (dashboard/fig.worker.ts), from this origin, as the
  // CSP's worker-src allows.
  worker: { format: "es" },
  test: {
    // Playwright owns e2e/; Vitest runs unit tests next to the code.
    include: ["src/**/*.test.ts"],
    // Fixed fast-check seeds unless FUZZ_SEED says otherwise.
    setupFiles: ["../../vitest.setup.ts"],
  },
  build: {
    target: "es2023",
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
});
