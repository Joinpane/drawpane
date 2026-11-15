import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests. By default Playwright builds nothing: run `pnpm build`
 * first, then this starts the Worker (which serves the built app) on its own
 * port with a fresh database. Set E2E_BASE_URL to test a deployed instance
 * instead, with E2E_SETUP_TOKEN for its first-run setup.
 */
const external = process.env.E2E_BASE_URL;
/** Override with E2E_PORT to run several suites side by side. */
const port = process.env.E2E_PORT ?? "8788";
/** On CI: a stray `.only` fails the run, a test gets one retry (and is reported as flaky), and failures keep an HTML report. */
const ci = !!process.env.CI;
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  ...(external
    ? {}
    : {
        webServer: {
          command: "node e2e/server.mjs",
          url: `http://localhost:${port}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
  projects: [
    {
      name: "chromium",
      testIgnore: /(tour|bench|calibration)\//,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
    {
      // Performance budgets (docs/PRD.md, non-functional requirements). `pnpm bench`.
      name: "bench",
      testMatch: /bench\/.*\.spec\.ts/,
      timeout: 300_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // A retina laptop: twice the pixels to fill.
        deviceScaleFactor: 2,
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
    {
      // Fits glass to Figma's renders (tools/glass-calibration): run by hand, minutes long.
      name: "calibration",
      testMatch: /calibration\/.*\.spec\.ts/,
      timeout: 60 * 60_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
    {
      name: "tour",
      testMatch: /tour\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
});
