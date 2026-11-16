import {
  IMPORT_PART_BYTES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_NODES,
  type NodeRecord,
} from "@drawpane/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_LAYERS, ImportTooLarge, saveImport } from "./import-save";

const node = (id: string, name = "Layer"): NodeRecord =>
  ({ id, type: "rect", parent: "p", key: "a0", props: { name } }) as unknown as NodeRecord;

/** A fetch that answers as the server does, and keeps what was asked. */
function server() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/imports") && init?.method === "POST")
      return new Response(JSON.stringify({ importId: "I1" }), { status: 201 });
    if (url.endsWith("/parts")) return new Response(JSON.stringify({ staged: 1 }));
    if (url.endsWith("/commit")) return new Response(JSON.stringify({ revn: 2, nodes: 1 }));
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal("fetch", fetch);
  const calls = () =>
    (fetch.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
      url,
      method: init.method,
      body: init.body as string | undefined,
    }));
  return { fetch, calls };
}

describe("saving an import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("aims for a million layers, which the byte limit allows", () => {
    expect(FILE_LAYERS).toBe(MAX_IMPORT_NODES);
    expect(FILE_LAYERS).toBeGreaterThanOrEqual(1_000_000);
    expect(FILE_LAYERS * 510).toBeLessThan(MAX_IMPORT_BYTES);
  });

  it("sends the nodes in parts, then commits", async () => {
    const { calls } = server();
    // Three parts' worth: each node about a third of a part.
    const nodes = [0, 1, 2, 3, 4, 5].map((i) => node(`n${i}`, "x".repeat(IMPORT_PART_BYTES / 3)));
    const progress: number[] = [];
    await saveImport("F1", nodes, (sent) => progress.push(sent));
    const asked = calls();
    expect(asked[0]).toMatchObject({ url: "/api/files/F1/imports", method: "POST" });
    const parts = asked.filter((c) => c.url === "/api/files/F1/imports/I1/parts");
    expect(parts.length).toBe(3);
    const sent = parts.flatMap(
      (p) => (JSON.parse(p.body as string) as { nodes: NodeRecord[] }).nodes,
    );
    expect(sent).toEqual(nodes);
    expect(asked.at(-1)).toMatchObject({ url: "/api/files/F1/imports/I1/commit", method: "POST" });
    expect(progress).toEqual([2, 4, 6]);
  });

  it("gives up the import when a part is refused, so nothing shows", async () => {
    const { fetch, calls } = server();
    fetch.mockImplementationOnce(
      async () => new Response(JSON.stringify({ importId: "I1" }), { status: 201 }),
    );
    fetch.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: "bad_request", message: "Bad value." } }), {
          status: 400,
        }),
    );
    await expect(saveImport("F1", [node("n1")])).rejects.toThrow("Bad value.");
    expect(calls().at(-1)).toMatchObject({ url: "/api/files/F1/imports/I1", method: "DELETE" });
  });

  it("refuses, before sending, more layers than a file holds", async () => {
    const { fetch } = server();
    const one = node("n1");
    const error = await saveImport("F1", Array(MAX_IMPORT_NODES + 1).fill(one)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportTooLarge);
    expect((error as ImportTooLarge).message).toBe(
      "This comes to 1,000,001 layers, more than one Drawpane file holds (1,000,000).",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(new ImportTooLarge(MAX_IMPORT_BYTES * 2, 10).fits).toBe(0.5);
    expect(new ImportTooLarge(10, MAX_IMPORT_NODES * 4).fits).toBe(0.25);
  });
});
