/**
 * Stand-ins for what the installer drives: a Cloudflare account in memory, a
 * terminal with scripted answers, and a release on disk. Shared by the flow
 * tests.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { Account, Cloudflare } from "../src/cloudflare";
import type { Release } from "../src/release";
import type { Choice, Ui } from "../src/ui";

/** A Cloudflare account in memory, recording what was asked of it. */
export class FakeCloudflare implements Cloudflare {
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
  /** Values the email setup put, by name (deploys only record names). */
  secretValues = new Map<string, string>();
  async putSecrets(_dir: string, _: string, secretsFile: string) {
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect((await stat(secretsFile)).mode & 0o077).toBe(0);
    for (const [name, value] of Object.entries(secrets)) {
      this.secrets.add(name);
      this.secretValues.set(name, value);
    }
    this.calls.push(`put secrets ${Object.keys(secrets).sort().join(" ")}`);
  }
  async deleteSecret(_dir: string, _: string, name: string) {
    this.secrets.delete(name);
    this.secretValues.delete(name);
    this.calls.push(`delete secret ${name}`);
  }
  /** What the next migrate reports as applied. */
  applied: string[] = [];
  async migrate(dir: string) {
    // Wrangler would read the rendered config: it has to be there.
    await stat(join(dir, "wrangler.jsonc"));
    this.calls.push("migrate");
    return this.applied;
  }
  async deploy(dir: string, _: string, secretsFile: string | null) {
    await stat(join(dir, "server/worker/index.js"));
    if (this.failDeploy) throw new Error("deploy failed");
    if (secretsFile) {
      const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
      this.deployedSecrets.push(secrets);
      for (const [name, value] of Object.entries(secrets)) {
        this.secrets.add(name);
        this.secretValues.set(name, value);
      }
      // Private to its owner.
      expect((await stat(secretsFile)).mode & 0o077).toBe(0);
    }
    this.calls.push("deploy");
    return "https://design.ana.workers.dev";
  }
}

/** A terminal with scripted answers, keeping what was said. */
export class ScriptedUi implements Ui {
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
  async text(q: { message: string; initial?: string; validate?: (v: string) => string | null }) {
    const value = this.next<string>(q.message);
    const problem = q.validate?.(value);
    if (problem) throw new Error(`Invalid answer "${value}": ${problem}`);
    return value;
  }
  /** A masked answer: the question is kept, never the answer. */
  async secret(q: { message: string; validate?: (v: string) => string | null }) {
    const value = this.next<string>(q.message);
    const problem = q.validate?.(value);
    if (problem) throw new Error(`Invalid secret answer: ${problem}`);
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
  async step<T>(label: string, work: () => Promise<T>, done?: (result: T) => string) {
    this.said.push(`step ${label}`);
    const result = await work();
    if (done) this.said.push(`done ${done(result)}`);
    return result;
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

export async function fakeRelease(version: string): Promise<Release> {
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
