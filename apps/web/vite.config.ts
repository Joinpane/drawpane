import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the Worker runs under `wrangler dev` on :8787; Vite proxies
// API and websocket traffic to it so the app and API share one origin, as in
// production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787" },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
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
