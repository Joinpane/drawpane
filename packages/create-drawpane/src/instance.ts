/**
 * An instance is a folder. `drawpane.json` holds what the installer chose and
 * what it has done so far; it's the source of truth `wrangler.jsonc` is
 * generated from, and what lets an interrupted install pick up where it
 * stopped. See docs/decisions/0004-installer.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Problem } from "./problem.js";

export const CONFIG_FILE = "drawpane.json";

/** A Worker name: what Cloudflare accepts, and what shows in a workers.dev address. */
const workerName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "lowercase letters, digits and dashes");

const InstanceConfig = z.object({
  /** The Drawpane version last deployed; null until the first deploy finishes. */
  version: z.string().nullable(),
  accountId: z.string().min(1),
  name: workerName,
  database: z.object({ name: z.string().min(1), id: z.string().nullable() }),
  bucket: z.string().min(1),
  /** A hostname on one of the account's zones, or null for the workers.dev address. */
  domain: z.string().nullable(),
  /** Where the instance answers, once deployed. */
  url: z.string().nullable(),
  /** Gives the Worker a send_email binding named EMAIL, for Cloudflare Email Service. */
  sendEmail: z.boolean().optional(),
  /** Settings for the Worker, over the release's (e.g. `GOOGLE_FONTS: "off"`). */
  vars: z.record(z.string(), z.string()).optional(),
  /**
   * The agent runner's Worker, the second script (docs/decisions/0033-agent-runner.md).
   * Missing in instances from before it; an upgrade fills it in.
   */
  runner: workerName.optional(),
  /**
   * The account's Workers plan. "free" turns agent tools off and leaves the
   * runner undeployed: Free can't set the CPU limits they need. Missing means
   * paid, or not known yet (a deploy that finds Free saves it).
   */
  plan: z.enum(["paid", "free"]).optional(),
});
export type InstanceConfig = z.infer<typeof InstanceConfig>;
export type Plan = NonNullable<InstanceConfig["plan"]>;

const RUNNER_SUFFIX = "-agent-runner";

/**
 * The agent runner's Worker name for an instance: "design" → "design-agent-runner".
 * A long name is cut to keep within Cloudflare's 63 characters.
 */
export function runnerName(name: string): string {
  const base = name.slice(0, 63 - RUNNER_SUFFIX.length).replace(/-+$/, "");
  return `${base}${RUNNER_SUFFIX}`;
}

/** The runner's name this instance uses: the recorded one, or the default for older configs. */
export function instanceRunner(config: InstanceConfig): string {
  return config.runner ?? runnerName(config.name);
}

/** A new instance's config, before anything exists on Cloudflare. */
export function newConfig({
  accountId,
  name,
  domain,
  plan,
}: {
  accountId: string;
  name: string;
  domain: string | null;
  plan?: Plan | undefined;
}): InstanceConfig {
  return {
    version: null,
    accountId,
    name,
    database: { name, id: null },
    bucket: `${name}-files`,
    domain,
    url: null,
    runner: runnerName(name),
    ...(plan ? { plan } : {}),
  };
}

/**
 * The folder's config, or null when the folder has none. When it's there but
 * can't be used, says which file and what's wrong with it.
 */
export async function readConfig(dir: string): Promise<InstanceConfig | null> {
  const path = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Problem(`Couldn't read ${path}: ${code ?? (error as Error).message}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Problem(
      `${path} isn't valid JSON (${(error as Error).message}). Fix it, or restore it from a backup.`,
    );
  }
  const parsed = InstanceConfig.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Problem(`${path} isn't valid: ${issue ? `${where}${issue.message}` : "unreadable"}.`);
  }
  return parsed.data;
}

export async function writeConfig(dir: string, config: InstanceConfig): Promise<void> {
  await writeFile(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A Worker name from a folder name: "My Design Team" → "my-design-team",
 * "Über Studio" → "uber-studio".
 * Falls back to "drawpane" when nothing usable is left.
 */
export function suggestName(folder: string): string {
  const name = folder
    // Accented letters keep their base letter: "über" → "uber", not "ber".
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return name || "drawpane";
}

/** Why a Worker name won't do, or null when it's fine. */
export function nameProblem(name: string): string | null {
  return workerName.safeParse(name).success
    ? null
    : "Use 1–63 lowercase letters, digits and dashes, starting and ending with a letter or digit.";
}

/** Why a domain won't do, or null when it's fine (empty means the workers.dev address). */
export function domainProblem(domain: string): string | null {
  if (domain === "") return null;
  if (/^https?:\/\//i.test(domain)) return "Just the hostname, without https://.";
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))
    return "A hostname like design.example.com.";
  return null;
}

/**
 * Compares versions by semver precedence: negative when a is older than b.
 * A pre-release sorts before its release. The installer and the Worker each
 * keep a copy (the installer is published on its own); apps/worker/src/api/updates.ts has the other,
 * and both test the same cases.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata ("+abc") doesn't order versions.
    const [core = "", ...pre] = (v.split("+", 1)[0] ?? "").split("-");
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre.length > 0 ? pre.join("-").split(".") : [],
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release is newer than its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  // Pre-releases part by part: numbers as numbers ("beta.2" < "beta.10"), and before words.
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
