import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret-0123456789abcdef",
            SETUP_TOKEN: "test-setup-token",
            PUBLIC_ORIGIN: "https://design.example.com",
            GITHUB_CLIENT_ID: "gh-client",
            GITHUB_CLIENT_SECRET: "gh-secret",
            GOOGLE_CLIENT_ID: "google-client",
            GOOGLE_CLIENT_SECRET: "google-secret",
            // Email is printed in tests, never sent.
            EMAIL_PROVIDER: "log",
            EMAIL_FROM: "Drawpane <design@example.com>",
            // Agent tools on, with the deterministic stand-in measurer (agent/measurer.ts).
            AGENT_MEASURER: "standin",
          },
        },
      }),
    ],
    // test-node/ is the memory check, run in Node (vitest.memory.config.ts).
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
