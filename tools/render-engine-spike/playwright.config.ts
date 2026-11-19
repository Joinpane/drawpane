import { defineConfig, devices } from "@playwright/test";

/**
 * The spike's browser measurement (decision 0040): `pnpm measure` with SPIKE_FILE set. No
 * server: the page and its files are served by routes in the spec. On a GPU machine, pass the
 * browser's flags in SPIKE_CHROME_ARGS and its binary in CHROMIUM_PATH.
 */
const extra = (process.env.SPIKE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 600_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--enable-unsafe-webgpu", ...extra],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  },
});
