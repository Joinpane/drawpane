import { keysBetween, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import { Editor } from "../src/editor";
import { placedGuides } from "../src/grids";
import { Interaction } from "../src/interaction";
import {
  frameLabelAt,
  frameLabelLayoutVersion,
  frameLabels,
  frameLabelsInRect,
} from "../src/labels";
import { componentSetIds, type OverlayTheme } from "../src/overlay";
import { OverlayRenderer, overlayStateChanged, type SpriteSurface } from "../src/overlay-renderer";
import type { TextMeasurer } from "../src/text";

const THEME: OverlayTheme = {
  signal: "#e0531f",
  componentInk: "#7a3fd1",
  onSignal: "#ffffff",
  guide: "#ff3366",
  onGuide: "#ffffff",
  component: "#7a3fd1",
  inkMuted: "#6b6a66",
  surfaceRaised: "#ffffff",
  xrayPadding: "#ffd36b",
  xrayGap: "#ff8ac2",
  presence: ["#2b4fd6"],
  onPresence: "#ffffff",
  agent: "#7c3aed",
  onAgent: "#ffffff",
  fontUi: "Instrument Sans",
};

interface RecordedOp {
  readonly kind: "clearRect" | "drawImage" | "fillText" | "stroke" | "strokeRect" | "fillRect";
  readonly args: readonly unknown[];
}

function makeMockSurface(
  width: number,
  height: number,
  withStyle = false,
  measureTextImpl?: (text: string) => Partial<TextMetrics> & { width: number },
): {
  surface: SpriteSurface;
  style: { transform: string };
  ops: RecordedOp[];
} {
  const ops: RecordedOp[] = [];
  const style = { transform: "" };
  const canvas = (withStyle
    ? { width, height, style }
    : { width, height }) as unknown as HTMLCanvasElement;
  const state: Record<string | symbol, unknown> = {
    canvas,
    strokeStyle: "#000",
    fillStyle: "#000",
    font: "",
    textBaseline: "alphabetic",
    textAlign: "start",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "clearRect") return (...args: number[]) => ops.push({ kind: "clearRect", args });
      if (key === "drawImage") return (...args: unknown[]) => ops.push({ kind: "drawImage", args });
      if (key === "fillText") return (...args: unknown[]) => ops.push({ kind: "fillText", args });
      if (key === "stroke") return () => ops.push({ kind: "stroke", args: [] });
      if (key === "strokeRect")
        return (...args: number[]) => ops.push({ kind: "strokeRect", args });
      if (key === "fillRect") return (...args: number[]) => ops.push({ kind: "fillRect", args });
      if (key === "measureText")
        return (text: string) =>
          measureTextImpl ? measureTextImpl(text) : { width: text.length * 6 };
      if (key === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { surface: { canvas, ctx }, style, ops };
}

function setupGrid(cols: number, rows: number) {
  let widthCalls = 0;
  let generation = 0;
  const measurer: TextMeasurer & { bump(): void } = {
    get generation() {
      return generation;
    },
    width(_font: string, text: string) {
      widthCalls++;
      return text.length * 6;
    },
    bump() {
      generation++;
    },
  };
  const editor = new Editor({ measurer, clientId: "t" });
  editor.state.set({
    role: "editor",
    viewport: { width: 1000, height: 600 },
    camera: new Camera(0, 0, 1),
  });
  const ops: Op[] = [
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ];
  const frameKeys = keysBetween(null, null, rows * cols);
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `f_${r}_${c}`;
      ops.push({
        op: "create",
        id,
        type: "frame",
        parent: "p1",
        key: frameKeys[idx++] as string,
        props: {
          x: c * 220 + 20,
          y: r * 140 + 40,
          width: 180,
          height: 100,
          name: `Card ${r}-${c}`,
        },
      });
      ops.push({
        op: "create",
        id: `rect_${r}_${c}`,
        type: "rect",
        parent: id,
        key: "a0",
        props: { x: 10, y: 10, width: 60, height: 40 },
      });
    }
  }
  editor.doc.apply(ops);
  editor.setPage("p1");
  return {
    editor,
    interaction: new Interaction(editor),
    measurer,
    getWidthCalls: () => widthCalls,
    resetWidthCalls: () => {
      widthCalls = 0;
    },
  };
}

describe("cached frame labels and auxiliary overlay indexes", () => {
  it("performs zero text measurements during same-zoom pan and nested edits, and updates on zoom, rename, and font load", () => {
    const { editor, measurer, getWidthCalls, resetWidthCalls } = setupGrid(6, 5);
    const initial = frameLabels(editor);
    expect(initial).toHaveLength(30);
    expect(getWidthCalls()).toBeGreaterThan(0);
    const v0 = frameLabelLayoutVersion(editor);

    // Same-zoom pan: zero measurer.width calls and layout version stays identical.
    resetWidthCalls();
    editor.state.set({ camera: editor.s.camera.pan(24, 12) });
    const panned = frameLabels(editor);
    expect(getWidthCalls()).toBe(0);
    expect(frameLabelLayoutVersion(editor)).toBe(v0);
    expect(panned[0]?.textX).toBe((initial[0]?.textX ?? 0) + 24);
    expect(panned[0]?.baseline).toBe((initial[0]?.baseline ?? 0) + 12);

    // Hit-testing uses the cached layout with zero extra measurements.
    const hit = frameLabelAt(editor, {
      x: (panned[0]?.box.x ?? 0) + 4,
      y: (panned[0]?.box.y ?? 0) + 4,
    });
    expect(hit?.id).toBe("f_0_0");
    expect(getWidthCalls()).toBe(0);

    // Editing a nested child inside a frame keeps label layout cached.
    editor.doc.apply([{ op: "set", id: "rect_0_0", prop: "x", value: 30 }]);
    expect(frameLabelLayoutVersion(editor)).toBe(v0);
    expect(frameLabels(editor)[0]?.name).toBe("Card 0-0");
    expect(getWidthCalls()).toBe(0);

    // Renaming a top-level frame invalidates and reflects immediately.
    editor.doc.apply([{ op: "set", id: "f_0_0", prop: "name", value: "Hero Artboard" }]);
    expect(frameLabelLayoutVersion(editor)).toBeGreaterThan(v0);
    expect(frameLabels(editor).find((l) => l.id === "f_0_0")?.name).toBe("Hero Artboard");

    // Zoom change recomputes truncation for narrow widths.
    const v1 = frameLabelLayoutVersion(editor);
    editor.state.set({ camera: new Camera(0, 0, 0.25) });
    expect(frameLabelLayoutVersion(editor)).toBeGreaterThan(v1);
    const zoomed = frameLabels(editor).find((l) => l.id === "f_0_0");
    expect(zoomed?.text).toContain("…");

    // Font generation bump invalidates cached widths.
    const v2 = frameLabelLayoutVersion(editor);
    resetWidthCalls();
    measurer.bump();
    expect(frameLabelLayoutVersion(editor)).toBeGreaterThan(v2);
    expect(getWidthCalls()).toBeGreaterThan(0);

    // Viewport rect culling returns only intersecting labels.
    editor.state.set({ camera: new Camera(0, 0, 1) });
    const clipped = frameLabelsInRect(editor, { x: 0, y: 0, width: 220, height: 150 });
    expect(clipped.map((l) => l.id)).toEqual(["f_0_0"]);
  });

  it("caches placedGuides and componentSetIds across unrelated nested edits", () => {
    const { editor } = setupGrid(3, 3);
    const guides1 = placedGuides(editor.scene, "p1");
    const sets1 = componentSetIds(editor.doc, "p1");
    expect(guides1).toEqual([]);
    expect(sets1).toEqual([]);

    editor.doc.apply([{ op: "set", id: "rect_0_0", prop: "width", value: 90 }]);
    expect(placedGuides(editor.scene, "p1")).toBe(guides1);
    expect(componentSetIds(editor.doc, "p1")).toBe(sets1);

    editor.doc.apply([{ op: "set", id: "f_0_0", prop: "isComponentSet", value: true }]);
    expect(componentSetIds(editor.doc, "p1")).toEqual(["f_0_0"]);
  });
});

describe("OverlayRenderer retained labels and transient dirty regions", () => {
  it("translates overscanned retained labels via CSS with zero canvas writes, packs one sprite atlas, and skips atlas churn on zoom", () => {
    const { editor, interaction } = setupGrid(5, 5);
    let createdSurfaces = 0;
    const renderer = new OverlayRenderer({
      overscanCss: 144,
      createSurface: (w, h) => {
        createdSurfaces++;
        return makeMockSurface(w, h).surface;
      },
    });

    const labels = makeMockSurface((1000 + 288) * 2, (600 + 288) * 2, true);
    const overlay = makeMockSurface(2000, 1200);

    // Frame 1: cold bake into overscanned label layer using a single shared sprite atlas.
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.labelFullDraws).toBe(1);
    expect(renderer.stats.labelSpriteMisses).toBeGreaterThan(0);
    expect(createdSurfaces).toBe(1);
    expect(labels.style.transform).toBe("");

    // Frame 2: identical state skips both layers with zero canvas operations.
    labels.ops.length = 0;
    overlay.ops.length = 0;
    renderer.resetStats();
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.labelSkipped).toBe(1);
    expect(renderer.stats.transientSkipped).toBe(1);
    expect(labels.ops).toHaveLength(0);
    expect(overlay.ops).toHaveLength(0);

    // Frame 3..20: same-zoom pans within overscan translate via CSS transform with ZERO canvas writes.
    labels.ops.length = 0;
    overlay.ops.length = 0;
    renderer.resetStats();
    editor.state.set({ camera: editor.s.camera.pan(6, 3) });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.labelTranslations).toBe(1);
    expect(renderer.stats.labelFullDraws).toBe(0);
    expect(renderer.stats.transientSkipped).toBe(1);
    expect(labels.ops).toHaveLength(0);
    expect(overlay.ops).toHaveLength(0);
    expect(labels.style.transform).toBe("translate3d(6px, 3px, 0)");

    // Panning past overscan re-anchors, resets transform, and reuses the warm sprite atlas (0 new misses).
    renderer.resetStats();
    editor.state.set({ camera: editor.s.camera.pan(200, 0) });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(labels.style.transform).toBe("");
    expect(renderer.stats.labelSpriteHits).toBeGreaterThan(0);
    expect(createdSurfaces).toBe(1);

    // Zooming draws directly onto labelsCtx without churning atlas sprites or creating new surfaces.
    labels.ops.length = 0;
    renderer.resetStats();
    editor.state.set({ camera: new Camera(0, 0, 0.5) });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.labelSpriteMisses).toBe(0);
    expect(createdSurfaces).toBe(1);
    expect(labels.ops.some((op) => op.kind === "fillText")).toBe(true);
  });

  it("clears only bounded dirty regions when selection, hover, marquee, or guides change", () => {
    const { editor, interaction } = setupGrid(4, 4);
    const renderer = new OverlayRenderer({
      overscanCss: 144,
      createSurface: (w, h) => makeMockSurface(w, h).surface,
    });
    const labels = makeMockSurface((1000 + 288) * 2, (600 + 288) * 2, true);
    const overlay = makeMockSurface(2000, 1200);
    const fullArea = 2000 * 1200;

    // Warm empty transient layer.
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    overlay.ops.length = 0;
    labels.ops.length = 0;
    renderer.resetStats();

    // Selecting one small nested rect skips labels completely and clears only a small dirty region on overlay.
    editor.state.set({ selection: ["rect_0_0"] });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.labelSkipped).toBe(1);
    expect(labels.ops).toHaveLength(0);
    expect(renderer.stats.transientDirtyClears).toBe(1);
    expect(renderer.stats.transientFullClears).toBe(0);
    expect(renderer.stats.transientClearedPixels).toBeGreaterThan(0);
    expect(renderer.stats.transientClearedPixels).toBeLessThan(fullArea * 0.15);

    // Moving hover from one rect to another clears only old+new tight dirty rects.
    renderer.resetStats();
    editor.state.set({ hover: "rect_1_1" });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.transientDirtyClears).toBe(1);
    expect(renderer.stats.transientFullClears).toBe(0);
    expect(renderer.stats.transientClearedPixels).toBeLessThan(fullArea * 0.25);

    // Clearing selection and hover clears only the previously dirty rects, then subsequent frames skip.
    renderer.resetStats();
    editor.state.set({ selection: [], hover: null });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.transientDirtyClears).toBe(1);
    expect(renderer.stats.transientFullClears).toBe(0);
    expect(renderer.stats.transientClearedPixels).toBeLessThan(fullArea * 0.25);

    overlay.ops.length = 0;
    renderer.resetStats();
    editor.state.set({ camera: editor.s.camera.pan(4, 2) });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 2);
    expect(renderer.stats.transientSkipped).toBe(1);
    expect(overlay.ops).toHaveLength(0);
  });

  it("ignores non-visual editor state updates in overlayStateChanged", () => {
    const { editor } = setupGrid(1, 1);
    const s0 = editor.s;
    editor.state.set({ canUndo: !s0.canUndo, pixelSnap: !s0.pixelSnap });
    expect(overlayStateChanged(s0, editor.s)).toBe(false);

    editor.state.set({ hover: "rect_0_0" });
    expect(overlayStateChanged(s0, editor.s)).toBe(true);
  });

  it("measures real wide collaborator name tag bounds so peer removal clears the full rendered tag", () => {
    const { editor, interaction } = setupGrid(1, 1);
    const renderer = new OverlayRenderer({
      overscanCss: 0,
      createSurface: (w, h) => makeMockSurface(w, h).surface,
    });
    // Simulate wide ligatures (e.g. 80x U+FDFD): 30 px per char = 2400 px rendered tag (> old 836 px heuristic).
    const measureWide = (text: string) => ({
      width: text.length * 30,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 30 + 2,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 4,
    });
    const labels = makeMockSurface(3000, 1000, true, measureWide);
    const overlay = makeMockSurface(3000, 1000, false, measureWide);

    const wideName = "\ufdfd".repeat(80);
    editor.state.set({
      peers: new Map([
        [
          "p-wide",
          {
            sessionId: "p-wide",
            userId: "u-wide",
            name: wideName,
            kind: "person",
            color: 1,
            presence: {
              pageId: "p1",
              cursor: { x: 80, y: 120 },
              selection: [],
            },
          },
        ],
      ]),
    });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 1);

    // Removing the peer must clear at least through x = 80 + 10 + 2400 + 10 = 2500 px.
    overlay.ops.length = 0;
    editor.state.set({ peers: new Map() });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 1);
    const clears = overlay.ops.filter((op) => op.kind === "clearRect");
    expect(clears.length).toBeGreaterThan(0);
    const maxRight = Math.max(
      ...clears.map((c) => Number(c.args[0] ?? 0) + Number(c.args[2] ?? 0)),
    );
    expect(maxRight).toBeGreaterThanOrEqual(2500);
  });

  it("tracks real glyph ink bounds for tall combining-mark labels across atlas, direct zoom, and rename clear", () => {
    const { editor, interaction } = setupGrid(1, 1);
    const tallName = `A${"\u030d".repeat(12)}`;
    editor.doc.apply([{ op: "set", id: "f_0_0", prop: "name", value: tallName }]);

    const measureTall = (text: string) => ({
      width: text.length * 6,
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: text.length * 6 + 4,
      actualBoundingBoxAscent: text === tallName ? 56 : 10,
      actualBoundingBoxDescent: text === tallName ? 14 : 4,
    });
    const renderer = new OverlayRenderer({
      overscanCss: 144,
      createSurface: (w, h) => makeMockSurface(w, h, false, measureTall).surface,
    });
    const labels = makeMockSurface(1288, 888, true, measureTall);
    const overlay = makeMockSurface(1000, 600, false, measureTall);

    // 1. Cold atlas bake must allocate tall enough sprite height (baseline 10, ascent 56 -> topPad >= 49).
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 1);
    const blits = labels.ops.filter((op) => op.kind === "drawImage");
    expect(blits.length).toBe(1);
    const spriteH = Number(blits[0]?.args[4] ?? 0);
    expect(spriteH).toBeGreaterThanOrEqual(70);

    // 2. Direct zoom draws directly; opening rename next must clear the full tall ink rect above the label box.
    editor.state.set({ camera: new Camera(0, 0, 1.25) });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 1);

    const frameBoxY = frameLabels(editor).find((l) => l.id === "f_0_0")?.box.y ?? 0;
    labels.ops.length = 0;
    editor.state.set({ renamingFrame: "f_0_0" });
    renderer.draw(labels.surface.ctx, overlay.surface.ctx, editor, interaction, THEME, 1);

    const clears = labels.ops.filter((op) => op.kind === "clearRect");
    expect(clears.length).toBeGreaterThan(0);
    const minClearY = Math.min(...clears.map((c) => Number(c.args[1] ?? Infinity)));
    const expectedInkTop = 144 + frameBoxY - (56 - 10);
    expect(minClearY).toBeLessThanOrEqual(expectedInkTop);
  });
});
