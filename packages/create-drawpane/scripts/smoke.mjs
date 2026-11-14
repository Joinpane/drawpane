// Checks the release this installer carries would deploy: makes an instance
// folder from it (as `npm create drawpane` would) and runs Wrangler's dry-run
// deploy on that folder, which validates the generated wrangler.jsonc, the
// bindings and the bundled Worker without a Cloudflare account. Runs in CI
// after `pnpm build`, so a change that would break installs fails the PR.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newConfig, writeConfig } from "../dist/instance.js";
import {
  bundledRelease,
  copyRelease,
  readTemplate,
  renderWranglerConfig,
} from "../dist/release.js";

const release = await bundledRelease();
const dir = await mkdtemp(join(tmpdir(), "drawpane-smoke-"));
try {
  for (const domain of [null, "design.example.com"]) {
    const config = {
      ...newConfig({ accountId: "smoke", name: "drawpane-smoke", domain }),
      database: { name: "drawpane-smoke", id: "00000000-0000-4000-8000-000000000000" },
    };
    await copyRelease(release, dir);
    await writeConfig(dir, config);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      renderWranglerConfig(await readTemplate(release), config),
    );
    const wrangler = join(
      dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
      "bin",
      "wrangler.js",
    );
    const result = spawnSync(
      process.execPath,
      [wrangler, "deploy", "--dry-run", "--outdir", "out"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    for (const binding of ["env.FILE_ROOM", "env.DB", "env.FILES", "env.ASSETS"])
      if (!output.includes(binding)) {
        console.error(output);
        throw new Error(`The dry run didn't bind ${binding}.`);
      }
    if (result.status !== 0) {
      console.error(output);
      throw new Error(`wrangler deploy --dry-run failed (${domain ?? "workers.dev"}).`);
    }
    console.log(`create-drawpane smoke: ${release.version} deploys (${domain ?? "workers.dev"})`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
