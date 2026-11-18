import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type Deps, install, upgrade } from "../src/flows";
import { readConfig, writeConfig } from "../src/instance";
import { Problem } from "../src/problem";
import type { Ui } from "../src/ui";
import { FakeCloudflare, fakeRelease, ScriptedUi } from "./fakes";

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
      "deploy runner",
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
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
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
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
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

/** A generated config in the instance's folder, parsed (it starts with comment lines). */
async function rendered(dir: string, file: string) {
  const text = await readFile(join(cwd, dir, file), "utf8");
  return JSON.parse(
    text
      .split("\n")
      .filter((l) => !l.startsWith("//"))
      .join("\n"),
  );
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("the agent runner", () => {
  it("is deployed first, named after the instance, and bound by the main Worker", async () => {
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true }, await deps(ui));
    expect(cloudflare.calls).toEqual([
      "create database team",
      "create bucket team-files",
      "migrate",
      "deploy runner",
      "deploy",
    ]);
    expect((await readConfig(join(cwd, "team")))?.runner).toBe("team-agent-runner");
    const runner = await rendered("team", "agent-runner.wrangler.jsonc");
    expect(runner).toMatchObject({
      name: "team-agent-runner",
      main: "server/agent-runner/index.js",
      workers_dev: false,
      d1_databases: [{ binding: "DB", database_name: "team", database_id: "uuid-team" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "team-files" }],
    });
    const main = await rendered("team", "wrangler.jsonc");
    expect(main.durable_objects.bindings).toContainEqual({
      name: "AGENT_RUNNER",
      class_name: "AgentRunner",
      script_name: "team-agent-runner",
    });
    expect(main.limits).toEqual({ cpu_ms: 300000 });
    expect(main.vars.AGENT_TOOLS).toBeUndefined();
    // The runner gets no secrets: they all went with the main Worker.
    expect(cloudflare.deployedSecrets).toHaveLength(1);
    // Nothing about the Free plan.
    expect(ui.said.some((l) => l.startsWith("warn"))).toBe(false);
  });

  it("is named in the note before anything is set up", async () => {
    const ui = new ScriptedUi(true, ["studio", "studio", "", true, false]);
    await install({}, await deps(ui));
    const note = ui.said.find((l) => l.startsWith("note About to set up"));
    expect(note).toContain("studio-agent-runner");
  });

  it("finishes an install that stopped between the runner and the main Worker", async () => {
    cloudflare.failDeploy = "main";
    await expect(
      install({ dir: "team", yes: true }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow("deploy failed");
    // The runner is up, the main Worker isn't: harmless.
    expect([...cloudflare.scripts]).toEqual(["team-agent-runner"]);
    expect((await readConfig(join(cwd, "team")))?.version).toBeNull();

    cloudflare.failDeploy = false;
    cloudflare.calls = [];
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true }, await deps(ui));
    expect(ui.said).toContain("info Picking up where the last install stopped.");
    // Nothing made twice: the runner deploys again (harmless), then the main Worker.
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
    expect([...cloudflare.scripts].sort()).toEqual(["team", "team-agent-runner"]);
    // The session secret went up once, with the deploy that worked.
    expect(cloudflare.deployedSecrets.map((s) => "SESSION_SECRET" in s)).toEqual([true]);
    expect((await readConfig(join(cwd, "team")))?.version).toBe("0.1.0");
  });

  it("is added to an instance from before it, on upgrade, ahead of the main Worker", async () => {
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    // As an older installer left it: one script, nothing about a runner.
    const { runner: _, ...old } = (await readConfig(join(cwd, "team"))) as NonNullable<
      Awaited<ReturnType<typeof readConfig>>
    >;
    await writeConfig(join(cwd, "team"), old);
    cloudflare.scripts = new Set(["team"]);
    cloudflare.calls = [];

    const ui = new ScriptedUi(true, [true]);
    await upgrade({ dir: "team" }, await deps(ui, "0.2.0"));
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
    expect(ui.said.find((l) => l.startsWith("note Upgrade"))).toContain("team-agent-runner");
    const config = await readConfig(join(cwd, "team"));
    expect(config).toMatchObject({ runner: "team-agent-runner", version: "0.2.0" });
    expect([...cloudflare.scripts].sort()).toEqual(["team", "team-agent-runner"]);
  });

  it("keeps the order on every upgrade", async () => {
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    for (const version of ["0.2.0", "0.3.0"]) {
      cloudflare.calls = [];
      await upgrade({ dir: "team", yes: true }, await deps(new ScriptedUi(false), version));
      expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
    }
  });
});

describe("the Workers Free plan", () => {
  async function expectFree(dir: string) {
    const main = await rendered(dir, "wrangler.jsonc");
    expect(main.limits).toBeUndefined();
    expect(main.durable_objects.bindings).toEqual([{ name: "FILE_ROOM", class_name: "FileRoom" }]);
    expect(main.vars.AGENT_TOOLS).toBe("off");
    expect(await exists(join(cwd, dir, "agent-runner.wrangler.jsonc"))).toBe(false);
    expect((await readConfig(join(cwd, dir)))?.plan).toBe("free");
    expect([...cloudflare.scripts]).toEqual([dir]);
  }

  it("deploys without the runner when told with --plan free", async () => {
    cloudflare.freePlan = true;
    const ui = new ScriptedUi(true, ["team", "", true, false]);
    await install({ dir: "team", plan: "free" }, await deps(ui));
    expect(cloudflare.calls).toEqual([
      "create database team",
      "create bucket team-files",
      "migrate",
      "deploy",
    ]);
    expect(ui.said.find((l) => l.startsWith("note About to set up"))).toContain(
      "agent tools need Workers Paid",
    );
    await expectFree("team");
  });

  it("finds out from a refused deploy, says so, and deploys again without the runner", async () => {
    cloudflare.freePlan = true;
    const ui = new ScriptedUi(false);
    await install({ dir: "team", yes: true }, await deps(ui));
    // The runner's deploy was refused (nothing recorded), then the main Worker went up once.
    expect(cloudflare.calls).toEqual([
      "create database team",
      "create bucket team-files",
      "migrate",
      "deploy",
    ]);
    expect(ui.said).toContainEqual(
      expect.stringMatching(
        /^warn Your Cloudflare account is on the Workers Free plan, so agent tools are off: they need Workers Paid\. The rest of Drawpane works within the Free plan's limits/,
      ),
    );
    await expectFree("team");
    expect((await readConfig(join(cwd, "team")))?.version).toBe("0.1.0");
    // Both secrets still went up, once.
    expect(cloudflare.deployedSecrets.map((s) => Object.keys(s).sort())).toEqual([
      ["SESSION_SECRET", "SETUP_TOKEN"],
    ]);
  });

  it("stays free on upgrade, and --plan paid turns agent tools back on", async () => {
    cloudflare.freePlan = true;
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false)));
    cloudflare.calls = [];
    const ui = new ScriptedUi(false);
    await upgrade({ dir: "team", yes: true }, await deps(ui, "0.2.0"));
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
    // Known already: no second warning.
    expect(ui.said.some((l) => l.startsWith("warn"))).toBe(false);
    await expectFree("team");

    // The account moved to Workers Paid: the same version deploys again, with the runner.
    cloudflare.freePlan = false;
    cloudflare.calls = [];
    await upgrade(
      { dir: "team", yes: true, plan: "paid" },
      await deps(new ScriptedUi(false), "0.2.0"),
    );
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
    expect((await readConfig(join(cwd, "team")))?.plan).toBe("paid");
    const main = await rendered("team", "wrangler.jsonc");
    expect(main.vars.AGENT_TOOLS).toBeUndefined();
    expect(main.limits).toEqual({ cpu_ms: 300000 });
    expect(await exists(join(cwd, "team/agent-runner.wrangler.jsonc"))).toBe(true);
  });

  it("rejects a plan that isn't paid or free, before anything else", async () => {
    await expect(
      install({ dir: "team", yes: true, plan: "pro" }, await deps(new ScriptedUi(false))),
    ).rejects.toThrow(/--plan pro: Use paid or free/);
    expect(cloudflare.calls).toEqual([]);
  });

  it("doesn't mistake another refused deploy for the Free plan", async () => {
    cloudflare.failDeploy = true;
    const ui = new ScriptedUi(false);
    await expect(install({ dir: "team", yes: true }, await deps(ui))).rejects.toThrow(
      "deploy failed",
    );
    expect((await readConfig(join(cwd, "team")))?.plan).toBeUndefined();
    expect(ui.said.some((l) => l.startsWith("warn"))).toBe(false);
  });
});

describe("upgrade", () => {
  beforeEach(async () => {
    await install({ dir: "team", yes: true }, await deps(new ScriptedUi(false), "0.1.0"));
    cloudflare.calls = [];
  });

  it("swaps in the new release, migrates, deploys, and keeps the secrets", async () => {
    const ui = new ScriptedUi(false);
    cloudflare.applied = ["0011_invite_notes", "0012_room_connections"];
    await upgrade({ dir: "team", yes: true }, await deps(ui, "0.2.0"));
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
    // It says what it applied, not just "up to date".
    expect(ui.said).toContain(
      "done Database updated: 2 migrations (0011_invite_notes, 0012_room_connections)",
    );
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
    expect(cloudflare.calls).toEqual(["migrate", "deploy runner", "deploy"]);
  });

  it("explains a folder that isn't an instance", async () => {
    await expect(
      upgrade({ dir: "elsewhere", yes: true }, await deps(new ScriptedUi(false), "0.2.0")),
    ).rejects.toThrow(/no drawpane.json/);
  });
});
