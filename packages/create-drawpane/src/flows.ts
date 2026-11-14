/**
 * Installing and upgrading an instance. Everything outside (Cloudflare, the
 * terminal, the network, the browser) comes in as `Deps`, so both flows run
 * in tests against fakes. See docs/decisions/0004-installer.md.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Account, Cloudflare } from "./cloudflare.js";
import {
  CONFIG_FILE,
  compareVersions,
  domainProblem,
  type InstanceConfig,
  nameProblem,
  newConfig,
  readConfig,
  suggestName,
  writeConfig,
} from "./instance.js";
import { copyRelease, type Release, readTemplate, renderWranglerConfig } from "./release.js";
import type { Ui } from "./ui.js";

export interface Deps {
  readonly ui: Ui;
  readonly cloudflare: Cloudflare;
  readonly release: Release;
  /** Asks the instance something over HTTP (`fetch`, in real life). */
  readonly fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  readonly openBrowser: (url: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** How long to wait for a fresh deploy to answer, in ms. */
  readonly healthTimeoutMs?: number;
}

export interface InstallOptions {
  readonly dir?: string | undefined;
  readonly account?: string | undefined;
  readonly name?: string | undefined;
  /** A hostname; "" for the workers.dev address; undefined to ask. */
  readonly domain?: string | undefined;
  /** Take every default and ask nothing. */
  readonly yes?: boolean;
}

export interface UpgradeOptions {
  readonly dir?: string | undefined;
  readonly yes?: boolean;
  /** Deploy again even when the instance already runs this version. */
  readonly force?: boolean;
}

/** Something the person has to fix, said plainly; the CLI prints it without a stack. */
export class Problem extends Error {}

const UPGRADE_COMMAND = "npm create drawpane@latest upgrade";

export async function install(options: InstallOptions, deps: Deps): Promise<void> {
  const { ui, release } = deps;
  ui.intro(`Drawpane ${release.version}`);
  // A mistyped flag is said before anything else: before a sign-in or a question.
  checkFlags(options);
  const asking = ui.interactive && !options.yes;

  const dir = resolve(
    deps.cwd,
    options.dir ??
      (asking
        ? await ui.text({
            message: "Where should the instance's folder go?",
            initial: "drawpane",
            validate: (v) => (v ? null : "A folder name, like drawpane."),
          })
        : "drawpane"),
  );

  let config = await readConfig(dir);
  if (config?.version) {
    ui.info(
      `${shortPath(dir, deps.cwd)} already runs Drawpane ${config.version} at ${config.url}.`,
    );
    ui.outro(`To move it to a newer version, run \`${UPGRADE_COMMAND}\` in that folder.`);
    return;
  }
  if (config) ui.info("Picking up where the last install stopped.");
  else if (await hasFiles(dir))
    throw new Problem(
      `${shortPath(dir, deps.cwd)} already has files in it. Choose a new folder, or an empty one.`,
    );

  const accounts = await signIn(deps, asking);
  if (!config) {
    const account = await chooseAccount(accounts, options, deps, asking);
    const name = await chooseName(dir, options, ui, asking);
    const domain = await chooseDomain(options, ui, asking);
    config = newConfig({ accountId: account.id, name, domain });
    ui.note(
      [
        `Account   ${account.name}`,
        `Worker    ${config.name}`,
        `Address   ${config.domain ?? `${config.name}.<your subdomain>.workers.dev`}`,
        `Database  ${config.database.name} (D1)`,
        `Files     ${config.bucket} (R2)`,
      ].join("\n"),
      "About to set up",
    );
    if (asking && !(await ui.confirm({ message: "Set it up?" })))
      throw new Problem("Nothing was created.");
    await mkdir(dir, { recursive: true });
    await writeConfig(dir, config);
  } else if (!accounts.some((a) => a.id === config?.accountId)) {
    throw new Problem(
      `You're signed in to Cloudflare without access to account ${config.accountId}, which this instance uses. Sign in as someone with access and run this again.`,
    );
  }

  config = await prepare(dir, config, deps);
  config = await createResources(dir, config, deps);
  // A Worker that already has a session secret keeps it: a new one would sign everyone out.
  const existing = await deps.cloudflare.secretNames(dir, config.accountId);
  const setupToken = token(18);
  config = await deployAndWait(dir, config, deps, {
    SETUP_TOKEN: setupToken,
    ...(existing.includes("SESSION_SECRET") ? {} : { SESSION_SECRET: token(48) }),
  });
  config = { ...config, version: release.version };
  await writeConfig(dir, config);

  const url = config.url as string;
  if (!(await needsSetup(url, deps))) {
    // An instance someone already set up (this folder adopted it): nothing to claim.
    ui.note(
      `Your instance: ${url}
It's already set up: sign in there.`,
      "Drawpane is running",
    );
    ui.outro(`Keep ${shortPath(dir, deps.cwd)}/: it's how you upgrade (\`${UPGRADE_COMMAND}\`).`);
    return;
  }
  const setupUrl = `${url}/setup#token=${encodeURIComponent(setupToken)}`;
  ui.note(
    [
      `Your instance: ${url}`,
      "",
      "Create the first account (yours) with this one-time setup token:",
      `  ${setupToken}`,
      "",
      `Or open ${url}/setup with the token already filled in.`,
    ].join("\n"),
    "Drawpane is running",
  );
  if (asking && (await ui.confirm({ message: "Open the setup page now?" })))
    deps.openBrowser(setupUrl);
  ui.outro(`Keep ${shortPath(dir, deps.cwd)}/: it's how you upgrade (\`${UPGRADE_COMMAND}\`).`);
}

export async function upgrade(options: UpgradeOptions, deps: Deps): Promise<void> {
  const { ui, release } = deps;
  const dir = resolve(deps.cwd, options.dir ?? ".");
  const config = await readConfig(dir);
  if (!config)
    throw new Problem(
      `There's no ${CONFIG_FILE} in ${shortPath(dir, deps.cwd)}. Run this in your instance's folder, or pass its path.`,
    );
  if (!config.version)
    throw new Problem(
      `This instance's install didn't finish. Run \`npm create drawpane ${shortPath(dir, deps.cwd)}\` to finish it.`,
    );
  ui.intro(`Drawpane ${config.version} → ${release.version}`);
  const order = compareVersions(release.version, config.version);
  if (order < 0)
    throw new Problem(
      `This installer carries Drawpane ${release.version}, older than the ${config.version} the instance runs. Use \`${UPGRADE_COMMAND}\`.`,
    );
  if (order === 0 && !options.force) {
    ui.outro(`Already on ${release.version}. (Pass --force to deploy it again.)`);
    return;
  }
  if (ui.interactive && !options.yes) {
    ui.note(
      [
        `Instance  ${config.url}`,
        "New database migrations apply first; the running version keeps",
        "working until the new one takes over.",
      ].join("\n"),
      `Upgrade to ${release.version}`,
    );
    if (!(await ui.confirm({ message: "Upgrade now?" }))) throw new Problem("Nothing changed.");
  }
  const accounts = await signIn(deps, ui.interactive && !options.yes);
  if (!accounts.some((a) => a.id === config.accountId))
    throw new Problem(
      `You're signed in to Cloudflare without access to account ${config.accountId}, which this instance uses.`,
    );

  let next = await prepare(dir, config, deps);
  // An instance from before a resource existed in the release gets it now.
  next = await createResources(dir, next, deps);
  next = await deployAndWait(dir, next, deps, null);
  next = { ...next, version: release.version };
  await writeConfig(dir, next);
  ui.outro(`${next.url} runs Drawpane ${release.version}.`);
}

/** The accounts the person can use, signing in first when nobody is. */
async function signIn(deps: Deps, asking: boolean): Promise<Account[]> {
  const { ui, cloudflare } = deps;
  let accounts = await ui.step("Checking your Cloudflare sign-in", () => cloudflare.accounts());
  if (accounts === null) {
    if (!asking)
      throw new Problem(
        "Not signed in to Cloudflare. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN, then try again.",
      );
    if (!(await ui.confirm({ message: "Sign in to Cloudflare in your browser?" })))
      throw new Problem("Drawpane runs on your Cloudflare account, so it needs you signed in.");
    await cloudflare.login();
    accounts = await cloudflare.accounts();
    if (accounts === null) throw new Problem("Signing in to Cloudflare didn't finish.");
  }
  if (accounts.length === 0)
    throw new Problem(
      "This Cloudflare login has no accounts. Create one at dash.cloudflare.com, then try again.",
    );
  return accounts;
}

async function chooseAccount(
  accounts: readonly Account[],
  options: InstallOptions,
  deps: Deps,
  asking: boolean,
): Promise<Account> {
  const wanted = options.account ?? deps.env.CLOUDFLARE_ACCOUNT_ID;
  if (wanted) {
    const match = accounts.find(
      (a) => a.id === wanted || a.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match)
      throw new Problem(
        `No account "${wanted}" here. Yours: ${accounts.map((a) => a.name).join(", ")}.`,
      );
    return match;
  }
  const [only] = accounts;
  if (accounts.length === 1 && only) return only;
  if (!asking)
    throw new Problem(
      `This login has ${accounts.length} accounts: choose one with --account <name or id>.`,
    );
  return deps.ui.select({
    message: "Which Cloudflare account should it run on?",
    options: accounts.map((a) => ({ value: a, label: a.name, hint: a.id })),
  });
}

/** Rejects a `--name` or `--domain` that won't do. */
function checkFlags(options: InstallOptions): void {
  if (options.name !== undefined) {
    const problem = nameProblem(options.name);
    if (problem) throw new Problem(`--name ${options.name}: ${problem}`);
  }
  if (options.domain !== undefined) {
    const problem = domainProblem(options.domain);
    if (problem) throw new Problem(`--domain ${options.domain}: ${problem}`);
  }
}

async function chooseName(
  dir: string,
  options: InstallOptions,
  ui: Ui,
  asking: boolean,
): Promise<string> {
  if (options.name !== undefined) return options.name;
  const suggested = suggestName(basename(dir));
  if (!asking) return suggested;
  return ui.text({
    message: "What should the Worker be called?",
    initial: suggested,
    validate: nameProblem,
  });
}

async function chooseDomain(
  options: InstallOptions,
  ui: Ui,
  asking: boolean,
): Promise<string | null> {
  // Hostnames aren't case-sensitive; the config keeps one spelling (as the prompt does).
  if (options.domain !== undefined) return options.domain.toLowerCase() || null;
  if (!asking) return null;
  const domain = await ui.text({
    message:
      "Its own domain? (on a zone in this account; leave empty for a free workers.dev address)",
    placeholder: "design.example.com",
    validate: domainProblem,
  });
  return domain.toLowerCase() || null;
}

/** Puts the bundled release and a fresh wrangler.jsonc in the folder. */
async function prepare(dir: string, config: InstanceConfig, deps: Deps): Promise<InstanceConfig> {
  await deps.ui.step(`Unpacking Drawpane ${deps.release.version}`, async () => {
    await copyRelease(deps.release, dir);
    await renderConfig(dir, config, deps.release);
  });
  return config;
}

async function renderConfig(dir: string, config: InstanceConfig, release: Release) {
  await writeFile(
    join(dir, "wrangler.jsonc"),
    renderWranglerConfig(await readTemplate(release), config, release.version),
  );
}

/** The database and bucket, found by name before being created, so running again is safe. */
async function createResources(
  dir: string,
  config: InstanceConfig,
  deps: Deps,
): Promise<InstanceConfig> {
  const { ui, cloudflare } = deps;
  let next = config;
  if (!next.database.id) {
    const id = await ui.step(
      `Creating the database (${next.database.name})`,
      async () => {
        const found = await cloudflare.findDatabase(next.accountId, next.database.name);
        if (found) return found;
        await cloudflare.createDatabase(next.accountId, next.database.name);
        const made = await cloudflare.findDatabase(next.accountId, next.database.name);
        if (!made) throw new Problem("The database was created but can't be found. Try again.");
        return made;
      },
      () => `Database ready (${next.database.name})`,
    );
    next = { ...next, database: { ...next.database, id } };
    await writeConfig(dir, next);
    await renderConfig(dir, next, deps.release);
  }
  await ui.step(
    `Creating file storage (${next.bucket})`,
    () => cloudflare.ensureBucket(next.accountId, next.bucket),
    () => `File storage ready (${next.bucket})`,
  );
  return next;
}

/** Applies migrations, deploys (with secrets when given), and waits until it answers. */
async function deployAndWait(
  dir: string,
  config: InstanceConfig,
  deps: Deps,
  secrets: Record<string, string> | null,
): Promise<InstanceConfig> {
  const { ui, cloudflare } = deps;
  await ui.step(
    "Updating the database",
    () => cloudflare.migrate(dir, config.accountId, config.database.name),
    () => "Database up to date",
  );
  const workersDev = await ui.step(
    "Deploying",
    () => withSecretsFile(secrets, (file) => cloudflare.deploy(dir, config.accountId, file)),
    () => "Deployed",
  );
  const url = config.domain ? `https://${config.domain}` : workersDev;
  if (!url)
    throw new Problem(
      "Deployed, but Cloudflare didn't say where. Your account may need a workers.dev subdomain: choose one under Workers & Pages in the dashboard, then run this again.",
    );
  const next = { ...config, url };
  await writeConfig(dir, next);
  await ui.step(
    `Waiting for ${url} to answer`,
    () => waitForHealth(url, deps),
    () => `${url} is up`,
  );
  return next;
}

/** Secrets travel in a private temporary file that's gone as soon as the deploy is. */
async function withSecretsFile<T>(
  secrets: Record<string, string> | null,
  use: (file: string | null) => Promise<T>,
): Promise<T> {
  if (!secrets) return use(null);
  const folder = join(tmpdir(), `drawpane-${token(9)}`);
  await mkdir(folder, { mode: 0o700 });
  const file = join(folder, "secrets.json");
  try {
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Whether the instance still waits for its first account (true when it can't tell). */
async function needsSetup(url: string, deps: Deps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${url}/api/session`, { signal: AbortSignal.timeout(5_000) });
    const session = (await response.json()) as { needsSetup?: boolean };
    return session.needsSetup !== false;
  } catch {
    return true;
  }
}

async function waitForHealth(url: string, deps: Deps): Promise<void> {
  // A new custom domain needs DNS and a certificate: that can take a minute or two.
  const deadline = Date.now() + (deps.healthTimeoutMs ?? 180_000);
  for (;;) {
    try {
      const response = await deps.fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // Not answering yet.
    }
    if (Date.now() > deadline)
      throw new Problem(
        `${url} isn't answering yet. If you just added a domain, its certificate may still be on its way: try opening it in a few minutes.`,
      );
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function hasFiles(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((f) => f !== ".DS_Store" && f !== ".git");
  } catch {
    return false;
  }
}

function shortPath(dir: string, cwd: string): string {
  return dir.startsWith(`${cwd}/`) ? dir.slice(cwd.length + 1) : dir;
}

/** A random URL-safe token with `bytes` of entropy. */
function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
