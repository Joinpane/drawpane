/**
 * The adapter's mappings one at a time: path blobs, gradient handles,
 * container sniffing, style links, text runs and lists, auto layout, ids of
 * instance layers, and images.
 */
import { convertFile, type Figma } from "@drawpane/figma";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { SceneGraph, type SceneNode } from "@open-pencil/scene-graph";
import { describe, expect, it } from "vitest";
import { commandsToPath, gradientHandles, ImportError, imageMime, sniffFig } from "../src";
import { adaptNode } from "../src/adapt";
import { RestIds } from "../src/ids";
import { FigNotes } from "../src/notes";
import type { RawRecord } from "../src/raw";
import { prepareStyles } from "../src/styles";
import { textFields } from "../src/text";

/** A path blob: opcodes and little-endian float32 arguments. */
function blob(...commands: [number, ...number[]][]): Uint8Array {
  const size = commands.reduce((n, [, ...args]) => n + 1 + args.length * 4, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [op, ...args] of commands) {
    out[at++] = op;
    for (const a of args) {
      view.setFloat32(at, a, true);
      at += 4;
    }
  }
  return out;
}

describe("path blobs", () => {
  it("reads move, line, quadratic, cubic and close as SVG path data", () => {
    expect(
      commandsToPath(
        blob([1, 0, 10], [2, 160, 0], [3, 170, 0, 170, 10], [4, 0, 4.477, 4.477, 0, 10, 0], [0]),
      ),
    ).toBe("M0 10L160 0Q170 0 170 10C0 4.477 4.477 0 10 0Z");
  });

  it("stops at an opcode it doesn't know, or one cut short", () => {
    expect(commandsToPath(blob([1, 1, 2], [9, 0]))).toBe("M1 2");
    expect(commandsToPath(blob([1, 1, 2]).subarray(0, 6))).toBe("");
  });
});

describe("gradient handles", () => {
  it("takes Figma's top-to-bottom default back to its handles", () => {
    const handles = gradientHandles("GRADIENT_LINEAR", {
      m00: 0,
      m01: 1,
      m02: 0,
      m10: -1,
      m11: 0,
      m12: 1,
    });
    expect(handles?.[0]).toEqual({ x: 0.5, y: 0 });
    expect(handles?.[1]).toEqual({ x: 0.5, y: 1 });
  });

  it("puts a radial gradient's centre, edge and width handle a quarter turn apart", () => {
    const [from, to, width] =
      gradientHandles("GRADIENT_RADIAL", {
        m00: 2,
        m01: 0,
        m02: -0.5,
        m10: 0,
        m11: 2,
        m12: -0.5,
      }) ?? [];
    expect(from).toEqual({ x: 0.5, y: 0.5 });
    expect(to).toEqual({ x: 0.75, y: 0.5 });
    expect(width).toEqual({ x: 0.5, y: 0.75 });
  });

  it("gives none for a degenerate transform", () => {
    expect(
      gradientHandles("GRADIENT_LINEAR", { m00: 0, m01: 0, m02: 0, m10: 0, m11: 0, m12: 0 }),
    ).toBeNull();
  });
});

describe("telling a .fig apart", () => {
  const raw = (magic: string, version = 101) => {
    const out = new Uint8Array(16);
    out.set([...magic].map((c) => c.charCodeAt(0)));
    new DataView(out.buffer).setUint32(8, version, true);
    return out;
  };
  const refusal = async (bytes: Uint8Array) => {
    try {
      await sniffFig(bytes);
      return null;
    } catch (e) {
      return e instanceof ImportError ? `${e.code}: ${e.message}` : String(e);
    }
  };

  it("takes a design file and reads its version", async () => {
    expect(await sniffFig(raw("fig-kiwi", 4))).toEqual({ zip: false, version: 4 });
  });

  it("says plainly what it can't read", async () => {
    expect(await refusal(raw("fig-jam."))).toBe(
      "not-design: This is a FigJam board. Only Figma design files can be imported.",
    );
    expect(await refusal(raw("fig-deck"))).toBe(
      "not-design: This is a Figma Slides deck. Only Figma design files can be imported.",
    );
    expect(
      await refusal(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).toBe(
      "not-fig: This isn't a Figma .fig file. In Figma, use File → Save local copy to make one.",
    );
    // A zip that isn't one Figma wrote: damaged, as far as a .fig goes.
    expect(await refusal(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toMatch(/^corrupt:/);
  });
});

describe("images", () => {
  it("knows formats by their first bytes", () => {
    const pad = (b: number[]) => new Uint8Array([...b, ...new Array(12).fill(0)]);
    expect(imageMime(pad([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(imageMime(pad([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(imageMime(pad([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
    expect(
      imageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(imageMime(pad([1, 2, 3]))).toBeNull();
  });
});

describe("style links", () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const grey = { r: 0.4, g: 0.4, b: 0.4, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };

  it("gives older links the newer field, and applies styles to styled runs", () => {
    const records = [
      {
        guid: guid(1),
        type: "ROUNDED_RECTANGLE",
        styleType: "FILL",
        fillPaints: [{ type: "SOLID", color: grey }],
      },
      {
        guid: guid(2),
        type: "TEXT",
        styleType: "TEXT",
        fontSize: 20,
        fontName: { family: "Inter", style: "Bold", postscript: "" },
      },
      {
        guid: guid(3),
        type: "TEXT",
        fillPaints: [{ type: "SOLID", color: black }],
        inheritFillStyleID: guid(1),
        textData: {
          characters: "Hi there",
          characterStyleIDs: [0, 0, 1],
          styleOverrideTable: [
            { styleID: 1, inheritFillStyleID: guid(1), inheritTextStyleID: guid(2) },
          ],
        },
      },
      // A detached style (all-ones guid) links to nothing.
      {
        guid: guid(4),
        type: "TEXT",
        inheritFillStyleID: { sessionID: 0xffffffff, localID: 0xffffffff },
      },
    ] as unknown as NodeChange[];
    prepareStyles(records);
    const text = records[2] as unknown as Record<string, unknown>;
    expect(text.styleIdForFill).toEqual({ guid: guid(1) });
    const run = (text.textData as { styleOverrideTable: Record<string, unknown>[] })
      .styleOverrideTable[0];
    expect(run).toMatchObject({
      fillPaints: [{ type: "SOLID", color: grey }],
      fontSize: 20,
      fontName: { family: "Inter", style: "Bold" },
    });
    expect((records[3] as unknown as Record<string, unknown>).styleIdForFill).toBeUndefined();
  });
});

/** A small scene graph to adapt: a page, and whatever a test puts on it. */
function scene() {
  const graph = new SceneGraph();
  const page =
    graph.getPages(true)[0] ?? graph.createNode("CANVAS", graph.rootId, { name: "Page" });
  const records = new Map<string, string>();
  const add = (
    type: SceneNode["type"],
    parent: string,
    guid: string | null,
    props: Partial<SceneNode> = {},
  ) => {
    const node = graph.createNode(type, parent, props);
    if (guid) records.set(guid, node.id);
    return node;
  };
  const adapt = (node: SceneNode, raw: ReadonlyMap<string, RawRecord> = new Map()) => {
    const notes = new FigNotes();
    const parent = graph.getNode(node.parentId ?? "") ?? page;
    return adaptNode(node, parent, [1, 0, 0, 0, 1, 0, 0, 0, 1], {
      graph,
      ids: new RestIds(graph, records),
      records: raw,
      notes,
    });
  };
  return { graph, page, add, adapt, records };
}

describe("layers", () => {
  it("keeps auto layout, its children's sizing and constraints", () => {
    const { page, add, adapt } = scene();
    const row = add("FRAME", page.id, "1:1", {
      name: "Row",
      width: 300,
      height: 40,
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      counterAxisSpacing: Number.NaN,
      paddingLeft: 12,
      paddingRight: 12,
      primaryAxisSizing: "HUG",
      counterAxisSizing: "FIXED",
      primaryAxisAlign: "SPACE_BETWEEN",
      counterAxisAlign: "CENTER",
      clipsContent: true,
    });
    add("RECTANGLE", row.id, "1:2", {
      name: "Fill",
      width: 10,
      height: 10,
      layoutGrow: 1,
      layoutAlignSelf: "STRETCH",
    });
    const rest = adapt(row);
    expect(rest).toMatchObject({
      id: "1:1",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      // Figma's NaN means "the same as the item spacing".
      counterAxisSpacing: 8,
      paddingLeft: 12,
      primaryAxisSizingMode: "AUTO",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      clipsContent: true,
      constraints: { horizontal: "LEFT", vertical: "TOP" },
    });
    expect(rest.children?.[0]).toMatchObject({
      id: "1:2",
      type: "RECTANGLE",
      layoutGrow: 1,
      layoutAlign: "STRETCH",
    });
  });

  it("reads a grid's tracks, gaps and items from its records, which Open Pencil's graph drops", () => {
    const { page, add, adapt } = scene();
    const grid = add("FRAME", page.id, "5:1", {
      name: "Grid",
      width: 300,
      height: 100,
      layoutMode: "GRID",
      primaryAxisSizing: "FIXED",
      counterAxisSizing: "HUG",
      paddingTop: 4,
    });
    add("FRAME", grid.id, "5:2", {
      name: "Cell",
      width: 40,
      height: 20,
      layoutGrow: 1,
      layoutAlignSelf: "STRETCH",
    });
    add("RECTANGLE", grid.id, "5:3", { name: "Badge", width: 8, height: 8 });
    const guid = (localID: number) => ({ sessionID: 9, localID });
    const size = (type: "FIXED" | "FLEX" | "HUG", value: number) => ({
      minSizing: { type, value },
      maxSizing: { type, value },
    });
    const raw = new Map<string, RawRecord>([
      [
        "5:1",
        {
          // Tracks are kept by id, in the order of their positions, not as listed.
          gridColumns: {
            entries: [
              { id: guid(2), position: "#" },
              { id: guid(1), position: "!" },
              { id: guid(3), position: "$" },
            ],
          },
          gridColumnsSizing: {
            entries: [
              { id: guid(1), trackSize: size("FIXED", 32) },
              { id: guid(2), trackSize: size("FLEX", 1) },
              {
                id: guid(3),
                trackSize: {
                  minSizing: { type: "FIXED", value: 40 },
                  maxSizing: { type: "HUG", value: 1 },
                },
              },
            ],
          },
          gridRows: {
            entries: [
              { id: guid(4), position: "!" },
              { id: guid(5), position: '"' },
            ],
          },
          gridRowsSizing: {
            entries: [
              { id: guid(4), trackSize: size("HUG", 1) },
              { id: guid(5), trackSize: size("HUG", 1) },
            ],
          },
          gridColumnGap: 8,
          gridRowGap: 6,
        },
      ],
      [
        "5:3",
        {
          gridRowAnchor: guid(5),
          gridColumnAnchor: guid(3),
          gridChildHorizontalAlign: "CENTER",
        },
      ],
    ]);
    const rest = adapt(grid, raw);
    expect(rest).toMatchObject({
      layoutMode: "GRID",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "AUTO",
      paddingTop: 4,
      gridColumnsSizing: "32px 1fr minmax(40px, auto)",
      gridRowsSizing: "auto auto",
      gridColumnGap: 8,
      gridRowGap: 6,
    });
    // An item grows across and stretches down, as a row's child does.
    expect(rest.children?.[0]).toMatchObject({ layoutGrow: 1, layoutAlign: "STRETCH" });
    expect(rest.children?.[1]).toMatchObject({
      gridRowAnchorIndex: 1,
      gridColumnAnchorIndex: 2,
      gridRowSpan: 1,
      gridColumnSpan: 1,
      gridChildHorizontalAlign: "CENTER",
    });
    // And the converter reads it as Drawpane's grid.
    const { nodes } = convertFile({
      name: "Grid",
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [{ id: "0:1", name: "Page", type: "CANVAS", children: [rest] }],
      },
    });
    const props = (name: string) => nodes.find((n) => n.props.name === name)?.props;
    expect(props("Grid")).toMatchObject({
      layoutMode: "grid",
      sizingV: "hug",
      gap: 8,
      rowGap: 6,
      gridColumns: [{ unit: "px", value: 32 }, { unit: "fr", value: 1 }, { unit: "auto" }],
      gridRows: [{ unit: "auto" }, { unit: "auto" }],
    });
    expect(props("Cell")).toMatchObject({ sizingH: "fill", sizingV: "fill" });
    expect(props("Badge")).toMatchObject({
      gridArea: { column: 3, row: 2, columnSpan: 1, rowSpan: 1 },
      justifySelf: "center",
    });
  });

  it("places layers by their transform, rotation and flips included", () => {
    const { page, add, adapt } = scene();
    const frame = add("FRAME", page.id, "2:1", {
      width: 100,
      height: 50,
      x: 10,
      y: 20,
      rotation: 90,
    });
    const rest = adapt(frame);
    const [[a, c, e], [b, d, f]] = rest.relativeTransform as Figma.Transform;
    // Rotated about its centre, as Figma's matrix has it.
    expect([a, b, c, d].map((v) => Math.round(v))).toEqual([0, 1, -1, 0]);
    expect([Math.round(e), Math.round(f)]).toEqual([85, -5]);
    // Turned about its centre (60, 45): 50 wide and 100 tall around it.
    const box = rest.absoluteBoundingBox;
    expect(
      [box?.x, box?.y, box?.width, box?.height].map((v) => Math.round(v ?? Number.NaN)),
    ).toEqual([35, -5, 50, 100]);
  });

  it("writes text runs as REST's style ids and table, and lists per paragraph", () => {
    const { page, add, adapt } = scene();
    const text = add("TEXT", page.id, "3:1", {
      text: "Title\nOne\nTwo",
      fontFamily: "Inter",
      fontWeight: 400,
      fontSize: 16,
      lineHeight: 24,
      styleRuns: [
        { start: 0, length: 5, style: { fontWeight: 700, fontFamily: "Inter", italic: false } },
        { start: 10, length: 3, style: { fontWeight: 700, fontFamily: "Inter", italic: false } },
      ],
      textParagraphs: [
        { listType: "NONE", indentation: 0 },
        { listType: "UNORDERED", indentation: 1 },
        { listType: "UNORDERED", indentation: 2 },
      ],
    });
    const rest = adapt(text);
    expect(rest.characters).toBe("Title\nOne\nTwo");
    expect(rest.style).toMatchObject({
      fontFamily: "Inter",
      fontWeight: 400,
      fontSize: 16,
      lineHeightUnit: "PIXELS",
      lineHeightPx: 24,
    });
    expect(rest.characterStyleOverrides).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1]);
    expect(rest.styleOverrideTable).toEqual({
      "1": { fontFamily: "Inter", fontWeight: 700, italic: false },
    });
    expect(rest.lineTypes).toEqual(["NONE", "UNORDERED", "UNORDERED"]);
    expect(rest.lineIndentations).toEqual([0, 1, 2]);
  });

  it("keeps a percentage line height, unless Figma's saved layout put its lines whole pixels apart", () => {
    const { page, add } = scene();
    // 162.5% of 14 px: 22.75 px, which Figma lays out as 23 for some layers and not others.
    const text = add("TEXT", page.id, "3:2", { text: "Hi", fontSize: 14, lineHeight: 22.75 });
    const percent = { lineHeight: { value: 1.625, units: "RAW" as const }, fontSize: 14 };
    const laidOut = (lineHeight: number) => ({
      ...percent,
      derivedTextData: { baselines: [{ lineHeight }] },
    });
    const style = (raw: Parameters<typeof textFields>[1]) =>
      (textFields(text, raw, new FigNotes()) as { style: Figma.TypeStyle }).style;
    expect(style(percent)).toMatchObject({
      lineHeightUnit: "FONT_SIZE_%",
      lineHeightPercentFontSize: 162.5,
    });
    expect(style(laidOut(22.75))).toMatchObject({
      lineHeightUnit: "FONT_SIZE_%",
      lineHeightPercentFontSize: 162.5,
    });
    expect(style(laidOut(23))).toMatchObject({ lineHeightUnit: "PIXELS", lineHeightPx: 23 });
  });

  it("names an instance's layers after the instance and the component layers they copy", () => {
    const { graph, page, add, adapt } = scene();
    const main = add("COMPONENT", page.id, "4:1", { name: "Button", width: 80, height: 32 });
    const label = add("TEXT", main.id, "4:2", { name: "Label", text: "OK" });
    const instance = add("INSTANCE", page.id, "5:1", {
      name: "Button",
      componentId: main.id,
      width: 80,
      height: 32,
    });
    // A copied layer that isn't an instance names the layer it copies.
    add("TEXT", instance.id, null, { name: "Label", text: "Cancel", componentId: label.id });
    const rest = adapt(instance);
    expect(rest.componentId).toBe("4:1");
    expect(rest.children?.[0]?.id).toBe("I5:1;4:2");
    // And the converter links it to the main's layer.
    const page_ = adapt(graph.getNode(page.id) as SceneNode);
    const file: Figma.File = {
      name: "t",
      document: {
        id: "0:0",
        name: "d",
        type: "DOCUMENT",
        children: [{ ...page_, type: "CANVAS" }],
      },
    };
    const { nodes } = convertFile(file);
    const copy = nodes.find((n) => n.props.name === "Label" && n.props.characters === "Cancel");
    expect(copy?.props.mirrors).toBe("f4-2");
  });

  it("maps paints: solid, gradient handles, a cropped image", () => {
    const { page, add, adapt } = scene();
    const rect = add("RECTANGLE", page.id, "6:1", {
      width: 10,
      height: 10,
      fills: [
        {
          type: "SOLID",
          color: { r: 1, g: 0, b: 0, a: 1 },
          opacity: 0.5,
          visible: true,
          blendMode: "NORMAL",
        },
        {
          type: "GRADIENT_LINEAR",
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true,
          gradientStops: [
            { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
          ],
          gradientTransform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        },
        {
          type: "IMAGE",
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true,
          imageHash: "AB".repeat(20),
          imageScaleMode: "CROP",
          imageTransform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 0.5, m12: 0 },
        },
      ],
    });
    const fills = adapt(rect).fills ?? [];
    expect(fills[0]).toEqual({ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 });
    expect(fills[1]?.gradientHandlePositions?.slice(0, 2)).toEqual([
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ]);
    expect(fills[2]).toMatchObject({
      type: "IMAGE",
      imageRef: "ab".repeat(20),
      scaleMode: "STRETCH",
      imageTransform: [
        [0.5, 0, 0.25],
        [0, 0.5, 0],
      ],
    });
  });
});
