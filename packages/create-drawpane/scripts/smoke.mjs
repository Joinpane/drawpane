// Checks the release this installer carries would deploy: makes an instance
// folder from it (as `npm create drawpane` would) and runs Wrangler's dry-run
// deploy on that folder, for both Workers (the agent runner's config with
// `-c`), which validates the generated configs, the bindings and the bundled
// Workers without a Cloudflare account. Runs in CI after `pnpm build`, so a
// change that would break installs fails the PR.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newConfig, writeConfig } from "../dist/instance.js";
import {
  bundledRelease,
  copyRelease,
  MAIN_CONFIG,
  RUNNER_CONFIG,
  RUNNER_TEMPLATE,
  readTemplate,
  renderRunnerConfig,
  renderWranglerConfig,
} from "../dist/release.js";

const wrangler = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** Runs a dry-run deploy of one config in the folder; fails unless it binds each of `bindings`. */
function dryRun(dir, configFile, bindings, absent, what) {
  const result = spawnSync(
    process.execPath,
    [wrangler, "deploy", "--dry-run", "-c", configFile, "--outdir", `out-${configFile}`],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  for (const binding of bindings)
    if (!output.includes(binding)) {
      console.error(output);
      throw new Error(`The dry run of ${configFile} didn't bind ${binding} (${what}).`);
    }
  for (const binding of absent)
    if (output.includes(binding)) {
      console.error(output);
      throw new Error(
        `The dry run of ${configFile} bound ${binding}, which it shouldn't (${what}).`,
      );
    }
  if (result.status !== 0) {
    console.error(output);
    throw new Error(`wrangler deploy --dry-run -c ${configFile} failed (${what}).`);
  }
}

const release = await bundledRelease();
const dir = await mkdtemp(join(tmpdir(), "drawpane-smoke-"));
try {
  // On workers.dev; on a domain, sending email through Cloudflare Email Service; and on the
  // Workers Free plan, without the runner.
  for (const { domain, sendEmail, plan } of [
    { domain: null, sendEmail: false, plan: undefined },
    { domain: "design.example.com", sendEmail: true, plan: undefined },
    { domain: null, sendEmail: false, plan: "free" },
  ]) {
    const what = `${domain ?? "workers.dev"}${plan ? `, ${plan} plan` : ""}`;
    const config = {
      ...newConfig({ accountId: "smoke", name: "drawpane-smoke", domain, plan }),
      database: { name: "drawpane-smoke", id: "00000000-0000-4000-8000-000000000000" },
      ...(sendEmail ? { sendEmail } : {}),
    };
    await copyRelease(release, dir);
    await writeConfig(dir, config);
    await writeFile(
      join(dir, MAIN_CONFIG),
      renderWranglerConfig(await readTemplate(release), config, release.version),
    );
    const free = plan === "free";
    // The installer leaves no runner config on the Free plan.
    if (free) await rm(join(dir, RUNNER_CONFIG), { force: true });
    else {
      await writeFile(
        join(dir, RUNNER_CONFIG),
        renderRunnerConfig(await readTemplate(release, RUNNER_TEMPLATE), config, release.version),
      );
      // The order the installer deploys in: the runner first.
      dryRun(
        dir,
        RUNNER_CONFIG,
        ["env.AGENT_RUNNER", "env.DB", "env.FILES", "env.DRAWPANE_VERSION"],
        ["env.ASSETS"],
        what,
      );
    }
    dryRun(
      dir,
      MAIN_CONFIG,
      [
        "env.FILE_ROOM",
        "env.DB",
        "env.FILES",
        "env.ASSETS",
        "env.DRAWPANE_VERSION",
        // Bound to this instance's runner, by script name.
        ...(free ? ["env.AGENT_TOOLS"] : [`AgentRunner, defined in ${config.runner}`]),
        ...(sendEmail ? ["env.EMAIL"] : []),
      ],
      free ? ["env.AGENT_RUNNER"] : [],
      what,
    );
    console.log(`create-drawpane smoke: ${release.version} deploys (${what})`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
