/**
 * What the installer asks of Cloudflare, behind an interface so the install
 * and upgrade flows can be tested without an account. The real one drives the
 * Wrangler this package pins, under the person's own login (or
 * CLOUDFLARE_API_TOKEN), in the instance's folder.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface Account {
  readonly id: string;
  readonly name: string;
}

export interface Cloudflare {
  /** The accounts this login can use, or null when nobody is signed in. */
  accounts(): Promise<Account[] | null>;
  /** Signs in through the browser (Wrangler's OAuth flow). */
  login(): Promise<void>;
  /** The id of the account's D1 database with this name, if it exists. */
  findDatabase(accountId: string, name: string): Promise<string | null>;
  createDatabase(accountId: string, name: string): Promise<void>;
  /** Creates the R2 bucket, or does nothing when the account already has it. */
  ensureBucket(accountId: string, name: string): Promise<void>;
  // Secrets are the main Worker's only (wrangler.jsonc): the agent runner has none.
  /** The names of the secrets the instance's Worker has; none when it doesn't exist yet. */
  secretNames(dir: string, accountId: string): Promise<string[]>;
  /** Sets the Worker's secrets from a JSON file of names and values, without deploying its code. */
  putSecrets(dir: string, accountId: string, secretsFile: string): Promise<void>;
  /** Removes a secret from the Worker. */
  deleteSecret(dir: string, accountId: string, name: string): Promise<void>;
  /** Applies the instance's pending D1 migrations; returns the ones it applied ("0011_invite_notes"). */
  migrate(dir: string, accountId: string, database: string): Promise<string[]>;
  /**
   * Deploys one of the instance's Workers: the one `configFile` in the folder
   * describes (`wrangler deploy -c`), or the main one (wrangler.jsonc) when
   * not given. Secrets come from a JSON file when given. Resolves to the
   * workers.dev address when it has one.
   */
  deploy(
    dir: string,
    accountId: string,
    secretsFile: string | null,
    configFile?: string,
  ): Promise<string | null>;
}

/** A Wrangler run that failed: its output, for the person to read. */
export class WranglerError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
  ) {
    super(`wrangler ${command} failed:\n${output.trim()}`);
  }
}

interface RunOptions {
  readonly cwd?: string;
  readonly accountId?: string;
  /** Hand the terminal to Wrangler (for login's browser prompt) instead of capturing. */
  readonly interactive?: boolean;
}

function wranglerBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

/**
 * A failure worth trying again: Cloudflare's "internal error, please try
 * again" (code 10001), a rate limit, or the network dropping. Every step the
 * installer takes is safe to repeat (it finds before it creates).
 */
export function isTransient(output: string): boolean {
  return /code: 10001|code: 10013|code: 971|internal error|please try again|rate limit|429 Too Many|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(
    output,
  );
}

/**
 * Cloudflare's refusal of a Worker's CPU limit (`limits.cpu_ms`) on the
 * Workers Free plan: API error 100328, "CPU limits are not supported for
 * the Free plan." Seen in Wrangler's output by projects that deployed with
 * a CPU limit on Free; no Free account was tried here.
 */
export const FREE_PLAN_CODE = 100328;
export const FREE_PLAN_MESSAGE = "CPU limits are not supported for the Free plan.";

/**
 * What a refused deploy says about the account's plan:
 *
 * - `free`: Cloudflare's own refusal of the CPU limit on the Free plan, by
 *   its error code or its exact message.
 * - `unsure`: the refusal is about a CPU limit, but not in those terms. It
 *   may be the Free plan, or something else (a value out of range).
 * - null: nothing to do with the plan.
 *
 * Only Cloudflare's message counts: the API path Wrangler quotes before it
 * names the Worker, and a Worker may be named anything (`freeform-agent-runner`).
 */
export type PlanRefusal = "free" | "unsure" | null;

export function planRefusal(output: string): PlanRefusal {
  const said = output.replace(/A request to the Cloudflare API \([^)]*\) failed\.?/g, "");
  const codes = [...said.matchAll(/\[code: (\d+)\]/g)].map((m) => Number(m[1]));
  if (codes.includes(FREE_PLAN_CODE)) return "free";
  const exact = FREE_PLAN_MESSAGE.toLowerCase();
  for (const line of said.split("\n")) {
    const message = line
      .replace(/^\s*(?:✘\s*)?(?:\[ERROR\]\s*)?/, "")
      .replace(/\s*\[code: \d+\]\s*$/, "")
      .trim()
      .toLowerCase();
    if (message === exact) return "free";
  }
  return /\bcpu[ _-]?limits?\b|\bcpu_ms\b/i.test(said) ? "unsure" : null;
}

/** Waits between tries, longer each time. */
export const RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * Runs `attempt`, trying again after each delay when it fails transiently
 * (a WranglerError `isTransient` recognises); anything else fails at once.
 * `onFailure` hears each failed try's error, for what it did before failing.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onFailure?: (error: unknown) => void,
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      onFailure?.(error);
      const wait = delays[tries];
      if (wait === undefined || !(error instanceof WranglerError) || !isTransient(error.output))
        throw error;
      await sleep(wait);
    }
  }
}

/** Runs Wrangler; a transient failure is tried again (not interactive runs, like signing in). */
function run(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return options.interactive ? runOnce(args, options) : withRetries(() => runOnce(args, options));
}

function runOnce(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {}),
        // Plain output: it's parsed, and shown only when something goes wrong.
        FORCE_COLOR: "0",
        WRANGLER_HIDE_BANNER: "true",
      },
      stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new WranglerError(args.slice(0, 2).join(" "), output));
    });
  });
}

/** The first JSON value in Wrangler's output (it can print notices around it). */
function json<T>(output: string): T {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error(`Expected JSON from Wrangler, got: ${output.trim()}`);
  return JSON.parse(output.slice(start)) as T;
}

export const wrangler: Cloudflare = {
  async accounts() {
    try {
      const me = json<{ loggedIn: boolean; accounts?: Account[] }>(await run(["whoami", "--json"]));
      if (!me.loggedIn) return null;
      return (me.accounts ?? []).map(({ id, name }) => ({ id, name }));
    } catch (error) {
      // `whoami --json` exits non-zero when nobody is signed in.
      if (error instanceof WranglerError) return null;
      throw error;
    }
  },

  async login() {
    await run(["login"], { interactive: true });
  },

  async findDatabase(accountId, name) {
    const list = json<{ uuid: string; name: string }[]>(
      await run(["d1", "list", "--json"], { accountId }),
    );
    return list.find((db) => db.name === name)?.uuid ?? null;
  },

  async createDatabase(accountId, name) {
    try {
      await run(["d1", "create", name], { accountId });
    } catch (error) {
      // A try that failed after Cloudflare made it (an internal error, then a retry): it's ours.
      if (error instanceof WranglerError && /already exists|7502/i.test(error.output)) return;
      throw error;
    }
  },

  async ensureBucket(accountId, name) {
    try {
      await run(["r2", "bucket", "create", name], { accountId });
    } catch (error) {
      // R2 bucket names are per account: "already exists" means it's ours.
      if (error instanceof WranglerError && /already exists|10004/i.test(error.output)) return;
      throw error;
    }
  },

  async secretNames(dir, accountId) {
    try {
      const list = json<{ name: string }[]>(
        await run(["secret", "list", "--format", "json"], { cwd: dir, accountId }),
      );
      return list.map((s) => s.name);
    } catch (error) {
      if (error instanceof WranglerError && /not found|10007/i.test(error.output)) return [];
      throw error;
    }
  },

  async putSecrets(dir, accountId, secretsFile) {
    await run(["secret", "bulk", secretsFile], { cwd: dir, accountId });
  },

  async deleteSecret(dir, accountId, name) {
    // With no terminal attached, Wrangler takes "yes" for its "are you sure?".
    await run(["secret", "delete", name], { cwd: dir, accountId });
  },

  async migrate(dir, accountId, database) {
    // A try that fails partway may have applied some first: they count too.
    const applied: string[] = [];
    const output = await withRetries(
      () => runOnce(["d1", "migrations", "apply", database, "--remote"], { cwd: dir, accountId }),
      RETRY_DELAYS_MS,
      undefined,
      (error) => {
        if (error instanceof WranglerError) applied.push(...appliedMigrations(error.output));
      },
    );
    return [...new Set([...applied, ...appliedMigrations(output)])];
  },

  async deploy(dir, accountId, secretsFile, configFile) {
    const output = await run(
      [
        "deploy",
        ...(configFile ? ["-c", configFile] : []),
        ...(secretsFile ? ["--secrets-file", secretsFile] : []),
      ],
      { cwd: dir, accountId },
    );
    return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
  },
};

/**
 * The migrations Wrangler's output reports as applied: rows of its results
 * table marked ✅, without ".sql". "No migrations to apply!" gives none.
 */
export function appliedMigrations(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(/│\s*(\d{4}_[\w-]+)\.sql\s*│\s*✅/g))
    if (match[1]) names.add(match[1]);
  return [...names];
}
