import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  isFreePlanRefusal,
  isTransient,
  WranglerError,
  withRetries,
} from "../src/cloudflare";
import {
  compareVersions,
  domainProblem,
  instanceRunner,
  nameProblem,
  newConfig,
  readConfig,
  runnerName,
  suggestName,
  writeConfig,
} from "../src/instance";
import { Problem } from "../src/problem";
import { renderRunnerConfig, renderWranglerConfig } from "../src/release";

describe("names", () => {
  it("suggests a Worker name from the folder", () => {
    expect(suggestName("My Design Team")).toBe("my-design-team");
    expect(suggestName("--drawpane__2--")).toBe("drawpane-2");
    expect(suggestName("日本語")).toBe("drawpane");
    expect(suggestName("über-design")).toBe("uber-design");
    expect(suggestName("Café Équipe")).toBe("cafe-equipe");
    expect(suggestName("a".repeat(80))).toHaveLength(63);
  });

  it("checks Worker names and domains", () => {
    expect(nameProblem("design")).toBeNull();
    expect(nameProblem("Design")).not.toBeNull();
    expect(nameProblem("-design")).not.toBeNull();
    expect(domainProblem("")).toBeNull();
    expect(domainProblem("design.example.com")).toBeNull();
    expect(domainProblem("https://design.example.com")).toMatch(/without https/);
    expect(domainProblem("localhost")).not.toBeNull();
  });
});

describe("versions", () => {
  it("orders releases, with pre-releases before their release", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("orders pre-releases by semver: numbers as numbers, before words", () => {
    // The order the semver spec gives, shuffled; plus build metadata, which doesn't count.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1-0",
      "1.0.1",
    ];
    const shuffled = [...ordered].reverse();
    shuffled.push(shuffled.shift() as string);
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0+build.7", "1.0.0")).toBe(0);
  });
});

describe("drawpane.json", () => {
  it("round-trips, and says what's wrong when it's invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawpane-config-"));
    expect(await readConfig(dir)).toBeNull();
    const config = newConfig({ accountId: "acc", name: "design", domain: null });
    await writeConfig(dir, config);
    expect(await readConfig(dir)).toEqual(config);
    await writeFile(join(dir, "drawpane.json"), JSON.stringify({ ...config, name: "Not OK" }));
    await expect(readConfig(dir)).rejects.toThrow(/name: lowercase/);
  });

  it("names the file and what's wrong when it can't be used, as something to fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawpane-config-"));
    const file = join(dir, "drawpane.json");
    await writeFile(file, '{ "name": "design", }');
    const broken = await readConfig(dir).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(Problem);
    expect((broken as Error).message.startsWith(`${file} isn't valid JSON (`)).toBe(true);
    await writeFile(file, "[]");
    await expect(readConfig(dir)).rejects.toThrow(`${file} isn't valid: `);
    // A folder where the file should be: still a problem to fix, not a crash.
    await rm(file);
    await mkdir(file);
    await expect(readConfig(dir)).rejects.toThrow(`Couldn't read ${file}: EISDIR.`);
  });

  it("records the agent runner's name, and reads an older config without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawpane-config-"));
    const config = newConfig({ accountId: "acc", name: "design", domain: null });
    expect(config.runner).toBe("design-agent-runner");
    expect(config.plan).toBeUndefined();
    const { runner: _, ...old } = config;
    await writeFile(join(dir, "drawpane.json"), JSON.stringify(old));
    const read = await readConfig(dir);
    expect(read?.runner).toBeUndefined();
    expect(instanceRunner(read as NonNullable<typeof read>)).toBe("design-agent-runner");
    await writeFile(join(dir, "drawpane.json"), JSON.stringify({ ...config, runner: "Runner!" }));
    await expect(readConfig(dir)).rejects.toThrow(/runner: lowercase/);
    await writeFile(join(dir, "drawpane.json"), JSON.stringify({ ...config, plan: "free" }));
    expect((await readConfig(dir))?.plan).toBe("free");
    await writeFile(join(dir, "drawpane.json"), JSON.stringify({ ...config, plan: "pro" }));
    await expect(readConfig(dir)).rejects.toThrow(/plan: /);
  });

  it("keeps the runner's name a Worker name, even after a long instance name", () => {
    expect(runnerName("design")).toBe("design-agent-runner");
    const long = runnerName("a".repeat(50));
    expect(long).toHaveLength(63);
    expect(nameProblem(long)).toBeNull();
    expect(runnerName(`${"a".repeat(49)}-b`)).toBe(`${"a".repeat(49)}-agent-runner`);
  });
});

describe("wrangler.jsonc", () => {
  const template = {
    compatibility_date: "2026-11-01",
    assets: { binding: "ASSETS", run_worker_first: ["/api/*"] },
    durable_objects: { bindings: [{ name: "FILE_ROOM", class_name: "FileRoom" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["FileRoom"] }],
  };
  const parse = (text: string) =>
    JSON.parse(
      text
        .split("\n")
        .filter((l) => !l.startsWith("//"))
        .join("\n"),
    );

  it("keeps the release's settings and fills in the instance's", () => {
    const config = {
      ...newConfig({ accountId: "acc", name: "design", domain: null }),
      database: { name: "design", id: "db-1" },
    };
    const text = renderWranglerConfig(template, config, "0.1.0");
    expect(text.startsWith("// Generated by create-drawpane")).toBe(true);
    const rendered = parse(text);
    expect(rendered).toMatchObject({
      name: "design",
      main: "server/worker/index.js",
      no_bundle: true,
      workers_dev: true,
      compatibility_date: "2026-11-01",
      migrations: template.migrations,
      durable_objects: template.durable_objects,
      assets: { binding: "ASSETS", run_worker_first: ["/api/*"], directory: "server/assets" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "design",
          database_id: "db-1",
          migrations_dir: "server/migrations",
        },
      ],
      r2_buckets: [{ binding: "FILES", bucket_name: "design-files" }],
    });
    expect(rendered.routes).toBeUndefined();
  });

  it("lays the instance's settings over the release's", () => {
    const config = {
      ...newConfig({ accountId: "acc", name: "design", domain: null }),
      vars: { GOOGLE_FONTS: "off" },
    };
    const rendered = parse(
      renderWranglerConfig({ ...template, vars: { RP_NAME: "Drawpane" } }, config, "0.1.0"),
    );
    // The release's version always wins: it's what the Worker reports as running.
    expect(rendered.vars).toEqual({
      RP_NAME: "Drawpane",
      GOOGLE_FONTS: "off",
      DRAWPANE_VERSION: "0.1.0",
    });
  });

  const withRunner = {
    ...template,
    limits: { cpu_ms: 300000 },
    durable_objects: {
      bindings: [
        { name: "FILE_ROOM", class_name: "FileRoom" },
        { name: "AGENT_RUNNER", class_name: "AgentRunner", script_name: "drawpane-agent-runner" },
      ],
    },
  };

  it("binds the instance's own agent runner", () => {
    const config = newConfig({ accountId: "acc", name: "design", domain: null });
    const rendered = parse(renderWranglerConfig(withRunner, config, "0.1.0"));
    expect(rendered.durable_objects.bindings).toEqual([
      { name: "FILE_ROOM", class_name: "FileRoom" },
      { name: "AGENT_RUNNER", class_name: "AgentRunner", script_name: "design-agent-runner" },
    ]);
    expect(rendered.limits).toEqual({ cpu_ms: 300000 });
    expect(rendered.vars.AGENT_TOOLS).toBeUndefined();
    // An older config without a runner name gets the default.
    const { runner: _, ...old } = config;
    expect(
      parse(renderWranglerConfig(withRunner, old, "0.1.0")).durable_objects.bindings[1].script_name,
    ).toBe("design-agent-runner");
  });

  it("on the Free plan, leaves out the CPU limit and the runner, and turns agent tools off", () => {
    const config = {
      ...newConfig({ accountId: "acc", name: "design", domain: null }),
      plan: "free" as const,
      vars: { GOOGLE_FONTS: "off" },
    };
    const rendered = parse(renderWranglerConfig(withRunner, config, "0.1.0"));
    expect(rendered.limits).toBeUndefined();
    expect(rendered.durable_objects.bindings).toEqual([
      { name: "FILE_ROOM", class_name: "FileRoom" },
    ]);
    expect(rendered.migrations).toEqual(template.migrations);
    expect(rendered.vars).toEqual({
      GOOGLE_FONTS: "off",
      AGENT_TOOLS: "off",
      DRAWPANE_VERSION: "0.1.0",
    });
  });

  it("renders the runner with the instance's name, storage and settings, and no address", () => {
    const runnerTemplate = {
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat"],
      limits: { cpu_ms: 60000 },
      workers_dev: false,
      durable_objects: { bindings: [{ name: "AGENT_RUNNER", class_name: "AgentRunner" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["AgentRunner"] }],
    };
    const config = {
      ...newConfig({ accountId: "acc", name: "design", domain: "design.example.com" }),
      database: { name: "design", id: "db-1" },
      vars: { GOOGLE_FONTS: "off" },
    };
    const text = renderRunnerConfig(runnerTemplate, config, "0.1.0");
    expect(text.startsWith("// Generated by create-drawpane")).toBe(true);
    const rendered = parse(text);
    expect(rendered).toEqual({
      ...runnerTemplate,
      name: "design-agent-runner",
      main: "server/agent-runner/index.js",
      no_bundle: true,
      upload_source_maps: true,
      workers_dev: false,
      d1_databases: [
        {
          binding: "DB",
          database_name: "design",
          database_id: "db-1",
        },
      ],
      r2_buckets: [{ binding: "FILES", bucket_name: "design-files" }],
      vars: { GOOGLE_FONTS: "off", DRAWPANE_VERSION: "0.1.0" },
    });
  });

  it("serves a domain as a custom domain instead of workers.dev", () => {
    const config = newConfig({ accountId: "acc", name: "design", domain: "design.example.com" });
    const rendered = parse(renderWranglerConfig(template, config, "0.1.0"));
    expect(rendered.workers_dev).toBe(false);
    expect(rendered.routes).toEqual([{ pattern: "design.example.com", custom_domain: true }]);
  });
});

describe("migrations", () => {
  it("reads which ones Wrangler applied from its results table", () => {
    const output = [
      "Migrations to be applied:",
      "┌───────────────────────────┐",
      "│ name                      │",
      "│ 0011_invite_notes.sql     │",
      "│ 0012_room_connections.sql │",
      "└───────────────────────────┘",
      "┌───────────────────────────┬────────┐",
      "│ name                      │ status │",
      "│ 0011_invite_notes.sql     │ ✅     │",
      "│ 0012_room_connections.sql │ ✅     │",
      "└───────────────────────────┴────────┘",
    ].join("\n");
    expect(appliedMigrations(output)).toEqual(["0011_invite_notes", "0012_room_connections"]);
    expect(appliedMigrations("✅ No migrations to apply!")).toEqual([]);
  });
});

describe("isTransient", () => {
  it("tries again on Cloudflare's internal errors, rate limits and dropped connections", () => {
    expect(
      isTransient(
        "✘ [ERROR] A request to the Cloudflare API (/accounts/x/r2/buckets) failed.\n  We encountered an internal error. Please try again. [code: 10001]",
      ),
    ).toBe(true);
    expect(isTransient("429 Too Many Requests")).toBe(true);
    expect(isTransient("TypeError: fetch failed")).toBe(true);
  });

  it("tries again after each delay, then gives up; a lasting refusal fails at once", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const flaky = (failures: number, output: string) => {
      let n = 0;
      return async () => {
        if (n++ < failures) throw new WranglerError("r2 bucket", output);
        return "ok";
      };
    };
    const internal = "We encountered an internal error. Please try again. [code: 10001]";
    expect(await withRetries(flaky(2, internal), [1, 2], sleep)).toBe("ok");
    expect(waits).toEqual([1, 2]);
    await expect(withRetries(flaky(3, internal), [1, 2], sleep)).rejects.toThrow(WranglerError);
    waits.length = 0;
    await expect(
      withRetries(flaky(1, "Authentication error [code: 10000]"), [1, 2], sleep),
    ).rejects.toThrow();
    expect(waits).toEqual([]);
  });

  it("tells each failed try, so what it did before failing still counts", async () => {
    const seen: string[] = [];
    let n = 0;
    const partly = async () => {
      if (n++ === 0)
        throw new WranglerError(
          "d1 migrations",
          "│ 0001_init.sql │ ✅ │\n│ 0002_more.sql │ ❌ │\nInternal error [code: 10001]",
        );
      return "│ 0002_more.sql │ ✅ │";
    };
    const output = await withRetries(
      partly,
      [1],
      async () => {},
      (error) => {
        if (error instanceof WranglerError) seen.push(...appliedMigrations(error.output));
      },
    );
    expect(seen).toEqual(["0001_init"]);
    expect(appliedMigrations(output)).toEqual(["0002_more"]);
  });

  it("doesn't on a refusal that won't change", () => {
    expect(isTransient("Authentication error [code: 10000]")).toBe(false);
    expect(isTransient("A bucket with this name already exists [code: 10004]")).toBe(false);
  });
});

describe("isFreePlanRefusal", () => {
  // Guesses at Cloudflare's wording: the real text is unverified, so the match is loose.
  it("knows a deploy refused for CPU limits on the Free plan", () => {
    expect(
      isFreePlanRefusal("CPU limits are not supported on the Workers Free plan. [code: 100328]"),
    ).toBe(true);
    expect(isFreePlanRefusal("limits.cpu_ms can't be set on the free plan")).toBe(true);
    expect(isFreePlanRefusal("Setting a CPU limit requires Workers Paid; you're on Free")).toBe(
      true,
    );
  });

  it("doesn't mistake other refusals for it", () => {
    expect(isFreePlanRefusal("Authentication error [code: 10000]")).toBe(false);
    expect(isFreePlanRefusal("Exceeded CPU limit [code: 10021]")).toBe(false);
    expect(isFreePlanRefusal("Your account is on the Free plan: too many Workers")).toBe(false);
  });
});
