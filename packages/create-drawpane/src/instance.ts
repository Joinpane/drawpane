/**
 * An instance is a folder. `drawpane.json` holds what the installer chose and
 * what it has done so far; it's the source of truth `wrangler.jsonc` is
 * generated from, and what lets an interrupted install pick up where it
 * stopped. See docs/decisions/0004-installer.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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
  /** Settings for the Worker, over the release's (e.g. `GOOGLE_FONTS: "off"`). */
  vars: z.record(z.string(), z.string()).optional(),
});
export type InstanceConfig = z.infer<typeof InstanceConfig>;

/** A new instance's config, before anything exists on Cloudflare. */
export function newConfig({
  accountId,
  name,
  domain,
}: {
  accountId: string;
  name: string;
  domain: string | null;
}): InstanceConfig {
  return {
    version: null,
    accountId,
    name,
    database: { name, id: null },
    bucket: `${name}-files`,
    domain,
    url: null,
  };
}

/** The folder's config, or null when the folder has none. Throws when it's there but invalid. */
export async function readConfig(dir: string): Promise<InstanceConfig | null> {
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = InstanceConfig.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${CONFIG_FILE} isn't valid: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unreadable"}.`,
    );
  }
  return parsed.data;
}

export async function writeConfig(dir: string, config: InstanceConfig): Promise<void> {
  await writeFile(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A Worker name from a folder name: "My Design Team" → "my-design-team".
 * Falls back to "drawpane" when nothing usable is left.
 */
export function suggestName(folder: string): string {
  const name = folder
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

/** Compares dotted versions: negative when a is older than b. Pre-release tags sort first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
