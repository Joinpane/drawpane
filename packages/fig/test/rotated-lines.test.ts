/**
 * A vertical separator as design systems draw one: a horizontal line turned
 * 90 degrees, in an auto layout row that hugs it, stretched to the row's
 * height. Figma saves the line's transform (turned about its start), and
 * lays it out by the box it takes up turned: 0 wide and as tall as the row.
 *
 * Made by adding records to a committed sample (`pattern.fig`).
 */
import { readFileSync } from "node:fs";
import type { Figma } from "@drawpane/figma";
import { convertFile } from "@drawpane/figma";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { describe, expect, it } from "vitest";
import { readFig } from "../src";

const bytes = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));
const guid = (localID: number, sessionID = 900) => ({ sessionID, localID });
const key = (g: { sessionID: number; localID: number }) => `${g.sessionID}:${g.localID}`;

function fixture() {
  const parsed = parseFigBuffer(bytes.slice().buffer as ArrayBuffer);
  const page = parsed.nodeChanges.find((r) => r.type === "CANVAS" && !r.internalOnly)?.guid;
  if (!page) throw new Error("the sample changed");
  const row = guid(1);
  const line = guid(2);
  const records = [
    {
      guid: row,
      phase: "CREATED",
      parentIndex: { guid: page, position: "~z" },
      type: "FRAME",
      name: "Separator",
      visible: true,
      opacity: 1,
      size: { x: 0, y: 20 },
      transform: { m00: 1, m01: 0, m02: 3000, m10: 0, m11: 1, m12: 3000 },
      stackMode: "HORIZONTAL",
      stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",
      stackCounterAlignItems: "CENTER",
      stackSpacing: 10,
      bordersTakeSpace: true,
      fillPaints: [],
    },
    {
      guid: line,
      phase: "CREATED",
      parentIndex: { guid: row, position: "!" },
      type: "LINE",
      name: "Line",
      visible: true,
      opacity: 1,
      size: { x: 20, y: 0 },
      // Turned 90 degrees about its start, which stays at the row's corner.
      transform: { m00: 0, m01: -1, m02: 0, m10: 1, m11: 0, m12: 0 },
      strokeWeight: 1,
      strokeAlign: "CENTER",
      strokePaints: [
        { type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 }, opacity: 1, visible: true },
      ],
      stackChildAlignSelf: "STRETCH",
    },
  ] as unknown as NodeChange[];
  const saved = patchFigArchive(
    bytes.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  return { bytes: saved, row: key(row), line: key(line) };
}

function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

describe("rotated lines", { timeout: 60_000 }, () => {
  it("stay where Figma put them", async () => {
    const f = fixture();
    const fig = await readFig(f.bytes);
    const line = [...walk(fig.file.document)].find((n) => n.id === f.line);
    // From the row's corner straight down, as Figma has it.
    expect(line?.absoluteBoundingBox).toEqual({ x: 3000, y: 3000, width: 0, height: 20 });
    const [[, , tx], [, , ty]] = line?.relativeTransform ?? [[], []];
    expect([tx, ty].map((v) => Math.round((v ?? Number.NaN) * 1000) / 1000 + 0)).toEqual([0, 0]);
    // Drawpane turns the 20 x 0 box about its centre, which is (0, 10) in the row.
    const { nodes } = convertFile(fig.file);
    const converted = nodes.find((n) => n.props.name === "Line");
    expect(converted?.props).toMatchObject({ x: -10, y: 10, width: 20, height: 0, rotation: 90 });
    expect(nodes.find((n) => n.props.name === "Separator")?.props.strokesIncludedInLayout).toBe(
      true,
    );
  });
});
