import type { Figma } from "@drawpane/figma";
import { describe, expect, it } from "vitest";
import { FigmaError, figmaError, figmaJson, type ReadProgress, readFigmaFile } from "./figma-read";

const node = (id: string, children?: Figma.Node[]): Figma.Node =>
  ({ id, name: `Layer ${id}`, type: children ? "FRAME" : "RECTANGLE", children }) as Figma.Node;
const page = (id: string, children: Figma.Node[]): Figma.Node =>
  ({ id, name: `Page ${id}`, type: "CANVAS", children }) as Figma.Node;

const FILE: Figma.File = {
  name: "Kit",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      page("0:1", [node("1:1", [node("1:2")]), node("1:3", [node("1:4")]), node("1:5")]),
      page("0:2", [node("2:1", [node("2:2")])]),
    ],
  } as Figma.Node,
  components: { "1:1": { name: "Button" } },
};

const tooLarge = () => new FigmaError("too large", 400, "Request too large");

/** Figma's API over FILE, refusing whatever `refuse` says is too large. */
function fakeFigma(refuse: (ids: readonly string[] | "file") => boolean) {
  const paths: string[] = [];
  const all = new Map<string, Figma.Node>();
  const walk = (n: Figma.Node) => {
    all.set(n.id, n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(FILE.document);
  const get = async (path: string): Promise<unknown> => {
    paths.push(path);
    if (path === "files/KEY?geometry=paths") {
      if (refuse("file")) throw tooLarge();
      return FILE;
    }
    if (path === "files/KEY?depth=2") {
      const cut = (n: Figma.Node, depth: number): Figma.Node => {
        const { children, ...rest } = n;
        return depth < 2 && children
          ? { ...rest, children: children.map((c) => cut(c, depth + 1)) }
          : rest;
      };
      return { ...FILE, components: {}, document: cut(FILE.document, 0) };
    }
    const ids = decodeURIComponent(/ids=([^&]+)/.exec(path)?.[1] ?? "").split(",");
    if (refuse(ids)) throw tooLarge();
    return {
      nodes: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            document: all.get(id),
            components: id === "1:1" || id === "0:1" ? FILE.components : {},
          },
        ]),
      ),
    };
  };
  return { get, paths };
}

const noWait = async () => undefined;

describe("reading a Figma file", () => {
  it("reads it in one request when Figma can send it", async () => {
    const figma = fakeFigma(() => false);
    expect(await readFigmaFile("KEY", figma.get, undefined, noWait)).toBe(FILE);
    expect(figma.paths).toEqual(["files/KEY?geometry=paths"]);
  });

  it("reads a file too large to send at once page by page, and puts it back together", async () => {
    const figma = fakeFigma((ids) => ids === "file");
    const file = await readFigmaFile("KEY", figma.get, undefined, noWait);
    expect(file.document).toEqual(FILE.document);
    expect(file.components).toEqual(FILE.components);
    expect(figma.paths).toEqual([
      "files/KEY?geometry=paths",
      "files/KEY?depth=2",
      "files/KEY/nodes?ids=0%3A1&geometry=paths",
      "files/KEY/nodes?ids=0%3A2&geometry=paths",
    ]);
  });

  it("splits a page that's still too large into its layers, keeping their order", async () => {
    // Page 1 is too large, and so is any part with more than one of its layers.
    const figma = fakeFigma(
      (ids) =>
        ids === "file" ||
        ids.includes("0:1") ||
        (ids.length > 1 && ids[0]?.startsWith("1:") === true),
    );
    const progress: ReadProgress[] = [];
    const file = await readFigmaFile("KEY", figma.get, (p) => progress.push(p), noWait);
    expect(file.document).toEqual(FILE.document);
    expect(file.components).toEqual(FILE.components);
    expect(figma.paths.slice(2)).toEqual([
      "files/KEY/nodes?ids=0%3A1&geometry=paths",
      "files/KEY/nodes?ids=1%3A1,1%3A3&geometry=paths",
      "files/KEY/nodes?ids=1%3A1&geometry=paths",
      "files/KEY/nodes?ids=1%3A3&geometry=paths",
      "files/KEY/nodes?ids=1%3A5&geometry=paths",
      "files/KEY/nodes?ids=0%3A2&geometry=paths",
    ]);
    const last = progress.at(-1) as ReadProgress;
    expect(last.done).toBe(last.total);
  });

  it("says which layer Figma can't send even on its own", async () => {
    const figma = fakeFigma((ids) => ids === "file" || ids.includes("0:1") || ids.includes("1:3"));
    await expect(readFigmaFile("KEY", figma.get, undefined, noWait)).rejects.toThrow(
      '"Layer 1:3" is too large for Figma to send through its API, even on its own.',
    );
  });

  it("sits out a short wait Figma asks for, and fails on a long one", async () => {
    let calls = 0;
    const waited: number[] = [];
    const busy = (seconds: number) => {
      const error = new FigmaError("limit", 429);
      error.retryAfter = seconds;
      return error;
    };
    const file = await readFigmaFile(
      "KEY",
      async () => {
        if (calls++ === 0) throw busy(3);
        return FILE;
      },
      undefined,
      async (s) => {
        waited.push(s);
      },
    );
    expect(file).toBe(FILE);
    expect(waited).toEqual([1, 1, 1]);
    await expect(
      readFigmaFile(
        "KEY",
        async () => {
          throw busy(86_400);
        },
        undefined,
        noWait,
      ),
    ).rejects.toThrow("limit");
  });
});

describe("a file too large for one Drawpane file", () => {
  // FILE has 7 layers: 5 on its first page, 2 on its second.
  it("says so when Figma sends it whole", async () => {
    const figma = fakeFigma(() => false);
    await expect(readFigmaFile("KEY", figma.get, undefined, noWait, 6)).rejects.toThrow(
      "more than 6 layers, more than one Drawpane file holds",
    );
    expect(await readFigmaFile("KEY", figma.get, undefined, noWait, 7)).toBe(FILE);
  });

  it("stops reading it in parts as soon as it's known to be, saving Figma's limits", async () => {
    const figma = fakeFigma((ids) => ids === "file");
    await expect(readFigmaFile("KEY", figma.get, undefined, noWait, 4)).rejects.toThrow(
      "drop the .fig file here to choose which pages to import",
    );
    expect(figma.paths).not.toContain("files/KEY/nodes?ids=0%3A2&geometry=paths");
  });

  it("counts a page read in parts by its layers", async () => {
    const figma = fakeFigma((ids) => ids === "file" || ids.includes("0:1"));
    await expect(readFigmaFile("KEY", figma.get, undefined, noWait, 6)).rejects.toThrow(
      "more than 6 layers",
    );
    const again = fakeFigma((ids) => ids === "file" || ids.includes("0:1"));
    const file = await readFigmaFile("KEY", again.get, undefined, noWait, 7);
    expect(file.document).toEqual(FILE.document);
  });
});

describe("Figma's refusals", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it("passes on Figma's own reason", async () => {
    const error = await figmaError(
      response(400, { status: 400, err: "File type not supported by this endpoint" }),
    );
    expect(error.message).toBe(
      "Figma couldn't send the file: File type not supported by this endpoint.",
    );
    expect(error.tooLarge).toBe(false);
  });

  it("knows a file too large to send", async () => {
    const error = await figmaError(response(400, { status: 400, err: "Request too large" }));
    expect(error.tooLarge).toBe(true);
  });

  it("keeps the wait Figma names on a rate limit", async () => {
    const error = await figmaError(response(429, {}, { "Retry-After": "30" }));
    expect(error.retryAfter).toBe(30);
    expect(error.message).toMatch(/Try again in 30 seconds\.$/);
    const later = await figmaError(response(429, {}, { "Retry-After": String(4 * 86400) }));
    expect(later.message).toMatch(/Try again in about 4 days\.$/);
  });
});

describe("Figma's replies", () => {
  /** A reply streamed in chunks, as a large one arrives. */
  const streamed = (chunks: readonly string[], cut = false) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulled++];
        if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
        else if (cut) controller.error(new TypeError("network error"));
        else controller.close();
      },
    });
    return { response: new Response(body), pulled: () => pulled };
  };

  it("reads a reply that arrives in pieces", async () => {
    const { response } = streamed(['{"name":', '"Kit",', '"version":"1"}']);
    expect(await figmaJson(response)).toEqual({ name: "Kit", version: "1" });
  });

  it("lets go of a reply too large to parse, as soon as it's known to be, so it's read in parts", async () => {
    const reply = streamed(['{"a":"', "x".repeat(60), "y".repeat(60), '"}']);
    const error = await figmaJson(reply.response, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FigmaError);
    expect((error as FigmaError).tooLarge).toBe(true);
    expect(reply.pulled()).toBeLessThan(4);
  });

  it("knows a reply too large from its declared length, before reading any of it", async () => {
    const response = new Response("{}", { headers: { "Content-Length": "1000" } });
    await expect(figmaJson(response, 100)).rejects.toMatchObject({ tooLarge: true });
  });

  it("says when a reply was cut short", async () => {
    await expect(figmaJson(streamed(['{"name":'], true).response)).rejects.toThrow(
      "The connection to Figma dropped",
    );
    await expect(figmaJson(new Response('{"name":'))).rejects.toThrow("cut short");
  });

  it("reads a file Figma sends but the browser can't parse whole, page by page", async () => {
    const figma = fakeFigma(() => false);
    let first = true;
    const file = await readFigmaFile(
      "KEY",
      async (path) => {
        if (first) {
          first = false;
          throw new FigmaError("too large to read", 200, null, true);
        }
        return figma.get(path);
      },
      undefined,
      noWait,
    );
    expect(file.document).toEqual(FILE.document);
    expect(figma.paths[0]).toBe("files/KEY?depth=2");
  });
});
