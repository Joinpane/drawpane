import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Account, Cloudflare } from "../src/cloudflare";
import { type Deps, install, Problem, upgrade } from "../src/flows";
import { readConfig } from "../src/instance";
import type { Release } from "../src/release";
import type { Choice, Ui } from "../src/ui";

/** A Cloudflare account in memory, recording what was asked of it. */
class FakeCloudflare implements Cloudflare {
  signedIn = true;
  accountList: Account[] = [{ id: "acc-1", name: "Ana's studio" }];
  databases = new Map<string, string>();
  buckets = new Set<string>();
  calls: string[] = [];
  secrets = new Set<string>();
  deployedSecrets: Record<string, string>[] = [];
  failDeploy = false;

  async accounts() {
    return this.signedIn ? this.accountList : null;
  }
  async login() {
    this.calls.push("login");
    this.signedIn = true;
  }
  async findDatabase(_: string, name: string) {
    return this.databases.get(name) ?? null;
  }
  async createDatabase(_: string, name: string) {
    this.calls.push(`create database ${name}`);
    this.databases.set(name, `uuid-${name}`);
  }
  async ensureBucket(_: string, name: string) {
    if (!this.buckets.has(name)) this.calls.push(`create bucket ${name}`);
    this.buckets.add(name);
  }
  async secretNames() {
    return [...this.secrets];
  }
  async migrate(dir: string) {
    // Wrangler would read the rendered config: it has to be there.
    await stat(join(dir, "wrangler.jsonc"));
    this.calls.push("migrate");
  }
  async deploy(dir: string, _: string, secretsFile: string | null) {
    await stat(join(dir, "server/worker/index.js"));
    if (this.failDeploy) throw new Error("deploy failed");
    if (secretsFile) {
      const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
      this.deployedSecrets.push(secrets);
      for (const name of Object.keys(secrets)) this.secrets.add(name);
      // Private to its owner.
      expect((await stat(secretsFile)).mode & 0o077).toBe(0);
    }
    this.calls.push("deploy");
    return "https://design.ana.workers.dev";
  }
}

/** A terminal with scripted answers, keeping what was said. */
class ScriptedUi implements Ui {
  said: string[] = [];
  constructor(
    readonly interactive: boolean,
    private answers: unknown[] = [],
  ) {}
  private next<T>(question: string): T {
    if (this.answers.length === 0) throw new Error(`Unexpected question: ${question}`);
    this.said.push(`? ${question}`);
    return this.answers.shift() as T;
  }
  intro(title: string) {
    this.said.push(`intro ${title}`);
  }
  outro(message: string) {
    this.said.push(`outro ${message}`);
  }
  async text(q: { message: string; validate?: (v: string) => string | null }) {
    const value = this.next<string>(q.message);
    const problem = q.validate?.(value);
    if (problem) throw new Error(`Invalid answer "${value}": ${problem}`);
    return value;
  }
  async select<T>(q: { message: string; options: readonly Choice<T>[] }) {
    const label = this.next<string>(q.message);
    const choice = q.options.find((o) => o.label === label);
    if (!choice) throw new Error(`No option ${label}`);
    return choice.value;
  }
  async confirm(q: { message: string }) {
    return this.next<boolean>(q.message);
  }
  async step<T>(label: string, work: () => Promise<T>) {
    this.said.push(`step ${label}`);
    return work();
  }
  info(message: string) {
    this.said.push(`info ${message}`);
  }
  warn(message: string) {
    this.said.push(`warn ${message}`);
  }
  note(body: string, title: string) {
    this.said.push(`note ${title}\n${body}`);
  }
}

async function fakeRelease(version: string): Promise<Release> {
  const root = await mkdtemp(join(tmpdir(), "drawpane-release-"));
  await mkdir(join(root, "worker"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "migrations"));
  await writeFile(join(root, "worker/index.js"), `export default {}; // ${version}`);
  await writeFile(join(root, "assets/index.html"), "<!doctype html>");
  await writeFile(join(root, "migrations/0001_init.sql"), "SELECT 1;");
  await writeFile(
    join(root, "wrangler.template.json"),
    JSON.stringify({ compatibility_date: "2026-11-01", assets: { binding: "ASSETS" } }),
  );
  return { version, root };
}

let cwd: string;
let cloudflare: FakeCloudflare;
let opened: string[];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "drawpane-cwd-"));
  cloudflare = new FakeCloudflare();
  opened = [];
});

async function deps(ui: Ui, version = "0.1.0"): Promise<Deps> {
  return {
    ui,
    cloudflare,
    release: await fakeRelease(version),
    fetch: async () => new Response('{"ok":true}'),
    openBrowser: (url) => opened.push(url),
    env: {},
    cwd,
    healthTimeoutMs: 50,
  };
}

describe("install", () => {
  it("asks only what it needs, creates everything, and ends at the setup page", async () => {
    const ui = new ScriptedUi(true, ["studio", "studio", "", true, true]);
    await install({}, await deps(ui));

    expect(cloudflare.calls).toEqual([
      "create database studio",
      "create bucket studio-files",
      "migrate",
      "deploy",
    ]);
    const config = await readConfig(join(cwd, "studio"));
    expect(config).toMatchObject({
      version: "0.1.0",
      accountId: "acc-1",
      name: "studio",
      database: { name: "studio", id: "uuid-studio" },
      url: "https://design.ana.workers.dev",
    });
    // Both secrets went up with the deploy, never into the folder.
    const [secrets] = cloudflare.deployedSecrets;
    expect(Object.keys(secrets ?? {}).sort()).toEqual(["SESSION_SECRET", "SETUP_TOKEN"]);
    expect(secrets?.SESSION_SECRET?.length).toBeGreaterThanOrEqual(64);
    const saved = await readFile(join(cwd, "studio/drawpane.json"), "utf8");
    expect(saved).not.toContain(secrets?.SESSION_SECRET);
    // The setup page opens with the token filled in.
    expect(opened).toEqual([`https://design.ana.workers.dev/setup#token=${secrets?.SETUP_TOKEN}`]);
    expect(ui.said.some((l) => l.includes(secrets?.SETUP_TOKEN ?? "?"))).toBe(true);
    const wranglerConfig = await readFile(join(cwd, "studio/wrangler.jsonc"), "utf8");
    expect(wranglerConfig).toContain('"database_id": "uuid-studio"');
  });

  it("runs unattended with --yes, and on a domain", async () => {
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true, domain: "design.example.com" }, await deps(ui));
    const config = await readConfig(join(cwd, "team"));
    expect(config).toMatchObject({ name: "team", url: "https://design.example.com" });
    expect(opened).toEqual([]);
  });

  it("adopts a database and bucket that already exist instead of making duplicates", async () => {
    cloudflare.databases.set("team", "existing-uuid");
    cloudflare.buckets.add("team-files");
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
    expect((await readConfig(join(cwd, "team")))?.database.id).toBe("existing-uuid");
  });

  it("picks up after an interruption without a second session secret", async () => {
    cloudflare.failDeploy = true;
    await expect(
      install({ dir: "team", yes: true }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow("deploy failed");
    expect((await readConfig(join(cwd, "team")))?.database.id).toBe("uuid-team");

    cloudflare.failDeploy = false;
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true }, await deps(ui));
    expect(ui.said).toContain("info Picking up where the last install stopped.");
    // The database was made once.
    expect(cloudflare.calls.filter((c) => c.startsWith("create database"))).toHaveLength(1);
    expect((await readConfig(join(cwd, "team")))?.version).toBe("0.1.0");
  });

  it("sends the session secret only once, even when the address is slow to answer", async () => {
    const d = await deps(new ScriptedUi(false));
    await expect(
      install(
        { dir: "team", yes: true },
        { ...d, fetch: async () => new Response("", { status: 522 }) },
      ),
    ).rejects.toThrow(/isn't answering yet/);
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    expect(cloudflare.deployedSecrets.map((s) => "SESSION_SECRET" in s)).toEqual([true, false]);
    expect(cloudflare.deployedSecrets.every((s) => "SETUP_TOKEN" in s)).toBe(true);
  });

  it("adopts a running instance without touching its session secret or offering setup", async () => {
    cloudflare.databases.set("drawpane", "live-uuid");
    cloudflare.buckets.add("drawpane-files");
    cloudflare.secrets = new Set(["SESSION_SECRET", "SETUP_TOKEN"]);
    const d = await deps(new ScriptedUi(true, [true]));
    await install(
      { dir: "dogfood", name: "drawpane", domain: "design.example.com" },
      {
        ...d,
        fetch: async (url) =>
          new Response(
            JSON.stringify(url.endsWith("/api/session") ? { needsSetup: false } : { ok: true }),
          ),
      },
    );
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
    expect(cloudflare.deployedSecrets.map((s) => Object.keys(s))).toEqual([["SETUP_TOKEN"]]);
    const said = (d.ui as ScriptedUi).said;
    expect(said.some((l) => l.includes("already set up: sign in"))).toBe(true);
    expect(said.some((l) => l.includes("setup token"))).toBe(false);
    expect(opened).toEqual([]);
  });

  it("says so when the folder already runs an instance", async () => {
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true }, await deps(ui));
    expect(ui.said.some((l) => l.includes("upgrade"))).toBe(true);
    expect(cloudflare.calls.filter((c) => c === "deploy")).toHaveLength(1);
  });

  it("won't fill a folder that has other things in it", async () => {
    await mkdir(join(cwd, "notes"));
    await writeFile(join(cwd, "notes/todo.txt"), "milk");
    await expect(
      install({ dir: "notes", yes: true }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/already has files/);
  });

  it("signs in through the browser when nobody is signed in", async () => {
    cloudflare.signedIn = false;
    const ui = new ScriptedUi(true, [true, "team", "", true, false]);
    await install({ dir: "team" }, await deps(ui));
    expect(cloudflare.calls[0]).toBe("login");
    // Unattended, it says how to sign in instead.
    cloudflare.signedIn = false;
    await expect(
      install({ dir: "other", yes: true }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/wrangler login/);
  });

  it("asks which account when there are several, unless told", async () => {
    cloudflare.accountList.push({ id: "acc-2", name: "Client work" });
    await expect(
      install({ dir: "a", yes: true }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/--account/);
    await install(
      { dir: "b", yes: true, account: "client work" },
      await deps(new ScriptedUi(false)),
    );
    expect((await readConfig(join(cwd, "b")))?.accountId).toBe("acc-2");
    const ui = new ScriptedUi(true, ["Ana's studio", "c", "", true, false]);
    await install({ dir: "c" }, await deps(ui));
    expect((await readConfig(join(cwd, "c")))?.accountId).toBe("acc-1");
  });

  it("rejects a bad name or domain first: before asking anything, even before a sign-in", async () => {
    // Nobody signed in: a flag problem must still come first, not "Not signed in".
    cloudflare.signedIn = false;
    await expect(
      install({ dir: "x", yes: true, name: "Bad Name" }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/--name Bad Name: /);
    await expect(
      install({ dir: "x", yes: true, domain: "https://x.com" }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/--domain https:\/\/x\.com: .*without https/);
    // Interactively too: no question is asked first.
    await expect(
      install({ name: "Bad Name" }, await deps(new ScriptedUi(true))),
    ).rejects.toBeInstanceOf(Problem);
    expect(cloudflare.calls).toEqual([]);
  });

  it("keeps a domain given in capitals in lower case, as the prompt does", async () => {
    await install(
      { dir: "team", yes: true, domain: "Design.Example.COM" },
      await deps(new ScriptedUi(false)),
    );
    expect((await readConfig(join(cwd, "team")))?.domain).toBe("design.example.com");
  });
});

describe("upgrade", () => {
  beforeEach(async () => {
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false), "0.1.0"));
    cloudflare.calls = [];
  });

  it("swaps in the new release, migrates, deploys, and keeps the secrets", async () => {
    const ui = new ScriptedUi(false);
    await upgrade({ dir: "team", yes: true }, await deps(ui, "0.2.0"));
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
    expect(cloudflare.deployedSecrets).toHaveLength(1);
    expect((await readConfig(join(cwd, "team")))?.version).toBe("0.2.0");
    expect(await readFile(join(cwd, "team/server/worker/index.js"), "utf8")).toContain("0.2.0");
  });

  it("refuses to go backwards, and does nothing on the same version", async () => {
    await expect(
      upgrade({ dir: "team", yes: true }, await deps(new ScriptedUi(false), "0.0.9")),
    ).rejects.toThrow(/older than/);
    const ui = new ScriptedUi(false);
    await upgrade({ dir: "team", yes: true }, await deps(ui, "0.1.0"));
    expect(ui.said.some((l) => l.includes("Already on 0.1.0"))).toBe(true);
    expect(cloudflare.calls).toEqual([]);
    await upgrade({ dir: "team", yes: true, force: true }, await deps(new ScriptedUi(false)));
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
  });

  it("explains a folder that isn't an instance", async () => {
    await expect(
      upgrade({ dir: "elsewhere", yes: true }, await deps(new ScriptedUi(false), "0.2.0")),
    ).rejects.toThrow(/no drawpane.json/);
  });
});
