import { getProp, type NodeRecord, type Op, type Props, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { cssFor } from "../src/code";
import { Editor } from "../src/editor";
import { hitsNode } from "../src/hit";
import { Interaction, type PointerInput } from "../src/interaction";
import { markerLength, markerShape, openEnds, trimmedStroke } from "../src/markers";
import { exportSvg, stopColorAt } from "../src/svg";
import { nodePath, roundedPolygonPath, shapeVertices } from "../src/vector/shapes";

const node = (type: NodeRecord["type"], props: Props): NodeRecord => ({
  id: "n",
  type,
  parent: "p",
  key: "a0",
  props,
});

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("polygon and star geometry", () => {
  it("puts a polygon's first point at the top, clockwise, inside the box", () => {
    const v = shapeVertices(100, 100, 4);
    expect(v).toHaveLength(4);
    near(v[0]?.x as number, 50);
    near(v[0]?.y as number, 0);
    near(v[1]?.x as number, 100);
    near(v[1]?.y as number, 50);
  });

  it("alternates a star's outer and inner points", () => {
    const v = shapeVertices(200, 200, 5, 0.5);
    expect(v).toHaveLength(10);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x - 100, p.y - 100);
    near(r(v[0] as never), 100);
    near(r(v[1] as never), 50);
  });

  it("rounds each corner with an arc tangent to both edges", () => {
    // A square's corner of radius 10: tangent points 10 along each edge, handles 4/3·tan(π/8)·r.
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const [sub] = roundedPolygonPath(square, 10);
    expect(sub?.anchors).toHaveLength(8);
    const a = sub?.anchors[0];
    expect(a?.x).toBeCloseTo(0, 6);
    expect(a?.y).toBeCloseTo(10, 6);
    const handle = (4 / 3) * Math.tan(Math.PI / 8) * 10;
    expect(a?.out?.y).toBeCloseTo(10 - handle, 6);
  });

  it("never lets neighbouring corners overlap", () => {
    const [sub] = roundedPolygonPath(shapeVertices(40, 40, 3), 1000);
    for (const a of sub?.anchors ?? []) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
    }
  });

  it("hits inside a star's outline, not in its notches", () => {
    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        op: "create",
        id: "s",
        type: "star",
        parent: "p",
        key: "a0",
        props: { width: 100, height: 100, pointCount: 5, innerRadius: 0.38 },
      },
    ]);
    const star = editor.doc.get("s") as NodeRecord;
    expect(hitsNode(editor.scene, star, { x: 50, y: 50 }, 0)).toBe(true);
    expect(hitsNode(editor.scene, star, { x: 50, y: 5 }, 0)).toBe(true);
    // Between the two top-side points, outside the inner radius.
    expect(hitsNode(editor.scene, star, { x: 82, y: 22 }, 0)).toBe(false);
  });
});

describe("end markers", () => {
  it("finds a line's ends pointing outward", () => {
    const ends = openEnds(node("line", { width: 100, height: 0 }));
    expect(ends?.start).toEqual({ point: { x: 0, y: 0 }, dir: { x: -1, y: 0 } });
    expect(ends?.end).toEqual({ point: { x: 100, y: 0 }, dir: { x: 1, y: 0 } });
  });

  it("follows a curve's handles at its ends", () => {
    const ends = openEnds(
      node("path", { pathData: "M0 0C0 50 100 50 100 0", width: 100, height: 40 }),
    );
    // Leaves the start going down (handle at 0,50): pointing out means up.
    expect(ends?.start.dir.x).toBeCloseTo(0, 6);
    expect(ends?.start.dir.y).toBeCloseTo(-1, 6);
    expect(ends?.end.dir.y).toBeCloseTo(-1, 6);
    // Closed paths have no ends.
    expect(openEnds(node("path", { pathData: "M0 0L10 0L10 10Z" }))).toBeNull();
  });

  it("sizes markers by the stroke, and pulls the stroke back under a triangle", () => {
    expect(markerLength(1)).toBe(8);
    expect(markerLength(4)).toBe(20);
    const end = { point: { x: 100, y: 0 }, dir: { x: 1, y: 0 } };
    const arrow = markerShape("arrow", end, 2);
    expect(arrow.fill).toBeNull();
    expect(arrow.stroke?.[0]?.anchors[1]).toMatchObject({ x: 100, y: 0 });
    const triangle = markerShape("triangle", end, 2);
    expect(triangle.inset).toBeCloseTo(markerLength(2) * 0.6, 6);
    const line = node("line", { width: 100, height: 0, markerEnd: "triangle" });
    const trimmed = trimmedStroke(line, 0, triangle.inset);
    expect(trimmed?.[0]?.anchors[1]?.x).toBeCloseTo(100 - triangle.inset, 6);
  });
});

describe("export", () => {
  function editorWith(nodes: Array<Props & { id: string; type: NodeRecord["type"] }>) {
    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
    const ops: Op[] = [
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ];
    nodes.forEach(({ id, type, ...props }, i) => {
      ops.push({ op: "create", id, type, parent: "p", key: `a${i}`, props });
    });
    editor.doc.apply(ops);
    return editor;
  }
  const svg = (editor: Editor, id: string) =>
    exportSvg(editor.scene, editor.measurer, [id], { x: -50, y: -50, width: 300, height: 300 });

  it("writes stars as paths and angular gradients as wedge patterns", () => {
    const editor = editorWith([
      {
        id: "s",
        type: "star",
        width: 100,
        height: 100,
        pointCount: 5,
        fills: [
          {
            type: "angular",
            from: { x: 0.5, y: 0.5 },
            to: { x: 1, y: 0.5 },
            stops: [
              { position: 0, color: "#ff0000" },
              { position: 1, color: "#0000ff" },
            ],
          },
        ],
      },
    ]);
    const out = svg(editor, "s");
    expect(out).toContain("<pattern");
    expect(out.match(/<path d="M50 50L/g)?.length).toBe(180);
    // The star's outline starts at its top point.
    expect(out).toContain('<path d="M50 0L');
    expect(
      stopColorAt(
        [
          { position: 0, color: "#000000" },
          { position: 1, color: "#ffffff" },
        ],
        0.5,
      ),
    ).toBe("#808080");
  });

  it("draws image fills placed by their scale mode, clipped to the shape", () => {
    const ref = "a".repeat(64);
    const editor = editorWith([
      {
        id: "i",
        type: "rect",
        width: 200,
        height: 100,
        cornerRadius: 12,
        fills: [{ type: "image", ref, scaleMode: "fill", opacity: 0.5 }],
      },
      {
        id: "t",
        type: "rect",
        width: 100,
        height: 100,
        fills: [{ type: "image", ref, scaleMode: "tile" }],
      },
    ]);
    const images = (r: string) =>
      r === ref ? { href: "data:image/png;base64,AAAA", width: 100, height: 100 } : null;
    const bounds = { x: -50, y: -50, width: 300, height: 300 };
    const out = exportSvg(editor.scene, editor.measurer, ["i"], bounds, { images });
    // Fill covers 200 × 100 with a square image: 200 × 200, centred vertically.
    expect(out).toContain(
      '<image x="0" y="-50" width="200" height="200" href="data:image/png;base64,AAAA"',
    );
    expect(out).toMatch(/<clipPath id="[^"]+"><rect[^>]*rx="12"/);
    expect(out).toContain('opacity="0.5"');
    const tiled = exportSvg(editor.scene, editor.measurer, ["t"], bounds, { images });
    expect(tiled).toContain('<pattern id="');
    expect(tiled).toContain('patternUnits="userSpaceOnUse" width="100" height="100"');
    // Without the image, the fill is left out rather than drawn wrong.
    expect(exportSvg(editor.scene, editor.measurer, ["i"], bounds)).not.toContain("<image");
  });

  it("draws markers in the stroke's paint", () => {
    const editor = editorWith([
      {
        id: "l",
        type: "line",
        width: 100,
        height: 0,
        strokes: [{ type: "solid", color: "#ff5a1f" }],
        strokeWeight: 2,
        markerEnd: "triangle",
        markerStart: "circle",
      },
    ]);
    const out = svg(editor, "l");
    // The trimmed stroke, then a circle and a triangle, all in the stroke's colour.
    expect(out.match(/fill="#ff5a1f"/g)?.length).toBe(2);
    expect(out).toContain('stroke="#ff5a1f"');
  });

  it("gives CSS a conic gradient and a polygon clip path", () => {
    const css = cssFor(
      editorWith([]).doc,
      node("polygon", {
        width: 100,
        height: 100,
        pointCount: 4,
        fills: [
          {
            type: "angular",
            from: { x: 0.5, y: 0.5 },
            to: { x: 0.5, y: 0 },
            stops: [
              { position: 0, color: "#000000" },
              { position: 1, color: "#ffffff" },
            ],
          },
        ],
      }),
    );
    expect(css).toContainEqual({
      property: "clip-path",
      value: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
    });
    expect(css.find((d) => d.property === "background")?.value).toMatch(
      /^conic-gradient\(from 0deg at 50% 50%/,
    );
  });
});

describe("shape tools", () => {
  const at = (x: number, y: number): PointerInput => ({
    screen: { x, y },
    button: 0,
    shift: false,
    alt: false,
    mod: false,
    clicks: 1,
  });

  it("draws a five-point star and an arrow", () => {
    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
    editor.state.set({ role: "editor" });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    ]);
    editor.setPage("p");
    const interaction = new Interaction(editor);
    editor.setTool("star");
    interaction.down(at(0, 0));
    interaction.move(at(80, 80));
    interaction.up(at(80, 80));
    const star = editor.doc.get(editor.s.selection[0] as string) as NodeRecord;
    expect(star.type).toBe("star");
    expect(getProp(star.props, "pointCount")).toBe(5);
    expect(getProp(star.props, "name")).toBe("Star 1");
    expect(nodePath(star)?.[0]?.anchors).toHaveLength(10);

    editor.setTool("arrow");
    interaction.down(at(0, 200));
    interaction.move(at(100, 200));
    interaction.up(at(100, 200));
    const arrow = editor.doc.get(editor.s.selection[0] as string) as NodeRecord;
    expect(arrow.type).toBe("line");
    expect(getProp(arrow.props, "markerEnd")).toBe("arrow");
    expect(editor.s.tool).toBe("select");
  });
});
