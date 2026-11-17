import { type NodeRecord, parseSnapshot, snapshotHeaderLine } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readSnapshotStream } from "./snapshot-stream";

const node = (i: number, name = `Layer ${i}`): NodeRecord => ({
  id: `n${i}`,
  parent: "root",
  key: `a${i}`,
  type: "frame",
  props: { name },
});

/** `text` as a stream of UTF-8 bytes, cut at `cuts` (byte offsets, any order). */
function streamOf(text: string, cuts: readonly number[] = []): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const at = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const cut of [...at, bytes.length]) {
    parts.push(bytes.subarray(from, cut));
    from = cut;
  }
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const v2 = (nodes: readonly NodeRecord[], revn = 7) =>
  snapshotHeaderLine("file1", revn, 1) + nodes.map((n) => `${JSON.stringify(n)}\n`).join("");

describe("readSnapshotStream", () => {
  it("reads a version 2 snapshot however its bytes are cut, as parseSnapshot reads it whole", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Names with multi-byte characters, so cuts land inside them, and newlines escaped in JSON.
        fc.array(fc.string({ unit: "grapheme", maxLength: 12 }), { maxLength: 30 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.boolean(),
        async (names, cuts, trailingNewline) => {
          let text = v2(names.map((name, i) => node(i, name)));
          if (!trailingNewline) text = text.replace(/\n$/, "");
          const read = await readSnapshotStream(streamOf(text, cuts));
          // parseSnapshot needs a newline after the header; the stream doesn't.
          expect(read).toEqual(parseSnapshot(`${text}\n`));
          expect(read?.nodes).toHaveLength(names.length);
          expect(read?.header.revn).toBe(7);
        },
      ),
    );
  });

  it("reads a version 1 snapshot whole", async () => {
    const nodes = [node(1), node(2)];
    const text = JSON.stringify({
      format: "drawpane.snapshot",
      version: 1,
      fileId: "file1",
      revn: 3,
      at: 1,
      nodes,
    });
    const read = await readSnapshotStream(streamOf(text, [5, 40, 41]));
    expect(read?.header).toMatchObject({ version: 1, revn: 3 });
    expect(read?.nodes).toEqual(nodes);
  });

  it("says null for what isn't a snapshot", async () => {
    expect(await readSnapshotStream(streamOf(""))).toBeNull();
    expect(await readSnapshotStream(streamOf('{"hello":1}\n{"id":"x"}\n', [3]))).toBeNull();
    expect(await readSnapshotStream(streamOf("not json at all"))).toBeNull();
  });

  it("reads a header with no nodes", async () => {
    const read = await readSnapshotStream(streamOf(snapshotHeaderLine("file1", 0, 1)));
    expect(read).toEqual({ header: expect.objectContaining({ revn: 0 }), nodes: [] });
  });
});
