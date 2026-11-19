import { defineConfig } from "vitest/config";

// Unit tests only; the measurements are scripts/measure-worker.mjs and e2e/ (Playwright).
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
