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
  /** The names of the secrets the instance's Worker has; none when it doesn't exist yet. */
  secretNames(dir: string, accountId: string): Promise<string[]>;
  /** Applies the instance's pending D1 migrations. */
  migrate(dir: string, accountId: string, database: string): Promise<void>;
  /**
   * Deploys the instance's Worker, with secrets from a JSON file when given.
   * Resolves to the workers.dev address when it has one.
   */
  deploy(dir: string, accountId: string, secretsFile: string | null): Promise<string | null>;
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

function run(args: readonly string[], options: RunOptions = {}): Promise<string> {
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
    await run(["d1", "create", name], { accountId });
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

  async migrate(dir, accountId, database) {
    await run(["d1", "migrations", "apply", database, "--remote"], {
      cwd: dir,
      accountId,
    });
  },

  async deploy(dir, accountId, secretsFile) {
    const output = await run(["deploy", ...(secretsFile ? ["--secrets-file", secretsFile] : [])], {
      cwd: dir,
      accountId,
    });
    return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
  },
};
