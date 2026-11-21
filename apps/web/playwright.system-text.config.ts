import { defineConfig } from "@playwright/test";

const port = Number(process.env.PARITY_PORT ?? 29371);
export default defineConfig({
  testDir: "./e2e/calibration",
  testMatch: "font-substitution.spec.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/e2e/calibration/font-substitution.html`,
    timeout: 60_000,
  },
});
