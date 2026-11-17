import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, holdReloadWhile, somethingUnsaved } from "./updates";

const answer = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("checkForUpdate", () => {
  it("never asks from a development build", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await checkForUpdate(1_000_000, "dev");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks at most every 15 seconds, quietly when it can't tell, and finds a newer build", async () => {
    answer({ error: "missing" }, 404);
    await checkForUpdate(1_000_000, "build-a");
    // Asked again too soon: no request.
    const soon = vi.fn();
    vi.stubGlobal("fetch", soon);
    await checkForUpdate(1_005_000, "build-a");
    expect(soon).not.toHaveBeenCalled();
    // The same build: nothing to offer.
    answer({ build: "build-a" });
    await checkForUpdate(1_020_000, "build-a");
    // Another build is deployed.
    const fetch = vi.fn(async () => new Response(JSON.stringify({ build: "build-b" })));
    vi.stubGlobal("fetch", fetch);
    await checkForUpdate(1_040_000, "build-a");
    expect(fetch).toHaveBeenCalledWith("/version.json", { cache: "no-store" });
    // Found: no more asking.
    const after = vi.fn();
    vi.stubGlobal("fetch", after);
    await checkForUpdate(2_000_000, "build-a");
    expect(after).not.toHaveBeenCalled();
  });
});

describe("holdReloadWhile", () => {
  it("says something is unsaved while any open file has edits waiting", () => {
    let pending = 1;
    const release = holdReloadWhile(() => pending > 0);
    expect(somethingUnsaved()).toBe(true);
    pending = 0;
    expect(somethingUnsaved()).toBe(false);
    pending = 2;
    release();
    expect(somethingUnsaved()).toBe(false);
  });
});
