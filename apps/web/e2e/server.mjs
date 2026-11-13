// Starts the Worker for end-to-end tests on its own port with a throwaway
// database, so every run begins with a fresh, un-set-up instance.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = process.env.E2E_PORT ?? "8788";
const worker = resolve(import.meta.dirname, "../../worker");
const persist = mkdtempSync(join(tmpdir(), "drawpane-e2e-"));
const wrangler = resolve(worker, "node_modules/.bin/wrangler");

const migrate = spawnSync(
  wrangler,
  ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
  {
    cwd: worker,
    stdio: "inherit",
  },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const vars = {
  PUBLIC_ORIGIN: `http://localhost:${port}`,
  SESSION_SECRET: "e2e-session-secret-0123456789abcdef",
  SETUP_TOKEN: "e2e-setup-token",
};
const child = spawn(
  wrangler,
  [
    "dev",
    "--port",
    port,
    "--local-upstream",
    `localhost:${port}`,
    "--persist-to",
    persist,
    "--log-level",
    "warn",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  { cwd: worker, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
