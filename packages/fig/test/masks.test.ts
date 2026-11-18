/**
 * Masks as Figma saves them, through the whole import (`openFig`, `read`,
 * `convertFile`, `pinInstances`). A mask masks the siblings above it up to
 * the next mask, the end of its parent, or a frame that clips its content
 * (Figma's help: "The mask applies to all siblings above it until it
 * reaches … a frame or component with clip content on"). Any layer can be a
 * mask: a shape, a group, a text.
 *
 * Each case is records added to a committed sample (Open Pencil's
 * `patchFigArchive`), saved the way Figma saves them.
 */
import { readFileSync } from "node:fs";
import { Doc, maskScopes, pinInstances } from "@drawpane/editor";
import { convertFile, drawpaneId } from "@drawpane/figma";
import { getProp, type NodeRecord, type Op } from "@drawpane/model";
import { parseFigBuffer, patchFigArchive } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { beforeAll, describe, expect, it } from "vitest";
import { openFig } from "../src";

const guid = (localID: number) => ({ sessionID: 900, localID });
const id = (localID: number) => `900:${localID}`;
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r: number, g: number, b: number) => ({
  type: "SOLID",
  color: { r, g, b, a: 1 },
  opacity: 1,
  visible: true,
  blendMode: "NORMAL",
});

function layer(
  localID: number,
  parent: { sessionID: number; localID: number },
  position: string,
  type: string,
  fields: Record<string, unknown> & { size: { x: number; y: number } },
): NodeChange {
  return {
    guid: guid(localID),
    phase: "CREATED",
    parentIndex: { guid: parent, position },
    type,
    name: `${type} ${localID}`,
    visible: true,
    opacity: 1,
    transform: at(0, 0),
    strokeWeight: 0,
    strokeAlign: "INSIDE",
    strokeJoin: "MITER",
    fillPaints: [],
    ...fields,
  } as unknown as NodeChange;
}

const PAGE = guid(1);

const records: NodeChange[] = [
  {
    guid: PAGE,
    phase: "CREATED",
    parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "~~~" },
    type: "CANVAS",
    name: "Masks",
    visible: true,
    opacity: 1,
  } as unknown as NodeChange,

  // A popover, as a large iOS UI kit draws one: its arrow (mirrored) masks the material
  // group above it, and the clipping background above that ends the mask.
  layer(10, PAGE, "!", "SYMBOL", { size: { x: 200, y: 200 }, frameMaskDisabled: true }),
  layer(11, guid(10), " }", "RECTANGLE", {
    name: "Arrow",
    size: { x: 56, y: 13 },
    transform: { m00: -1, m01: 0, m02: 128, m10: 0, m11: 1, m12: 200 },
    mask: true,
    fillPaints: [solid(1, 0, 0)],
  }),
  layer(12, guid(10), " ~", "FRAME", {
    name: "Material",
    size: { x: 56, y: 13 },
    // Turned half a turn about its corner, which lands on the arrow's box.
    transform: { m00: -1, m01: 0, m02: 128, m10: 0, m11: -1, m12: 213 },
    resizeToFit: true,
    frameMaskDisabled: false,
  }),
  layer(13, guid(12), "!", "RECTANGLE", { size: { x: 56, y: 13 }, fillPaints: [solid(0, 0, 1)] }),
  layer(14, guid(10), "!", "FRAME", {
    name: "Background",
    size: { x: 200, y: 200 },
    frameMaskDisabled: false,
    fillPaints: [solid(1, 1, 1)],
  }),
  // A layer above the background: the mask ended at the background, so it isn't masked either.
  layer(15, guid(10), '"', "RECTANGLE", {
    name: "Badge",
    size: { x: 10, y: 10 },
    fillPaints: [solid(0, 1, 0)],
  }),
  // A copy of it, and a copy that hides its arrow: a hidden mask masks nothing.
  layer(20, PAGE, '"', "INSTANCE", {
    size: { x: 200, y: 200 },
    transform: at(300, 0),
    frameMaskDisabled: true,
    symbolData: { symbolID: guid(10), symbolOverrides: [], uniformScaleFactor: 1 },
  }),
  layer(21, PAGE, "#", "INSTANCE", {
    size: { x: 200, y: 200 },
    transform: at(600, 0),
    frameMaskDisabled: true,
    symbolData: {
      symbolID: guid(10),
      symbolOverrides: [{ guidPath: { guids: [guid(11)] }, visible: false }],
      uniformScaleFactor: 1,
    },
  }),

  // An icon masked by a group's luminance, as icon sets export them: white shows, black hides.
  layer(30, PAGE, "$", "FRAME", {
    name: "Mask group",
    size: { x: 20, y: 20 },
    transform: at(0, 300),
    resizeToFit: true,
  }),
  layer(31, guid(30), "!", "FRAME", {
    name: "Group",
    size: { x: 20, y: 20 },
    resizeToFit: true,
    mask: true,
    maskType: "LUMINANCE",
  }),
  layer(32, guid(31), "!", "RECTANGLE", { size: { x: 20, y: 20 }, fillPaints: [solid(1, 1, 1)] }),
  layer(33, guid(31), '"', "RECTANGLE", {
    size: { x: 10, y: 10 },
    transform: at(5, 5),
    fillPaints: [solid(0, 0, 0)],
  }),
  layer(34, guid(30), '"', "RECTANGLE", { size: { x: 20, y: 20 }, fillPaints: [solid(0, 0, 0)] }),

  // A tint masked by a text (a symbol glyph in the kit), by the text's alpha.
  layer(40, PAGE, "%", "FRAME", { size: { x: 40, y: 20 }, transform: at(0, 400) }),
  layer(41, guid(40), "!", "TEXT", {
    size: { x: 40, y: 20 },
    mask: true,
    fontSize: 14,
    fontName: { family: "Inter", style: "Regular", postscript: "Inter-Regular" },
    lineHeight: { value: 20, units: "PIXELS" },
    letterSpacing: { value: 0, units: "PERCENT" },
    textData: { characters: "Hi" },
    textAutoResize: "WIDTH_AND_HEIGHT",
    fillPaints: [solid(0, 0, 0)],
  }),
  layer(42, guid(40), '"', "RECTANGLE", {
    size: { x: 40, y: 20 },
    fillPaints: [solid(0, 0.5, 1)],
  }),

  // A mask with nothing above it, alone in its frame. A .fig says "OUTLINE" where Figma's
  // REST API and plugins say "VECTOR".
  layer(50, PAGE, "&", "FRAME", { size: { x: 20, y: 20 }, transform: at(0, 500) }),
  layer(51, guid(50), "!", "ELLIPSE", {
    size: { x: 20, y: 20 },
    mask: true,
    maskType: "OUTLINE",
    fillPaints: [solid(0, 0, 0)],
  }),
];

let nodes: NodeRecord[];
let notes: string[];
let doc: Doc;
const node = (figmaId: string): NodeRecord => {
  const n = nodes.find((n) => n.id === drawpaneId(figmaId));
  if (!n) throw new Error(`no ${figmaId}`);
  return n;
};
/** Each child of a layer, by Figma id, with the mask that masks it (or "mask" for a mask). */
const scopes = (figmaId: string) =>
  maskScopes(doc, drawpaneId(figmaId)).map((s) => [
    nodes.find((n) => n.id === s.id)?.props.name,
    s.isMask ? "mask" : ((s.mask?.props.name as string | undefined) ?? null),
  ]);

beforeAll(async () => {
  const sample = new Uint8Array(readFileSync(new URL("./fixtures/pattern.fig", import.meta.url)));
  const parsed = parseFigBuffer(sample.slice().buffer as ArrayBuffer);
  const bytes = patchFigArchive(
    sample.slice().buffer as ArrayBuffer,
    { records, fields: [], blobs: [], removed: [], replaceVariables: false },
    {
      thumbnailPNG: parsed.thumbnailPNG ?? new Uint8Array(),
      metaJSON: parsed.metaJSON ?? "{}",
      images: [],
    },
  );
  const fig = await openFig(bytes);
  const read = await fig.read({ pageIds: [id(1)] });
  const converted = convertFile(read.file);
  notes = converted.notes.entries().map(([kind]) => kind);
  nodes = pinInstances(converted.nodes).nodes;
  doc = new Doc({ compactCopies: false });
  doc.apply(
    nodes.map(
      (n) =>
        ({
          op: "create",
          id: n.id,
          type: n.type,
          parent: n.parent,
          key: n.key,
          props: n.props,
        }) as Op,
    ),
  );
}, 60_000);

describe("masks from a .fig", () => {
  it("end at a frame that clips its content, as Figma's do", () => {
    expect(getProp(node(id(11)).props, "isMask")).toBe(true);
    expect(getProp(node(id(11)).props, "maskType")).toBe("alpha");
    expect(scopes(id(10))).toEqual([
      ["Arrow", "mask"],
      ["Material", "Arrow"],
      ["Background", null],
      ["Badge", null],
    ]);
  });

  it("scope the same in a copy", () => {
    expect(scopes(id(20))).toEqual([
      ["Arrow", "mask"],
      ["Material", "Arrow"],
      ["Background", null],
      ["Badge", null],
    ]);
  });

  it("mask nothing when a copy hides them", () => {
    expect(node(`I${id(21)};${id(11)}`).props.visible).toBe(false);
    expect(scopes(id(21))).toEqual([
      ["Arrow", null],
      ["Material", null],
      ["Background", null],
      ["Badge", null],
    ]);
  });

  it("keep a group as a mask, with its kind", () => {
    const group = node(id(31));
    expect(group.type).toBe("group");
    expect(getProp(group.props, "isMask")).toBe(true);
    expect(getProp(group.props, "maskType")).toBe("luminance");
    expect(scopes(id(30))).toEqual([
      ["Group", "mask"],
      ["RECTANGLE 34", "Group"],
    ]);
  });

  it("keep a text as a mask", () => {
    const label = node(id(41));
    expect(label.type).toBe("text");
    expect(getProp(label.props, "isMask")).toBe(true);
    expect(getProp(label.props, "maskType")).toBe("alpha");
    expect(scopes(id(40))).toEqual([
      ["TEXT 41", "mask"],
      ["RECTANGLE 42", "TEXT 41"],
    ]);
  });

  it("keep a mask that's the only layer in its frame, masking nothing", () => {
    expect(getProp(node(id(51)).props, "isMask")).toBe(true);
    expect(getProp(node(id(51)).props, "maskType")).toBe("outline");
    expect(scopes(id(50))).toEqual([["ELLIPSE 51", "mask"]]);
  });

  it("note no mask the import couldn't keep", () => {
    expect(notes).not.toContain("mask-kind");
  });
});
