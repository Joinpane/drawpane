import { readFileSync } from "node:fs";
import { Doc, Scene } from "@drawpane/editor";
import {
  applyTransaction,
  getProp,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
} from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { convertFile, imagesOf, readPenpot } from "../src";
import type { PenpotFile } from "../src/read";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Creates the nodes in a store the way the room does, parents first: throws on anything invalid. */
function validate(nodes: readonly NodeRecord[]): MemoryStore {
  const store = new MemoryStore([]);
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let n = queue.shift(); n; n = queue.shift()) {
    ops.push({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    });
    queue.push(...(byParent.get(n.id) ?? []));
  }
  expect(ops).toHaveLength(nodes.length);
  applyTransaction(store, ops, { rollback: false });
  return store;
}

function scene(nodes: readonly NodeRecord[]): Scene {
  const doc = new Doc();
  doc.reset(nodes);
  return new Scene(doc);
}

const noMedia = () => undefined;

describe("converting a Penpot file", () => {
  it("produces nodes the document model accepts, for every file in the samples", async () => {
    for (const name of ["file-with-library.penpot", "svg-attrs-camel-case.penpot"]) {
      const exp = await readPenpot(fixture(name));
      for (const file of exp.files) {
        const { nodes } = convertFile(file, noMedia);
        expect(nodes.some((n) => n.type === "page")).toBe(true);
        validate(nodes);
      }
    }
  });

  it("puts every shape where Penpot had it, rotated groups included", async () => {
    const exp = await readPenpot(fixture("svg-attrs-camel-case.penpot"));
    const file = exp.files[0] as PenpotFile;
    const { nodes } = convertFile(file, noMedia);
    const s = scene(nodes);
    let checked = 0;
    for (const page of file.pages)
      for (const shape of page.shapes.values()) {
        if (shape.id.startsWith("00000000") || !s.doc.has(shape.id)) continue;
        if (shape.type === "group") continue;
        if (shape.type === "path" || shape.type === "bool") {
          // Paths: the same bounds as Penpot's box for them.
          const sel = shape.selrect as { x: number; y: number; width: number; height: number };
          const b = s.bounds(shape.id);
          expect(b?.x).toBeCloseTo(sel.x, 0);
          expect(b?.y).toBeCloseTo(sel.y, 0);
          expect(b?.width).toBeCloseTo(sel.width, 0);
          expect(b?.height).toBeCloseTo(sel.height, 0);
        } else {
          // Boxes: the same four corners, in the same order.
          const corners = s.corners(shape.id) ?? [];
          const points = shape.points as Array<{ x: number; y: number }>;
          corners.forEach((c, i) => {
            expect(c.x).toBeCloseTo(points[i]?.x ?? Number.NaN, 1);
            expect(c.y).toBeCloseTo(points[i]?.y ?? Number.NaN, 1);
          });
        }
        checked++;
      }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps components in their library file, and detaches copies of them elsewhere", async () => {
    const exp = await readPenpot(fixture("file-with-library.penpot"));
    const library = exp.files.find((f) => f.components.size > 0) as PenpotFile;
    const user = exp.files.find((f) => f !== library) as PenpotFile;
    const lib = convertFile(library, noMedia);
    const mains = lib.nodes.filter((n) => getProp(n.props, "isComponent"));
    expect(mains).toHaveLength(library.components.size);
    const used = convertFile(user, noMedia);
    expect(used.nodes.some((n) => getProp(n.props, "instanceOf"))).toBe(false);
    expect(used.notes.lines().join()).toMatch(/detached/);
    validate(used.nodes);
  });

  it("lists the images a file uses", async () => {
    const exp = await readPenpot(fixture("svg-attrs-camel-case.penpot"));
    // This sample's images are all thumbnails, which aren't the file's own images.
    expect(imagesOf(exp, exp.files[0] as PenpotFile)).toEqual([]);
  });
});

/** A one-page Penpot file built from shapes, for focused cases. */
function fileOf(
  shapes: Array<Record<string, unknown>>,
  extra: Partial<PenpotFile> = {},
): PenpotFile {
  const root = {
    id: "00000000-0000-0000-0000-000000000000",
    type: "frame",
    shapes: shapes
      .filter((s) => s.parentId === "00000000-0000-0000-0000-000000000000")
      .map((s) => s.id),
  };
  return {
    id: "f",
    name: "Test",
    record: { id: "f" },
    pages: [
      {
        record: { id: "p1", name: "Page 1", index: 0 },
        shapes: new Map([root, ...shapes].map((s) => [s.id as string, s as never])),
      },
    ],
    components: new Map(),
    media: new Map(),
    colors: new Map(),
    typographies: new Map(),
    hasTokens: false,
    ...extra,
  };
}

const ROOT = "00000000-0000-0000-0000-000000000000";
const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  selrect: { x, y, width, height },
  transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
});

describe("converting shapes", () => {
  it("places children relative to their board, which keeps its own box", () => {
    const { nodes } = convertFile(
      fileOf([
        {
          id: "board",
          type: "frame",
          name: "Card",
          parentId: ROOT,
          shapes: ["r"],
          ...box(100, 50, 300, 200),
          fills: [{ fillColor: "#FFFFFF", fillOpacity: 1 }],
        },
        {
          id: "r",
          type: "rect",
          parentId: "board",
          ...box(120, 70, 40, 20),
          r1: 4,
          r2: 4,
          r3: 4,
          r4: 4,
          fills: [{ fillColor: "#E8590C", fillOpacity: 0.5 }],
        },
      ]),
      noMedia,
    );
    const board = nodes.find((n) => n.id === "board") as NodeRecord;
    const rect = nodes.find((n) => n.id === "r") as NodeRecord;
    expect(board.props).toMatchObject({ x: 100, y: 50, width: 300, height: 200 });
    expect(rect.props).toMatchObject({ x: 20, y: 20, width: 40, height: 20, cornerRadius: 4 });
    expect(rect.props.fills).toEqual([{ type: "solid", color: "#e8590c80" }]);
    validate(nodes);
  });

  it("turns flex layout into auto layout, keeping the flow order", () => {
    const { nodes } = convertFile(
      fileOf([
        {
          id: "row",
          type: "frame",
          parentId: ROOT,
          shapes: ["a", "b"],
          ...box(0, 0, 200, 40),
          layout: "flex",
          layoutFlexDir: "row",
          layoutGap: { rowGap: 4, columnGap: 12 },
          layoutPadding: { p1: 8, p2: 16 },
          layoutPaddingType: "simple",
          layoutAlignItems: "center",
        },
        {
          id: "a",
          type: "rect",
          parentId: "row",
          ...box(16, 8, 20, 20),
          layoutItemHSizing: "fill",
        },
        { id: "b", type: "rect", parentId: "row", ...box(48, 8, 20, 20) },
      ]),
      noMedia,
    );
    const row = nodes.find((n) => n.id === "row") as NodeRecord;
    expect(row.props).toMatchObject({
      layoutMode: "row",
      gap: 12,
      paddingTop: 8,
      paddingRight: 16,
      paddingBottom: 8,
      paddingLeft: 16,
      alignItems: "center",
    });
    // Penpot flows the topmost layer ("b") first; Drawpane flows in layer order.
    const kids = nodes.filter((n) => n.parent === "row").sort((x, y) => (x.key < y.key ? -1 : 1));
    expect(kids.map((n) => n.id)).toEqual(["b", "a"]);
    expect((nodes.find((n) => n.id === "a") as NodeRecord).props.sizingH).toBe("fill");
  });

  it("keeps a group's own size in an auto layout, where Drawpane groups have no sizing", () => {
    const { nodes, notes } = convertFile(
      fileOf([
        {
          id: "row",
          type: "frame",
          parentId: ROOT,
          shapes: ["g"],
          ...box(0, 0, 200, 40),
          layout: "flex",
          layoutFlexDir: "row",
        },
        {
          id: "g",
          type: "group",
          parentId: "row",
          shapes: ["r"],
          ...box(0, 0, 200, 40),
          layoutItemHSizing: "fill",
          layoutItemVSizing: "auto",
          layoutItemMinW: 50,
          layoutItemAlignSelf: "center",
        },
        { id: "r", type: "rect", parentId: "g", ...box(0, 0, 200, 40) },
      ]),
      noMedia,
    );
    const group = nodes.find((n) => n.id === "g") as NodeRecord;
    expect(group.props).not.toHaveProperty("sizingH");
    expect(group.props).not.toHaveProperty("sizingV");
    expect(group.props).not.toHaveProperty("minWidth");
    expect(group.props.alignSelf).toBe("center");
    expect(notes.lines()).toEqual(["1 group set to Fill in an auto layout keeps its own size"]);
    validate(nodes);
  });

  it("draws dotted borders as dots, square where Drawpane has no caps", () => {
    const dotted = {
      strokeStyle: "dotted",
      strokeWidth: 2,
      strokeColor: "#000000",
      strokeOpacity: 1,
    };
    const { nodes, notes } = convertFile(
      fileOf([
        { id: "r", type: "rect", parentId: ROOT, ...box(0, 0, 40, 40), strokes: [dotted] },
        {
          id: "b",
          type: "frame",
          parentId: ROOT,
          shapes: [],
          ...box(50, 0, 40, 40),
          strokes: [dotted],
        },
      ]),
      noMedia,
    );
    for (const id of ["r", "b"]) {
      const node = nodes.find((n) => n.id === id) as NodeRecord;
      expect(node.props.strokeDashes).toEqual([2, 5]);
      expect(node.props).not.toHaveProperty("strokeCap");
    }
    expect(notes.lines()).toEqual(["2 dotted borders' round dots became square"]);
    validate(nodes);
  });

  it("turns rich text into characters, a base style and runs", () => {
    const leaf = (text: string, extra: Record<string, unknown> = {}) => ({
      text,
      fontFamily: '"Inter"',
      fontId: "gfont-inter",
      fontSize: "16",
      fontWeight: "400",
      fills: [{ fillColor: "#1C1B1A", fillOpacity: 1 }],
      ...extra,
    });
    const { nodes } = convertFile(
      fileOf([
        {
          id: "t",
          type: "text",
          parentId: ROOT,
          ...box(0, 0, 200, 50),
          growType: "auto-height",
          content: {
            type: "root",
            verticalAlign: "center",
            children: [
              {
                type: "paragraph-set",
                children: [
                  {
                    type: "paragraph",
                    textAlign: "center",
                    lineHeight: "1.5",
                    children: [
                      leaf("Plan "),
                      leaf("your", { fontWeight: "700", fills: [{ fillColor: "#E8590C" }] }),
                      leaf(" week"),
                    ],
                  },
                  { type: "paragraph", children: [leaf("Today", { textTransform: "uppercase" })] },
                ],
              },
            ],
          },
        },
      ]),
      noMedia,
    );
    const text = nodes.find((n) => n.id === "t") as NodeRecord;
    expect(text.props).toMatchObject({
      characters: "Plan your week\nToday",
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: { unit: "percent", value: 150 },
      textAlign: "center",
      textAlignVertical: "middle",
      textAutoResize: "height",
      fills: [{ type: "solid", color: "#1c1b1a" }],
      textRuns: [
        { start: 5, end: 9, fontWeight: 700, fills: [{ type: "solid", color: "#e8590c" }] },
        { start: 15, end: 20, textCase: "upper" },
      ],
    });
    validate(nodes);
  });

  it("turns paths into local path data with an exact box, and booleans into paths", () => {
    const { nodes, notes } = convertFile(
      fileOf([
        {
          id: "board",
          type: "frame",
          parentId: ROOT,
          shapes: ["p", "u"],
          ...box(100, 100, 200, 200),
        },
        {
          id: "p",
          type: "path",
          parentId: "board",
          content: "M110,110L150,110L150,150ZZ",
          strokes: [{ strokeColor: "#000000", strokeWidth: 2, strokeAlignment: "center" }],
        },
        {
          id: "u",
          type: "bool",
          parentId: "board",
          boolType: "union",
          content: "M120,120C120,100,140,100,140,120Z",
          shapes: [],
        },
      ]),
      noMedia,
    );
    const path = nodes.find((n) => n.id === "p") as NodeRecord;
    expect(path.props).toMatchObject({
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      pathData: "M0 0 L40 0 L40 40 Z",
    });
    expect(path.props).toMatchObject({ strokeWeight: 2, strokeAlign: "center" });
    // The curve's top is at y=105, not at its control points' 100.
    expect((nodes.find((n) => n.id === "u") as NodeRecord).props).toMatchObject({
      y: 5,
      height: 15,
    });
    expect(notes.lines()).toContain("1 boolean group became a path");
    validate(nodes);
  });

  it("brings the library's colours and text styles, tying layers to them", () => {
    const { nodes } = convertFile(
      fileOf(
        [
          {
            id: "r",
            type: "rect",
            parentId: ROOT,
            ...box(0, 0, 10, 10),
            fills: [
              { fillColor: "#007CA5", fillOpacity: 1, fillColorRefId: "c1", fillColorRefFile: "f" },
            ],
          },
        ],
        {
          colors: new Map([
            ["c1", { id: "c1", name: "Primary", path: "Brand", color: "#007ca5", opacity: 1 }],
          ]),
          typographies: new Map([
            [
              "t1",
              {
                id: "t1",
                name: "Heading",
                path: "Titles",
                fontFamily: "Inter",
                fontSize: "32",
                fontWeight: "700",
                lineHeight: "1.2",
                letterSpacing: "0",
              },
            ],
          ]),
        },
      ),
      noMedia,
    );
    expect(nodes.find((n) => n.id === "c1")?.props).toMatchObject({
      name: "Brand/Primary",
      values: { m1: "#007ca5" },
    });
    expect(nodes.find((n) => n.id === "t1")?.props).toMatchObject({
      name: "Titles/Heading",
      fontSize: 32,
      fontWeight: 700,
    });
    expect(nodes.find((n) => n.id === "r")?.props.bindings).toEqual({ fill: "c1" });
    validate(nodes);
  });

  it("reuses an uploaded image for an image fill", () => {
    const { nodes } = convertFile(
      fileOf([
        {
          id: "r",
          type: "rect",
          parentId: ROOT,
          ...box(0, 0, 10, 10),
          fills: [
            {
              fillImage: {
                id: "m1",
                width: 10,
                height: 10,
                mtype: "image/png",
                keepAspectRatio: true,
              },
            },
          ],
        },
      ]),
      (id) => (id === "m1" ? "a".repeat(64) : undefined),
    );
    expect(nodes.find((n) => n.id === "r")?.props.fills).toEqual([
      { type: "image", ref: "a".repeat(64), scaleMode: "fill" },
    ]);
  });
});

describe("the showcase export", () => {
  it("converts every kind of layer and the library, with an honest summary", async () => {
    const exp = await readPenpot(fixture("showcase.penpot"));
    const file = exp.files[0] as PenpotFile;
    const images = imagesOf(exp, file);
    expect(images).toHaveLength(1);
    const { nodes, notes } = convertFile(file, (id) =>
      id === images[0]?.mediaId ? "b".repeat(64) : undefined,
    );
    validate(nodes);
    const named = (name: string) => nodes.filter((n) => n.props.name === name);
    expect(named("Card")[0]?.props).toMatchObject({
      layoutMode: "column",
      gap: 12,
      cornerRadius: 16,
    });
    expect(named("Photo")[0]?.props.fills).toEqual([
      { type: "image", ref: "b".repeat(64), scaleMode: "fill" },
    ]);
    expect(named("Heading")[0]?.props.textRuns).toEqual([
      { start: 10, end: 14, fills: [{ type: "solid", color: "#e8590c" }] },
    ]);
    expect(named("Tilted")[0]?.props.rotation).toBe(15);
    expect(named("Arrow")[0]?.props).toMatchObject({
      markerEnd: "triangle",
      strokeAlign: "center",
    });
    expect(named("Mask")[0]?.props.isMask).toBe(true);
    const [main, copy] = named("Button");
    expect(main?.props.isComponent).toBe(true);
    expect(copy?.props).toMatchObject({ instanceOf: main?.id, overrides: ["fills"] });
    expect(nodes.find((n) => n.type === "textStyle")?.props.name).toBe("Titles/Heading");
    expect(nodes.find((n) => n.type === "variable")?.props.name).toBe("Brand/Primary");
    expect(named("Focus")[0]?.props.bindings).toEqual({
      fill: nodes.find((n) => n.type === "variable")?.id,
    });
    expect(nodes.filter((n) => n.type === "page").map((n) => n.props.name)).toEqual([
      "Cover",
      "Done",
    ]);
    expect(named("Card")[0]?.props.reactions).toHaveLength(1);
    expect(notes.lines()).toEqual([]);
  });
});

describe("gaps the import used to drop", () => {
  it("brings an imported SVG's drawable content in, as a group", () => {
    const { nodes, notes } = convertFile(
      fileOf([
        {
          id: "svg",
          type: "svg-raw",
          parentId: ROOT,
          shapes: ["shape", "defs"],
          ...box(0, 0, 40, 40),
        },
        {
          id: "shape",
          type: "path",
          parentId: "svg",
          content: "M0,0L40,0L40,40Z",
          fills: [{ fillColor: "#ff0000", fillOpacity: 1 }],
        },
        {
          id: "defs",
          type: "svg-raw",
          parentId: "svg",
          content: { tag: "defs" },
          ...box(0, 0, 0, 0),
        },
      ]),
      noMedia,
    );
    expect(nodes.find((n) => n.id === "svg")?.type).toBe("group");
    expect(nodes.find((n) => n.id === "shape")?.parent).toBe("svg");
    expect(notes.lines()).toEqual(["1 raw SVG element wasn't imported"]);
    validate(nodes);
  });

  it("keeps an absolute child's constraints, a board's guides, and aspect locks", () => {
    const file = fileOf([
      {
        id: "board",
        type: "frame",
        parentId: ROOT,
        shapes: ["badge"],
        layout: "flex",
        layoutFlexDir: "row",
        ...box(100, 50, 300, 200),
      },
      {
        id: "badge",
        type: "rect",
        parentId: "board",
        layoutItemAbsolute: true,
        constraintsH: "right",
        constraintsV: "bottom",
        proportionLock: true,
        ...box(360, 210, 30, 30),
      },
    ]);
    // A guide on the board, at x = 150 on the page.
    (file.pages[0]?.record as Record<string, unknown>).guides = {
      g1: { id: "g1", axis: "x", position: 150, frameId: "board" },
    };
    const { nodes } = convertFile(file, noMedia);
    expect(nodes.find((n) => n.id === "badge")?.props).toMatchObject({
      positioning: "absolute",
      constraintH: "end",
      constraintV: "end",
      lockAspect: true,
    });
    expect(nodes.find((n) => n.id === "board")?.props.rulerGuides).toEqual([
      { axis: "x", offset: 50 },
    ]);
    validate(nodes);
  });

  it("ties a stroke to its library colour", () => {
    const { nodes } = convertFile(
      fileOf(
        [
          {
            id: "r",
            type: "rect",
            parentId: ROOT,
            ...box(0, 0, 10, 10),
            strokes: [
              { strokeColor: "#007ca5", strokeOpacity: 1, strokeWidth: 1, strokeColorRefId: "c1" },
            ],
          },
        ],
        {
          colors: new Map([["c1", { id: "c1", name: "Primary", color: "#007ca5", opacity: 1 }]]),
        },
      ),
      noMedia,
    );
    expect(nodes.find((n) => n.id === "r")?.props.bindings).toEqual({ stroke: "c1" });
    validate(nodes);
  });

  it("notes what still can't come across", () => {
    const { notes } = convertFile(
      fileOf(
        [
          {
            id: "line",
            type: "path",
            parentId: ROOT,
            content: "M0,0L40,0",
            strokes: [
              {
                strokeColor: "#000000",
                strokeWidth: 2,
                strokeCapStart: "round",
                strokeCapEnd: "square",
              },
            ],
          },
        ],
        {
          record: { id: "f", features: ["components/v2", "something/v9"] },
          colors: new Map([
            ["g", { id: "g", name: "Sunset", gradient: { type: "linear", stops: [] } }],
          ]),
        },
      ),
      noMedia,
    );
    expect(notes.lines()).toEqual(
      expect.arrayContaining([
        "1 file uses Penpot features this import doesn't know yet, so some of it may look different",
        "1 library colour that's a gradient or an image wasn't kept as a variable",
        "1 line's two different end caps became one",
      ]),
    );
  });
});

/**
 * Real files from Penpot's hub (test/kits-compat.test.ts measures them all)
 * taught these: each case is one way a converted file used to come apart.
 */
describe("matching Penpot's layout", () => {
  it("never stretches with Penpot's stretch: only Fill resizes there", () => {
    const { nodes } = convertFile(
      fileOf([
        {
          id: "col",
          type: "frame",
          parentId: ROOT,
          shapes: ["t"],
          ...box(0, 0, 200, 100),
          layout: "flex",
          layoutFlexDir: "column",
          layoutAlignItems: "stretch",
          layoutItemHSizing: "auto",
        },
        {
          id: "t",
          type: "rect",
          parentId: "col",
          ...box(0, 0, 72, 30),
          layoutItemAlignSelf: "stretch",
          layoutItemHSizing: "fix",
        },
      ]),
      noMedia,
    );
    const col = nodes.find((n) => n.id === "col") as NodeRecord;
    const t = nodes.find((n) => n.id === "t") as NodeRecord;
    // Penpot places stretched items at the start, at their own size.
    expect(col.props.alignItems).toBeUndefined();
    expect(t.props.alignSelf).toBeUndefined();
    expect(t.props.width).toBe(72);
  });

  it("keeps the cells Penpot's grid put auto-placed items in", () => {
    const { nodes } = convertFile(
      fileOf([
        {
          id: "grid",
          type: "frame",
          parentId: ROOT,
          // Layer order puts the text first; Penpot placed it in the second column.
          shapes: ["text", "image"],
          ...box(0, 0, 550, 180),
          layout: "grid",
          layoutGridColumns: [{ type: "auto" }, { type: "flex", value: 1 }],
          layoutGridRows: [{ type: "auto" }],
          layoutGridCells: {
            c1: {
              id: "c1",
              position: "auto",
              column: 1,
              row: 1,
              columnSpan: 1,
              rowSpan: 1,
              shapes: ["image"],
            },
            c2: {
              id: "c2",
              position: "auto",
              column: 2,
              row: 1,
              columnSpan: 1,
              rowSpan: 1,
              shapes: ["text"],
            },
          },
        },
        {
          id: "text",
          type: "rect",
          parentId: "grid",
          ...box(228, 0, 322, 96),
          layoutItemHSizing: "fill",
        },
        { id: "image", type: "rect", parentId: "grid", ...box(0, 0, 218, 180) },
      ]),
      noMedia,
    );
    const area = (id: string) => (nodes.find((n) => n.id === id) as NodeRecord).props.gridArea;
    expect(area("image")).toMatchObject({ column: 1, row: 1 });
    expect(area("text")).toMatchObject({ column: 2, row: 1 });
  });

  it("links a copy nested in a copy to the outer main, as Drawpane's nested instances are", () => {
    const shapes = [
      // Component C1: a main with one rect.
      {
        id: "m1",
        type: "frame",
        parentId: ROOT,
        shapes: ["m1r"],
        ...box(0, 0, 50, 50),
        mainInstance: true,
        componentId: "C1",
      },
      { id: "m1r", type: "rect", parentId: "m1", ...box(0, 0, 50, 50) },
      // Component C2: a main holding a copy of C1.
      {
        id: "m2",
        type: "frame",
        parentId: ROOT,
        shapes: ["m2n"],
        ...box(100, 0, 60, 60),
        mainInstance: true,
        componentId: "C2",
      },
      {
        id: "m2n",
        type: "frame",
        parentId: "m2",
        shapes: ["m2nr"],
        ...box(100, 0, 50, 50),
        componentId: "C1",
        shapeRef: "m1",
      },
      { id: "m2nr", type: "rect", parentId: "m2n", ...box(100, 0, 50, 50), shapeRef: "m1r" },
      // A copy of C2, with its nested copy of C1.
      {
        id: "x",
        type: "frame",
        parentId: ROOT,
        shapes: ["xn"],
        ...box(200, 0, 60, 60),
        componentId: "C2",
        shapeRef: "m2",
      },
      {
        id: "xn",
        type: "frame",
        parentId: "x",
        shapes: ["xnr"],
        ...box(200, 0, 50, 50),
        componentId: "C1",
        shapeRef: "m2n",
      },
      { id: "xnr", type: "rect", parentId: "xn", ...box(200, 0, 50, 50), shapeRef: "m2nr" },
    ];
    const components = new Map(
      [
        { id: "C1", mainInstanceId: "m1", mainInstancePage: "p1" },
        { id: "C2", mainInstanceId: "m2", mainInstancePage: "p1" },
      ].map((c) => [c.id, c as never]),
    );
    const { nodes } = convertFile(fileOf(shapes, { components }), noMedia);
    const props = (id: string) => (nodes.find((n) => n.id === id) as NodeRecord).props;
    expect(props("x")).toMatchObject({ instanceOf: "m2" });
    expect(props("xn")).toMatchObject({ instanceOf: "m1", mirrors: "m2n" });
    expect(props("xnr")).toMatchObject({ mirrors: "m2nr" });
    validate(nodes);
  });

  it("gives a layer Penpot repeats on another page (a duplicated page) an id of its own there", () => {
    const page = (id: string) => ({
      record: { id, name: id, flows: { f: { id: "f", name: "Flow", startingFrame: "board" } } },
      shapes: new Map(
        [
          { id: ROOT, type: "frame", shapes: ["board"] },
          { id: "board", type: "frame", parentId: ROOT, shapes: ["r"], ...box(0, 0, 100, 100) },
          { id: "r", type: "rect", parentId: "board", ...box(10, 10, 20, 20) },
        ].map((s) => [s.id, s as never]),
      ),
    });
    const file = { ...fileOf([]), pages: [page("p1"), page("p2")] };
    const { nodes, idOf } = convertFile(file, noMedia);
    validate(nodes);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    // The first page keeps Penpot's ids; the second page's layers have their own, linked up.
    expect(idOf("p1", "board")).toBe("board");
    const board2 = idOf("p2", "board");
    expect(board2).not.toBe("board");
    expect(nodes.find((n) => n.id === board2)?.parent).toBe("p2");
    expect(nodes.find((n) => n.id === idOf("p2", "r"))?.parent).toBe(board2);
    const flows = (nodes.find((n) => n.id === "p2") as NodeRecord).props.flows as Array<{
      start: string;
    }>;
    expect(flows[0]?.start).toBe(board2);
    // The same every time: converting again gives the same ids.
    expect(convertFile(file, noMedia).idOf("p2", "board")).toBe(board2);
  });
});
