import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getProp, ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { apply, type Point } from "../src/geometry";
import { Interaction, type PointerInput } from "../src/interaction";
import type { TextMeasurer } from "../src/text";
import type { KeyInput } from "../src/tools/types";
import {
  anchorKind,
  type BooleanEngine,
  type BooleanOperand,
  hitPathData,
  loadPathKitEngine,
  parsePath,
  pathBounds,
} from "../src/vector";

const measurer: TextMeasurer = { width: (_font, text) => text.length * 8 };

function makeEditor(engine?: BooleanEngine) {
  const editor = new Editor({
    measurer,
    clientId: "test",
    ...(engine ? { booleanEngine: async () => engine } : {}),
  });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
  ]);
  editor.setPage("p");
  return editor;
}

/** Pointer input at a screen point; the default camera maps screen 1:1 to the page. */
const at = (x: number, y: number, o: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
  ...o,
});
const key = (k: string, o: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shift: false,
  alt: false,
  mod: false,
  ...o,
});

function click(ix: Interaction, x: number, y: number, o: Partial<PointerInput> = {}) {
  ix.move(at(x, y, o));
  ix.down(at(x, y, o));
  ix.up(at(x, y, o));
}

function drag(ix: Interaction, from: Point, to: Point, o: Partial<PointerInput> = {}, steps = 6) {
  ix.down(at(from.x, from.y, o));
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    ix.move(at(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, o));
  }
  ix.up(at(to.x, to.y, o));
}

const props = (editor: Editor, id: string) => editor.doc.get(id)?.props ?? {};
const d = (editor: Editor, id: string) => getProp(props(editor, id), "pathData");

/** Creates a path node with path data in its local box at x, y. */
function addPath(editor: Editor, pathData: string, x: number, y: number, extra = {}): string {
  const b = pathBounds(parsePath(pathData));
  const id = `path${editor.doc.childIds("p").length + 1}`.padEnd(10, "0");
  editor.commit([
    {
      op: "create",
      id,
      type: "path",
      parent: "p",
      key: editor.topKey("p"),
      props: {
        pathData,
        x,
        y,
        width: b?.width ?? 0,
        height: b?.height ?? 0,
        fills: [{ type: "solid", color: "#cdeee8" }],
        ...extra,
      },
    },
  ]);
  return id;
}

/** Screen position of a local anchor of a path node. */
function screenOf(editor: Editor, id: string, p: Point): Point {
  return editor.s.camera.toScreen(apply(editor.scene.worldMatrix(id), p));
}

describe("Pen", () => {
  let editor: Editor;
  let ix: Interaction;
  beforeEach(() => {
    editor = makeEditor();
    ix = new Interaction(editor);
    editor.setTool("pen");
  });

  it("draws a closed triangle as one undo step, live as it goes", () => {
    click(ix, 100, 100);
    expect(editor.doc.childIds("p")).toHaveLength(0); // One anchor shows nothing yet.
    ix.move(at(200, 100));
    expect(editor.s.vectorPointer).toEqual({ x: 200, y: 100 });
    click(ix, 200, 100);
    const [id] = editor.doc.childIds("p");
    if (!id) throw new Error("no path");
    // Collaborators see it: committed and queued for the room while still drawing.
    expect(editor.s.gesture).toBe(true);
    expect(editor.sync.pendingCount).toBeGreaterThan(0);
    expect(d(editor, id)).toBe("M0 0L100 0");
    click(ix, 150, 180);
    expect(ix.busy).toBe(true);
    // Clicking the first anchor closes the path and finishes.
    click(ix, 101, 102);
    expect(ix.busy).toBe(false);
    expect(props(editor, id)).toMatchObject({
      pathData: "M0 0L100 0L50 80Z",
      x: 100,
      y: 100,
      width: 100,
      height: 80,
      strokeAlign: "center",
      name: "Vector 1",
    });
    expect(editor.s.tool).toBe("select");
    expect(editor.s.selection).toEqual([id]);
    editor.undo();
    expect(editor.doc.has(id)).toBe(false);
    editor.redo();
    expect(d(editor, id)).toBe("M0 0L100 0L50 80Z");
    expect(editor.history.canUndo).toBe(true);
    editor.undo();
    expect(editor.history.canUndo).toBe(false);
  });

  it("drags out mirrored handles for smooth anchors and finishes open paths with Enter", () => {
    click(ix, 0, 0);
    drag(ix, { x: 100, y: 0 }, { x: 100, y: 50 });
    click(ix, 200, 0);
    expect(ix.key(key("Enter"))).toBe(true);
    const [id] = editor.doc.childIds("p");
    const path = editor.pathOf(id as string);
    const mid = path?.[0]?.anchors[1];
    expect(path?.[0]?.closed).toBe(false);
    expect(mid && anchorKind(mid)).toBe("mirrored");
    // The handle points down (along the drag); the curve bulges below the line.
    expect(mid?.out?.y).toBeGreaterThan(mid?.y ?? 0);
    expect(getProp(props(editor, id as string), "height")).toBeGreaterThan(0);
  });

  it("snaps to 45° with Shift, and Backspace removes the last anchor", () => {
    click(ix, 0, 0);
    click(ix, 100, 90, { shift: true });
    click(ix, 300, 90);
    const [id] = editor.doc.childIds("p");
    expect(ix.key(key("Backspace"))).toBe(true);
    expect(d(editor, id as string)).toBe("M0 0L95 95");
    ix.key(key("Backspace"));
    expect(editor.doc.has(id as string)).toBe(false);
    ix.key(key("Escape"));
    expect(editor.s.tool).toBe("select");
    expect(ix.busy).toBe(false);
  });

  it("finishes the path when you switch tools", () => {
    click(ix, 0, 0);
    click(ix, 50, 50);
    editor.setTool("rect");
    expect(ix.busy).toBe(false);
    expect(editor.s.gesture).toBe(false);
  });
});

describe("Vector edit", () => {
  let editor: Editor;
  let ix: Interaction;
  let id: string;
  beforeEach(() => {
    editor = makeEditor();
    ix = new Interaction(editor);
    // A right triangle: (100,100) (200,100) (200,200).
    id = addPath(editor, "M0 0L100 0L100 100Z", 100, 100);
    editor.history.clear();
  });

  const enter = () => {
    click(ix, 190, 110);
    ix.down(at(190, 110, { clicks: 2 }));
    ix.up(at(190, 110, { clicks: 2 }));
    expect(editor.s.vectorEdit).toEqual({ id, anchors: [] });
  };

  it("enters on double-click or Enter, and leaves on Escape", () => {
    enter();
    expect(ix.key(key("Escape"))).toBe(true);
    expect(editor.s.vectorEdit).toBeNull();
    expect(editor.s.selection).toEqual([id]);
    expect(ix.key(key("Enter"))).toBe(true);
    expect(editor.s.vectorEdit?.id).toBe(id);
    // Selecting something else leaves it.
    editor.select([]);
    expect(editor.s.vectorEdit).toBeNull();
  });

  it("drags an anchor and re-fits the box, as one undo step", () => {
    enter();
    drag(ix, { x: 200, y: 200 }, { x: 250, y: 220 });
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:2"]);
    expect(props(editor, id)).toMatchObject({
      pathData: "M0 0L100 0L150 120Z",
      x: 100,
      y: 100,
      width: 150,
      height: 120,
    });
    editor.undo();
    expect(props(editor, id)).toMatchObject({ pathData: "M0 0L100 0L100 100Z", width: 100 });
    expect(editor.history.canUndo).toBe(false);
  });

  it("snaps a dragged anchor onto another anchor", () => {
    enter();
    drag(ix, { x: 200, y: 200 }, { x: 203, y: 104 });
    const path = editor.pathOf(id);
    expect(path?.[0]?.anchors[2]).toMatchObject({ x: 100, y: 0 });
  });

  it("keeps the shape still when an edit moves the top-left corner", () => {
    enter();
    drag(ix, { x: 100, y: 100 }, { x: 60, y: 40 });
    expect(props(editor, id)).toMatchObject({ x: 60, y: 40, width: 140, height: 160 });
    // The other two anchors haven't moved on the page.
    expect(screenOf(editor, id, editor.pathOf(id)?.[0]?.anchors[1] ?? { x: 0, y: 0 })).toEqual({
      x: 200,
      y: 100,
    });
  });

  it("adds an anchor by clicking a segment, deletes it with Backspace", () => {
    enter();
    click(ix, 150, 100);
    expect(editor.pathOf(id)?.[0]?.anchors).toHaveLength(4);
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:1"]);
    expect(ix.key(key("Backspace"))).toBe(true);
    expect(d(editor, id)).toBe("M0 0L100 0L100 100Z");
    expect(editor.doc.has(id)).toBe(true);
  });

  it("toggles corner and smooth on double-click", () => {
    enter();
    ix.down(at(200, 100, { clicks: 2 }));
    ix.up(at(200, 100, { clicks: 2 }));
    const a = editor.pathOf(id)?.[0]?.anchors[1];
    expect(a && anchorKind(a)).toBe("mirrored");
  });

  it("drags handles mirrored, and Alt breaks the mirror", () => {
    editor.setPath(id, parsePath("M0 0C50 -50 100 -50 150 0C200 50 250 50 300 0"));
    editor.select([id]);
    editor.enterVectorEdit(id);
    const start = editor.pathOf(id)?.[0]?.anchors[1];
    if (!start?.out || !start.in) throw new Error("expected a smooth anchor");
    // The box was re-fitted to the curve: work in screen coordinates.
    const p = screenOf(editor, id, start);
    click(ix, p.x, p.y);
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:1"]);
    const out = screenOf(editor, id, start.out);
    drag(ix, out, { x: out.x + 20, y: out.y + 30 });
    let a = editor.pathOf(id)?.[0]?.anchors[1];
    expect(a && anchorKind(a)).toBe("mirrored");
    const outNow = screenOf(editor, id, a?.out ?? { x: 0, y: 0 });
    const inBefore = screenOf(editor, id, a?.in ?? { x: 0, y: 0 });
    drag(ix, outNow, { x: outNow.x + 30, y: outNow.y - 40 }, { alt: true });
    a = editor.pathOf(id)?.[0]?.anchors[1];
    expect(a && anchorKind(a)).toBe("free");
    const inAfter = screenOf(editor, id, a?.in ?? { x: 0, y: 0 });
    expect(inAfter.x).toBeCloseTo(inBefore.x, 2);
    expect(inAfter.y).toBeCloseTo(inBefore.y, 2);
  });

  it("marquee-selects anchors and nudges them with the arrow keys", () => {
    enter();
    drag(ix, { x: 80, y: 80 }, { x: 210, y: 110 });
    expect(editor.s.marquee).toBeNull();
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:0", "0:1"]);
    expect(ix.key(key("ArrowUp", { shift: true }))).toBe(true);
    expect(props(editor, id)).toMatchObject({ y: 90, height: 110 });
    editor.undo();
    expect(props(editor, id)).toMatchObject({ y: 100, height: 100 });
  });

  it("leaves vector edit on a click away from the shape", () => {
    enter();
    click(ix, 400, 400);
    expect(editor.s.vectorEdit).toBeNull();
  });

  it("keeps the anchor selection valid after undo", () => {
    enter();
    click(ix, 150, 100);
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:1"]);
    ix.key(key("ArrowDown"));
    editor.undo(); // the nudge
    editor.undo(); // the added anchor
    expect(editor.pathOf(id)?.[0]?.anchors).toHaveLength(3);
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:1"]);
    editor.selectAnchors(["0:3"]);
    editor.commit([{ op: "set", id, prop: "name", value: "Leaf" }]);
    expect(editor.s.vectorEdit?.anchors).toEqual([]);
  });
});

describe("Resizing paths", () => {
  it("scales path data with the box, from handles or the inspector", () => {
    const editor = makeEditor();
    const ix = new Interaction(editor);
    const id = addPath(editor, "M0 0L100 0L100 100Z", 100, 100);
    editor.select([id]);
    drag(ix, { x: 200, y: 200 }, { x: 300, y: 250 });
    expect(props(editor, id)).toMatchObject({ width: 200, height: 150 });
    expect(d(editor, id)).toBe("M0 0L200 0L200 150Z");
    // Through zero and back: the shape survives because the drag scales from its start.
    drag(ix, { x: 300, y: 250 }, { x: 100, y: 250 }, {}, 4);
    drag(ix, { x: 100, y: 250 }, { x: 150, y: 250 }, {}, 2);
    expect(pathBounds(parsePath(d(editor, id)))?.width).toBeCloseTo(
      getProp(props(editor, id), "width"),
      2,
    );
    editor.setProp([id], "width", 40);
    expect(pathBounds(parsePath(d(editor, id)))?.width).toBe(40);
    editor.undo();
    expect(getProp(props(editor, id), "width")).not.toBe(40);
  });
});

describe("Flatten", () => {
  it("turns a rotated rounded rectangle into the same shape as a path", () => {
    const editor = makeEditor();
    const rect = editor.createLayer("rect", { x: 10, y: 20, width: 100, height: 50 }, "p", {
      rotation: 30,
      cornerRadius: 10,
      strokes: [{ type: "solid", color: "#0f766e" }],
      strokeWeight: 4,
    }) as string;
    const before = editor.scene.corners(rect);
    editor.select([rect]);
    expect(editor.flatten()).toBe(true);
    const [id] = editor.s.selection;
    const node = editor.doc.get(id as string);
    expect(node?.type).toBe("path");
    expect(node?.props).toMatchObject({
      name: "Rectangle 1",
      rotation: 30,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      strokeWeight: 4,
    });
    // Inside stroke kept, so it looks the same.
    expect(getProp(node?.props ?? {}, "strokeAlign")).toBe("inside");
    expect(editor.scene.corners(id as string)).toEqual(before);
    expect(editor.doc.childIds("p")).toEqual([id]);
    editor.undo();
    expect(editor.doc.get(rect)?.type).toBe("rect");
    expect(editor.doc.childIds("p")).toEqual([rect]);
  });

  it("converts ellipses and lines, and leaves frames with content alone", () => {
    const editor = makeEditor();
    const e = editor.createLayer("ellipse", { x: 0, y: 0, width: 80, height: 40 }, "p") as string;
    const l = editor.createLayer("line", { x: 0, y: 100, width: 120, height: 0 }, "p") as string;
    const f = editor.createLayer("frame", { x: 200, y: 0, width: 100, height: 100 }, "p") as string;
    editor.createLayer("rect", { x: 210, y: 10, width: 10, height: 10 }, f);
    editor.select([e, l, f]);
    editor.flatten();
    const types = editor.doc.childIds("p").map((id) => editor.doc.get(id)?.type);
    expect(types).toEqual(["path", "path", "frame"]);
    const line = editor.doc.get(editor.doc.childIds("p")[1] as string);
    expect(line?.props).toMatchObject({ pathData: "M0 0L120 0", strokeAlign: "center" });
  });
});

describe("Booleans", () => {
  /** Concatenates operands, so tests can see exactly what reached the engine. */
  function fake() {
    const calls: Array<{ operands: readonly BooleanOperand[]; op: string }> = [];
    const engine: BooleanEngine = {
      combine(operands, op) {
        calls.push({ operands, op });
        return { d: operands.map((o) => o.d).join(""), fillRule: "evenodd" };
      },
    };
    return { engine, calls };
  }

  it("combines shapes into one path at the top operand's z-position", async () => {
    const { engine, calls } = fake();
    const editor = makeEditor(engine);
    const below = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    const a = editor.createLayer("rect", { x: 100, y: 100, width: 50, height: 50 }, "p", {
      fills: [{ type: "solid", color: "#0f766e" }],
    }) as string;
    const between = editor.createLayer(
      "rect",
      { x: 0, y: 300, width: 5, height: 5 },
      "p",
    ) as string;
    const b = editor.createLayer(
      "ellipse",
      { x: 120, y: 120, width: 60, height: 40 },
      "p",
    ) as string;
    const above = editor.createLayer("rect", { x: 0, y: 400, width: 5, height: 5 }, "p") as string;
    editor.history.clear();
    editor.select([b, a]);
    expect(editor.canBoolean()).toBe(true);
    expect(await editor.booleanOp("union")).toBe(true);
    expect(calls[0]?.op).toBe("union");
    // Bottom first, in the parent's coordinates.
    expect(calls[0]?.operands[0]?.d).toBe("M100 100L150 100L150 150L100 150Z");
    const [id] = editor.s.selection;
    expect(editor.doc.childIds("p")).toEqual([below, between, id, above]);
    expect(editor.doc.get(id as string)?.props).toMatchObject({
      name: "Union",
      windingRule: "evenodd",
      fills: [{ type: "solid", color: "#0f766e" }],
      x: 100,
      y: 100,
      width: 80,
      height: 60,
    });
    expect(editor.doc.has(a) || editor.doc.has(b)).toBe(false);
    editor.undo();
    expect(editor.doc.childIds("p")).toEqual([below, a, between, b, above]);
    expect(editor.history.canUndo).toBe(false);
  });

  it("expands groups and works in a rotated frame's space", async () => {
    const { engine, calls } = fake();
    const editor = makeEditor(engine);
    const frame = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 400 }, "p", {
      rotation: 90,
    }) as string;
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, frame) as string;
    const b = editor.createLayer("rect", { x: 20, y: 0, width: 10, height: 10 }, frame) as string;
    const c = editor.createLayer("rect", { x: 40, y: 0, width: 10, height: 10 }, frame) as string;
    editor.select([b, c]);
    editor.group();
    const group = editor.s.selection[0] as string;
    editor.select([a, group]);
    // Operands are in the frame's own (unrotated) space, bottom first.
    const box = (id: string) => {
      const p = props(editor, id);
      const [x, y] = [getProp(p, "x"), getProp(p, "y")];
      return `M${x} ${y}L${x + 10} ${y}L${x + 10} ${y + 10}L${x} ${y + 10}Z`;
    };
    const expected = [box(a), box(b), box(c)];
    const before = editor.scene.unionBounds([a, group]);
    expect(await editor.booleanOp("subtract")).toBe(true);
    expect(calls[0]?.operands).toHaveLength(3);
    expect(calls[0]?.operands.map((o) => o.d)).toEqual(expected);
    const result = editor.doc.get(editor.s.selection[0] as string);
    expect(result?.parent).toBe(frame);
    // The fake engine returns all three; on the page they cover what the operands did.
    expect(result?.props).toMatchObject({ name: "Subtract", width: 10, height: 50 });
    const after = editor.scene.bounds(result?.id ?? "");
    for (const k of ["x", "y", "width", "height"] as const)
      expect(after?.[k]).toBeCloseTo(before?.[k] ?? Number.NaN, 6);
  });

  it("asks for two or more shapes", async () => {
    const { engine } = fake();
    const editor = makeEditor(engine);
    const a = editor.createLayer("rect", { x: 0, y: 0, width: 10, height: 10 }, "p") as string;
    editor.select([a]);
    expect(editor.canBoolean()).toBe(false);
    expect(await editor.booleanOp("union")).toBe(false);
    expect(editor.s.notice?.text).toBe("Select two or more shapes to combine.");
  });

  describe("with PathKit (WASM, as in the browser)", () => {
    const require = createRequire(import.meta.url);
    const wasm = join(dirname(require.resolve("pathkit-wasm")), "pathkit.wasm");
    const load = () => loadPathKitEngine({ wasmBinary: readFileSync(wasm) });

    async function combine(op: "union" | "subtract" | "intersect" | "exclude") {
      const editor = makeEditor(await load());
      const a = editor.createLayer("rect", { x: 0, y: 0, width: 100, height: 100 }, "p") as string;
      const b = editor.createLayer(
        "ellipse",
        { x: 50, y: 0, width: 100, height: 100 },
        "p",
      ) as string;
      editor.select([a, b]);
      expect(await editor.booleanOp(op)).toBe(true);
      const node = editor.doc.get(editor.s.selection[0] as string);
      if (!node) throw new Error("no result");
      const hit = (x: number, y: number) =>
        hitPathData(getProp(node.props, "pathData"), editor.scene.toLocal(node.id, { x, y }), {
          fill: true,
          fillRule: getProp(node.props, "windingRule"),
          strokeReach: 0,
        });
      return { node, hit };
    }

    it("unions, keeping curves", async () => {
      const { node, hit } = await combine("union");
      expect(node.props).toMatchObject({ x: 0, y: 0, width: 150, height: 100 });
      expect(getProp(node.props, "pathData")).toContain("C");
      expect(hit(25, 50)).toBe(true);
      expect(hit(140, 50)).toBe(true);
      expect(hit(140, 5)).toBe(false);
    });

    it("subtracts, intersects and excludes", async () => {
      const sub = await combine("subtract");
      expect(sub.node.props).toMatchObject({ x: 0, width: 100 });
      expect(sub.hit(25, 50)).toBe(true);
      expect(sub.hit(75, 50)).toBe(false);
      const inter = await combine("intersect");
      expect(inter.node.props).toMatchObject({ x: 50, width: 50, height: 100 });
      expect(inter.hit(75, 50)).toBe(true);
      expect(inter.hit(25, 50)).toBe(false);
      const ex = await combine("exclude");
      expect(ex.node.props).toMatchObject({ x: 0, width: 150 });
      expect(ex.hit(25, 50)).toBe(true);
      expect(ex.hit(75, 50)).toBe(false);
      expect(ex.hit(140, 50)).toBe(true);
    });
  });
});

describe("Performance", () => {
  it("handles pointer moves on a 500-anchor path well inside a 60 fps frame", () => {
    const editor = makeEditor();
    const ix = new Interaction(editor);
    // A wavy ring of 500 smooth anchors.
    const n = 500;
    const pts = Array.from({ length: n }, (_, k) => {
      const t = (k / n) * Math.PI * 2;
      const r = 300 + 20 * Math.sin(t * 25);
      return { x: 400 + r * Math.cos(t), y: 400 + r * Math.sin(t), t };
    });
    const dPath = `M${pts
      .map((p, k) => {
        const q = pts[(k + 1) % n] ?? p;
        const c1 = { x: p.x - 8 * Math.sin(p.t), y: p.y + 8 * Math.cos(p.t) };
        const c2 = { x: q.x + 8 * Math.sin(q.t), y: q.y - 8 * Math.cos(q.t) };
        return k === 0 ? `${p.x} ${p.y}` : `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`;
      })
      .join(" ")}Z`;
    const id = addPath(editor, dPath, 0, 0);
    editor.select([id]);
    editor.enterVectorEdit(id);
    const first = editor.pathOf(id)?.[0]?.anchors[0];
    if (!first) throw new Error("no anchors");
    const start = screenOf(editor, id, first);
    // Hover (nearest segment search on every move).
    let t0 = performance.now();
    for (let k = 0; k < 120; k++) ix.move(at(400 + k, 90 + (k % 7)));
    const hover = (performance.now() - t0) / 120;
    // Drag one anchor: recompute, fit, serialize and commit every move.
    ix.down(at(start.x, start.y));
    t0 = performance.now();
    for (let k = 1; k <= 120; k++) ix.move(at(start.x + k, start.y + k / 2));
    const dragMs = (performance.now() - t0) / 120;
    ix.up(at(start.x + 120, start.y + 60));
    console.log(
      `500-anchor path: hover ${hover.toFixed(2)} ms/move, anchor drag ${dragMs.toFixed(2)} ms/move`,
    );
    expect(hover).toBeLessThan(16);
    expect(dragMs).toBeLessThan(16);
    expect(editor.history.canUndo).toBe(true);
  });
});
