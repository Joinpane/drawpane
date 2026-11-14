import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceHealth } from "../src/api/admin";
import { compareVersions, UPDATE_CACHE_KEY } from "../src/api/updates";
import type { Env } from "../src/env";

const NPM = "https://registry.npmjs.org/create-drawpane/latest";

/** npm, answering with `latest` (or failing), counting how often it's asked. */
function stubNpm(latest: string | "down") {
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === NPM) {
      calls.push(url);
      return latest === "down"
        ? new Response("unavailable", { status: 503 })
        : Response.json({ name: "create-drawpane", version: latest });
    }
    return real(input, init);
  });
  return calls;
}

const running = (version?: string, extra: Partial<Env> = {}): Env =>
  ({ ...env, ...(version ? { DRAWPANE_VERSION: version } : {}), ...extra }) as Env;

beforeEach(async () => {
  await caches.default.delete(new Request(UPDATE_CACHE_KEY));
});
afterEach(() => vi.restoreAllMocks());

describe("update check", () => {
  it("says a newer release is out, with its notes, and remembers the answer", async () => {
    const calls = stubNpm("0.2.0");
    const health = await instanceHealth(running("0.1.0"), 7);
    expect(health.version).toBe("0.1.0");
    expect(health.update).toEqual({
      version: "0.2.0",
      notesUrl: "https://github.com/Joinpane/drawpane/releases/tag/v0.2.0",
    });
    await instanceHealth(running("0.1.0"), 7);
    expect(calls).toHaveLength(1);
  });

  it("says nothing when up to date, when npm is down, or when the version isn't known", async () => {
    stubNpm("0.1.0");
    expect((await instanceHealth(running("0.1.0"), 7)).update).toBeNull();
    await caches.default.delete(new Request(UPDATE_CACHE_KEY));
    vi.restoreAllMocks();
    stubNpm("down");
    expect((await instanceHealth(running("0.1.0"), 7)).update).toBeNull();
    // Installed by hand: no version to compare with, so npm isn't asked.
    vi.restoreAllMocks();
    const calls = stubNpm("9.9.9");
    const handmade = await instanceHealth(running(), 7);
    expect(handmade.version).toBeNull();
    expect(handmade.update).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never asks npm when UPDATE_CHECK is off", async () => {
    const calls = stubNpm("0.2.0");
    const health = await instanceHealth(running("0.1.0", { UPDATE_CHECK: "off" }), 7);
    expect(health.update).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("compareVersions", () => {
  it("orders releases, pre-releases before theirs", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});
