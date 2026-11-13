import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  build: {
    target: "es2023",
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
});
