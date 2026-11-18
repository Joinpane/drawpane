// Starts the Worker for end-to-end tests on its own port with a throwaway
// database, so every run begins with a fresh, un-set-up instance.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = process.env.E2E_PORT ?? "8788";
const worker = resolve(import.meta.dirname, "../../worker");
const runner = resolve(import.meta.dirname, "../../agent-runner");
// Each run's database is removed when the Worker exits. A run that was killed
// outright leaves its own behind: those over a day old are cleared here, so
// many runs never fill the disk (hundreds once took 34 GB).
const DAY_MS = 24 * 60 * 60_000;
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith("drawpane-e2e-")) continue;
  const path = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(path).mtimeMs > DAY_MS)
      rmSync(path, { recursive: true, force: true });
  } catch {
    // Gone already, or another run's: leave it.
  }
}
const persist = mkdtempSync(join(tmpdir(), "drawpane-e2e-"));
const removePersist = () => rmSync(persist, { recursive: true, force: true });
const wrangler = resolve(worker, "node_modules/.bin/wrangler");

const migrate = spawnSync(
  wrangler,
  ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
  {
    cwd: worker,
    stdio: "inherit",
  },
);
if (migrate.status !== 0) {
  removePersist();
  process.exit(migrate.status ?? 1);
}

const vars = {
  PUBLIC_ORIGIN: `http://localhost:${port}`,
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  SETUP_TOKEN: "e2e-setup-token",
  // Sign-in buttons for GitHub and Google show; the providers themselves are stubbed in tests.
  GITHUB_CLIENT_ID: "e2e-github-client",
  GITHUB_CLIENT_SECRET: "e2e-github-secret",
  GOOGLE_CLIENT_ID: "e2e-google-client",
  GOOGLE_CLIENT_SECRET: "e2e-google-secret",
  // Tests never ask npm for releases; the health page's notice is tested with a stubbed answer.
  UPDATE_CHECK: "off",
  // Email is printed by the test Worker, never sent.
  EMAIL_PROVIDER: "log",
  EMAIL_FROM: "Drawpane <design@example.com>",
  // The kit store reads a fixture registry a spec serves locally, or none: tests never reach GitHub or Penpot.
  KIT_REGISTRY: process.env.E2E_KIT_REGISTRY ?? "off",
};
// The agent runner runs beside the Worker (decision 0033), from a copy of its config with the
// stand-in text measurer: `--var` reaches only the first config. Its comments are whole lines.
const runnerConfig = JSON.parse(
  readFileSync(join(runner, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);
delete runnerConfig.$schema;
runnerConfig.main = join(runner, runnerConfig.main);
// Agent tools on, with the stand-in text measurer (agent-runner/src/measurer.ts).
runnerConfig.vars = { ...runnerConfig.vars, AGENT_MEASURER: "standin" };
const runnerConfigPath = join(persist, "agent-runner.wrangler.json");
writeFileSync(runnerConfigPath, JSON.stringify(runnerConfig));
// The capped WebAssembly the runner bundles (normally written by its build).
const capped = spawnSync(process.execPath, [join(runner, "scripts/cap-wasm.ts")], {
  cwd: runner,
  stdio: "inherit",
});
if (capped.status !== 0) {
  removePersist();
  process.exit(capped.status ?? 1);
}
const child = spawn(
  wrangler,
  [
    "dev",
    "-c",
    join(worker, "wrangler.jsonc"),
    "-c",
    runnerConfigPath,
    "--port",
    port,
    "--local-upstream",
    `localhost:${port}`,
    "--persist-to",
    persist,
    "--log-level",
    "warn",
    // A second instance (see fresh-instance.ts) needs its own inspector port.
    ...(process.env.E2E_INSPECTOR_PORT ? ["--inspector-port", process.env.E2E_INSPECTOR_PORT] : []),
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  { cwd: worker, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  removePersist();
  process.exit(code ?? 0);
});
