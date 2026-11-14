import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMAIL_SECRETS,
  emailSecretsFromEnv,
  fromProblem,
  PROVIDERS,
  smtpUrl,
  smtpUrlProblem,
} from "../src/email";
import { configureEmail, type Deps, install } from "../src/flows";
import { readConfig } from "../src/instance";
import type { Ui } from "../src/ui";
import { FakeCloudflare, fakeRelease, ScriptedUi } from "./fakes";

const WORKER = new URL("../../../apps/worker/src/", import.meta.url);

describe("what the Worker reads", () => {
  it("offers every provider the Worker sends with, and no other", async () => {
    const setup = await readFile(new URL("email/setup.ts", WORKER), "utf8");
    const list = /EMAIL_PROVIDERS = \[([^\]]*)\]/.exec(setup)?.[1] ?? "";
    const worker = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    // `off` is a choice of its own; `log` is for development.
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(
      worker.filter((p) => p !== "off" && p !== "log").sort(),
    );
  });

  it("names only settings the Worker has", async () => {
    const env = await readFile(new URL("env.ts", WORKER), "utf8");
    for (const name of EMAIL_SECRETS) expect(env).toMatch(new RegExp(`\\b${name}\\?:`));
  });
});

describe("email settings", () => {
  it("builds an SMTP URL that survives any password", () => {
    const url = smtpUrl({
      host: "smtp.example.com",
      port: 587,
      user: "me@x.co",
      password: "p@ss/w:rd",
    });
    expect(url).toBe("smtp://me%40x.co:p%40ss%2Fw%3Ard@smtp.example.com:587");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/w:rd");
    expect(smtpUrl({ host: "smtp.example.com", port: 465, user: "a", password: "b" })).toMatch(
      /^smtps:\/\//,
    );
    expect(smtpUrlProblem(url)).toBeNull();
    expect(smtpUrlProblem("https://smtp.example.com")).toMatch(/smtp:\/\//);
    expect(smtpUrlProblem("smtp.example.com:587")).toMatch(/smtp|URL/);
  });

  it("knows a From address", () => {
    expect(fromProblem("Drawpane <design@example.com>")).toBeNull();
    expect(fromProblem("design@example.com")).toBeNull();
    expect(fromProblem("Drawpane")).toMatch(/An address/);
    expect(fromProblem("design@localhost")).toMatch(/An address/);
  });

  it("reads settings from the environment, saying everything that's missing at once", () => {
    expect(() => emailSecretsFromEnv({})).toThrow(/Set EMAIL_PROVIDER/);
    expect(() => emailSecretsFromEnv({ EMAIL_PROVIDER: "pigeon" })).toThrow(/"pigeon"/);
    expect(() => emailSecretsFromEnv({ EMAIL_PROVIDER: "ses" })).toThrow(
      /EMAIL_FROM[\s\S]*AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/,
    );
    expect(emailSecretsFromEnv({ EMAIL_PROVIDER: "off" })).toEqual({ provider: null });
    // Only what the provider reads: a stray AWS_REGION in CI stays out of a Resend setup.
    const resend = emailSecretsFromEnv({
      EMAIL_PROVIDER: "Resend",
      EMAIL_FROM: "design@example.com",
      EMAIL_API_KEY: "re_1",
      AWS_REGION: "us-east-1",
    });
    expect(resend).toMatchObject({
      secrets: {
        EMAIL_PROVIDER: "resend",
        EMAIL_FROM: "design@example.com",
        EMAIL_API_KEY: "re_1",
      },
    });
    expect("secrets" in resend && "AWS_REGION" in resend.secrets).toBe(false);
  });
});

let cwd: string;
let cloudflare: FakeCloudflare;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "drawpane-cwd-"));
  cloudflare = new FakeCloudflare();
});

async function deps(ui: Ui, { version = "0.1.0", env = {} } = {}): Promise<Deps> {
  return {
    ui,
    cloudflare,
    release: await fakeRelease(version),
    fetch: async () => new Response('{"ok":true,"needsSetup":true}'),
    openBrowser: () => {},
    env,
    cwd,
    healthTimeoutMs: 50,
  };
}

/** An installed instance in `team/`, with nothing asked of the fake since. */
async function installed() {
  const ui = new ScriptedUi(false);
  await install({ dir: "team", yes: true, domain: "design.example.com" }, await deps(ui));
  cloudflare.calls = [];
  return ui;
}

describe("setting up email", () => {
  it("is suggested when an install finishes", async () => {
    const ui = await installed();
    expect(ui.said.some((l) => l.includes("npm create drawpane@latest email"))).toBe(true);
  });

  it("asks for a provider's settings and saves them as secrets, never showing the key", async () => {
    await installed();
    const ui = new ScriptedUi(true, ["Resend", "Drawpane <design@example.com>", "re_s3cret", true]);
    await configureEmail({ dir: "team" }, await deps(ui));
    expect(cloudflare.calls).toEqual(["put secrets EMAIL_API_KEY EMAIL_FROM EMAIL_PROVIDER"]);
    expect(cloudflare.secretValues.get("EMAIL_API_KEY")).toBe("re_s3cret");
    expect(cloudflare.secretValues.get("EMAIL_PROVIDER")).toBe("resend");
    expect(ui.said.join("\n")).not.toContain("re_s3cret");
    expect(ui.said.join("\n")).toContain("EMAIL_API_KEY   set, hidden");
    expect(ui.said.at(-1)).toBe(
      "outro Email goes through Resend. Send yourself a test from https://design.example.com/admin/health.",
    );
  });

  it("suggests a From address on the instance's domain", async () => {
    await installed();
    let suggested: string | undefined;
    const ui = new ScriptedUi(true, ["Resend", "design@example.com", "re_1", true]);
    const text = ui.text.bind(ui);
    ui.text = async (q) => {
      suggested ??= q.initial;
      return text(q);
    };
    await configureEmail({ dir: "team" }, await deps(ui));
    expect(suggested).toBe("Drawpane <drawpane@design.example.com>");
  });

  it("switches providers, removing the old one's keys", async () => {
    await installed();
    cloudflare.secrets.add("EMAIL_PROVIDER").add("EMAIL_FROM").add("EMAIL_API_KEY");
    const ui = new ScriptedUi(true, [
      "SMTP",
      "design@example.com",
      "smtp.fastmail.com",
      "Port 465",
      "me@example.com",
      "pa:ss@word",
      true,
    ]);
    await configureEmail({ dir: "team" }, await deps(ui));
    expect(cloudflare.calls).toEqual([
      "put secrets EMAIL_FROM EMAIL_PROVIDER SMTP_URL",
      "delete secret EMAIL_API_KEY",
    ]);
    expect(cloudflare.secretValues.get("SMTP_URL")).toBe(
      "smtps://me%40example.com:pa%3Ass%40word@smtp.fastmail.com:465",
    );
    expect(ui.said.join("\n")).not.toContain("pa%3Ass%40word");
    expect(ui.said.join("\n")).toContain("Removes the old EMAIL_API_KEY.");
  });

  it("turns email off, removing every setting it had", async () => {
    await installed();
    for (const name of ["EMAIL_PROVIDER", "EMAIL_FROM", "AWS_REGION", "SESSION_SECRET"])
      cloudflare.secrets.add(name);
    const ui = new ScriptedUi(true, ["Turn email off", true]);
    await configureEmail({ dir: "team" }, await deps(ui));
    expect(cloudflare.calls).toEqual([
      "delete secret EMAIL_PROVIDER",
      "delete secret EMAIL_FROM",
      "delete secret AWS_REGION",
    ]);
    // Only email's own settings.
    expect(cloudflare.secrets.has("SESSION_SECRET")).toBe(true);
  });

  it("only offers turning off when email is on", async () => {
    await installed();
    let offered: string[] = [];
    const ui = new ScriptedUi(true, ["Resend"]);
    const select = ui.select.bind(ui);
    ui.select = async (q) => {
      offered = q.options.map((o) => o.label);
      return select(q);
    };
    await expect(configureEmail({ dir: "team" }, await deps(ui))).rejects.toThrow(
      /Unexpected question/,
    );
    expect(offered).not.toContain("Turn email off");
    expect(offered[0]).toBe("Resend");
  });

  it("deploys with a send_email binding for Cloudflare Email Service", async () => {
    await installed();
    const ui = new ScriptedUi(true, ["Cloudflare Email Service", "design@example.com", true]);
    await configureEmail({ dir: "team" }, await deps(ui));
    expect(cloudflare.calls).toEqual(["migrate", "deploy"]);
    expect(cloudflare.deployedSecrets.at(-1)).toEqual({
      EMAIL_PROVIDER: "cloudflare",
      EMAIL_FROM: "design@example.com",
    });
    const rendered = await readFile(join(cwd, "team/wrangler.jsonc"), "utf8");
    expect(rendered).toContain('"send_email"');
    expect((await readConfig(join(cwd, "team")))?.sendEmail).toBe(true);
  });

  it("won't deploy another version for Cloudflare Email Service: upgrade first", async () => {
    await installed();
    const ui = new ScriptedUi(true, ["Cloudflare Email Service", "design@example.com", true]);
    await expect(
      configureEmail({ dir: "team" }, await deps(ui, { version: "0.2.0" })),
    ).rejects.toThrow(/Upgrade first/);
    expect(cloudflare.calls).toEqual([]);
    expect((await readConfig(join(cwd, "team")))?.sendEmail).toBeUndefined();
  });

  it("runs unattended from the environment with --yes", async () => {
    await installed();
    const env = {
      EMAIL_PROVIDER: "mailgun",
      EMAIL_FROM: "design@example.com",
      EMAIL_API_KEY: "key-1",
      MAILGUN_REGION: "eu",
    };
    await configureEmail({ dir: "team", yes: true }, await deps(new ScriptedUi(false), { env }));
    expect(cloudflare.calls).toEqual([
      "put secrets EMAIL_API_KEY EMAIL_FROM EMAIL_PROVIDER MAILGUN_REGION",
    ]);
  });

  it("needs a finished install, and changes nothing when the answer is no", async () => {
    await expect(
      configureEmail({ dir: "nowhere" }, await deps(new ScriptedUi(true))),
    ).rejects.toThrow(/There's no drawpane.json/);
    await installed();
    const ui = new ScriptedUi(true, ["Postmark", "design@example.com", "pm-token", false]);
    await expect(configureEmail({ dir: "team" }, await deps(ui))).rejects.toThrow(
      "Nothing changed.",
    );
    expect(cloudflare.calls).toEqual([]);
  });
});
