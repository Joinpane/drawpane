// `pnpm gpu-bench`: runs gpu_bench.py with a Python that has the Modal client.
// MODAL_PYTHON picks one; otherwise ~/.venvs/modal, then python3 on PATH.
// Modal's credentials come from the environment (MODAL_TOKEN_ID and
// MODAL_TOKEN_SECRET) or ~/.modal.toml, as for the modal CLI.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const venv = join(homedir(), ".venvs/modal/bin/python");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a tool run by hand, outside every build pipeline.
const python = process.env.MODAL_PYTHON ?? (existsSync(venv) ? venv : "python3");
const script = join(import.meta.dirname, "gpu_bench.py");
// -u: stream the container's output as it comes.
const run = spawnSync(python, ["-u", script, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error) {
  console.error(
    `Couldn't run ${python}: ${run.error.message}. Set MODAL_PYTHON to a Python with modal installed.`,
  );
  process.exit(1);
}
process.exit(run.status ?? 1);
