import { MAX_IMPORT_BYTES, MAX_IMPORT_NODES, type NodeRecord } from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_LAYERS, ImportTooLarge, saveImport } from "./import-save";

const node = (id: string, name = "Layer"): NodeRecord =>
  ({ id, type: "rect", parent: "p", key: "a0", props: { name } }) as unknown as NodeRecord;

describe("saving an import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aims below the byte limit, which comes before the node limit", () => {
    expect(FILE_LAYERS).toBeLessThan(MAX_IMPORT_NODES);
    expect(FILE_LAYERS * 510).toBeLessThan(MAX_IMPORT_BYTES);
  });

  it("sends the nodes, serialized once", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ revn: 1, nodes: 1 })));
    vi.stubGlobal("fetch", fetch);
    await saveImport("F1", [node("n1")]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/files/F1/import");
    expect(JSON.parse(init.body as string)).toEqual({ nodes: [node("n1")] });
  });

  it("refuses, before sending, what the server would, saying by how much", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const big = [node("n1", "x".repeat(MAX_IMPORT_BYTES))];
    const error = await saveImport("F1", big).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportTooLarge);
    expect((error as ImportTooLarge).message).toMatch(
      /^This comes to 25 MB, more than one Drawpane file takes \(24 MB\)\.$/,
    );
    expect((error as ImportTooLarge).fits).toBeCloseTo(1, 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(new ImportTooLarge(MAX_IMPORT_BYTES * 2, 10).fits).toBe(0.5);
    expect(new ImportTooLarge(10, MAX_IMPORT_NODES * 4).fits).toBe(0.25);
  });
});
