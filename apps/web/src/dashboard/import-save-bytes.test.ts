import type { NodeRecord } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";

// A file's byte limit made small, to see the refusals without building hundreds of MB.
vi.mock("@drawpane/model", async (original) => ({
  ...(await original<typeof import("@drawpane/model")>()),
  MAX_IMPORT_BYTES: 10 * 1024 * 1024,
  IMPORT_PART_BYTES: 1024 * 1024,
}));

const { ImportTooLarge, saveImport } = await import("./import-save");

const node = (id: string, size: number): NodeRecord =>
  ({ id, type: "rect", parent: "p", key: "a0", props: { name: "x".repeat(size) } }) as NodeRecord;

describe("an import past the byte limit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is refused before sending when its first part is already too much", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const error = await saveImport("F1", [node("n1", 11 * 1024 * 1024)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportTooLarge);
    expect((error as Error).message).toBe(
      "This comes to 12 MB, more than one Drawpane file takes (10 MB).",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is given up as soon as it passes, with the whole estimated", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/imports")
        ? new Response(JSON.stringify({ importId: "I1" }), { status: 201 })
        : new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);
    // Twenty parts of about 1 MB: twice what the file takes.
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`, 1024 * 1024 - 100));
    const error = await saveImport("F1", nodes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportTooLarge);
    expect((error as InstanceType<typeof ImportTooLarge>).fits).toBeCloseTo(0.5, 1);
    const urls = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([url, init]) => `${init.method} ${url}`,
    );
    expect(urls.filter((u) => u.endsWith("/parts")).length).toBe(10);
    expect(urls.at(-1)).toBe("DELETE /api/files/F1/imports/I1");
  });
});
