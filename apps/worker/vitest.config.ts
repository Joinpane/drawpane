import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { capWasm } from "../agent-runner/scripts/cap-wasm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runnerDir = join(here, "../agent-runner");

/**
 * The agent runner, built as it deploys (decision 0033): the tests run both
 * scripts, the runner as an auxiliary Worker the main one binds by name.
 */
function buildRunner(): Array<{ type: "ESModule" | "CompiledWasm" | "Data"; path: string }> {
  // The capped WebAssembly the runner bundles (decision 0033, item 4.2).
  capWasm();
  const wrangler = join(
    dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );
  const outdir = join(runnerDir, "dist-test");
  rmSync(outdir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [wrangler, "deploy", "--dry-run", "--outdir", outdir, "-c", join(runnerDir, "wrangler.jsonc")],
    { cwd: runnerDir, stdio: ["ignore", "ignore", "inherit"] },
  );
  // The script and the WebAssembly it imports from beside it, as modules of their own.
  return [
    { type: "ESModule", path: join(outdir, "index.js") },
    ...readdirSync(outdir)
      .filter((name) => name.endsWith(".wasm") || name.endsWith(".ttf"))
      .map((name) => ({
        type: name.endsWith(".wasm") ? ("CompiledWasm" as const) : ("Data" as const),
        path: join(outdir, name),
      })),
  ];
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const runner = buildRunner();
  const liveFonts = process.env.AGENT_TEST_LIVE_FONTS === "1";
  const fallbackFonts = process.env.AGENT_TEST_FALLBACK_FONTS === "1";
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_LIVE_FONTS: liveFonts,
            TEST_FALLBACK_FONTS: fallbackFonts,
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
          },
          workers: [
            {
              // The name the main Worker's AGENT_RUNNER binding asks for (`script_name`).
              name: "drawpane-agent-runner",
              modules: runner,
              modulesRoot: join(runnerDir, "dist-test"),
              compatibilityDate: "2026-11-01",
              compatibilityFlags: ["nodejs_compat"],
              durableObjects: { AGENT_RUNNER: { className: "AgentRunner", useSQLite: true } },
              // The main Worker's database and bucket, by the same ids, so both see the same rows.
              d1Databases: { DB: "82cecbce-29d8-4a51-8b09-4ee3d72e5296" },
              r2Buckets: { FILES: "drawpane-files" },
              bindings: {
                // Agent tools with the deterministic stand-in measurer (agent-runner/src/measurer.ts).
                AGENT_MEASURER: liveFonts || fallbackFonts ? "harfbuzz" : "standin",
                ...(liveFonts && !fallbackFonts ? { GOOGLE_FONTS: "off" } : {}),
                // The chaos hooks (agent-runner/src/hooks.ts), for tests only.
                AGENT_RUNNER_TEST_HOOKS: "on",
              },
            },
          ],
        },
      }),
    ],
    // test-node/ is the memory check, run in Node (vitest.memory.config.ts).
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
