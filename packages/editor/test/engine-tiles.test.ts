/**
 * Board textures (decision 0040, phase 2): the engine's tiles never show a stale picture after
 * what changes them from the editor's side: a saved glyph set edited, faces arriving, an image
 * loading, a page switch. Each change is made with tiles already drawn (warm), then a frame at
 * rest must be exact and bitwise a fresh engine's.
 */
import { type EngineModule, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { glyphKey, ROOT_ID } from "@drawpane/model";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { DisplayListBuilder, type DisplayListOptions } from "../src/engine/display-list";
import { Scene } from "../src/scene";
import type { TextMeasurer } from "../src/text";

const W = 96;
const H = 80;
const BG: [number, number, number, number] = [1, 1, 1, 1];
const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };
const TILES = { tile: 32, slots: 64 };

const measurer: TextMeasurer = {
  missing: () => true,
  width: () => 16,
  shape: () => ({
    glyphs: [{ path: null, d: "M0 0H500V800H0Z", x: 0, y: 0, cluster: 0 }],
    width: 16,
    scale: 0.02,
  }),
};

function page(id = "p", key = "a0"): Doc {
  const doc = new Doc();
  doc.apply([{ op: "create", id, type: "page", parent: ROOT_ID, key, props: {} }]);
  return doc;
}

function addText(doc: Doc, props: Record<string, unknown> = {}): void {
  doc.apply([
    {
      op: "create",
      id: "text",
      type: "text",
      parent: "p",
      key: "a0",
      props: { x: 30, y: 30, width: 40, height: 40, characters: "A", fontSize: 20, ...props },
    },
  ]);
}

/** A frame at rest from the engine's tiles: exact, its pixels. */
function tiled(e: RenderEngine): Uint8Array {
  const r = e.renderCpuTiled(W, H, camera, BG, TILES);
  if (!r.ok) throw new Error(r.message);
  expect(r.value.stats.exact).toBe(true);
  return r.value.pixels;
}

/** What a fresh engine, given the whole page, draws from tiles. */
function fresh(
  mod: EngineModule,
  scene: Scene,
  m: TextMeasurer,
  pageId = "p",
  options: DisplayListOptions = {},
  setup: (e: RenderEngine) => void = () => {},
): Uint8Array {
  const e = new RenderEngine(mod);
  try {
    setup(e);
    expect(e.apply(new DisplayListBuilder(scene, m, options).build(pageId)).ok).toBe(true);
    return tiled(e);
  } finally {
    e.dispose();
  }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe.skipIf(!built("worker") && !process.env.CI)("the engine's tiles", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  it("redraw text whose saved glyph set changed", () => {
    const doc = page();
    const glyph = "0123456789abcdef";
    doc.apply([
      {
        op: "create",
        id: "outlines",
        type: "glyphSet",
        parent: ROOT_ID,
        key: "a1",
        props: { glyphOutlines: { [glyph]: "M0 0L300 0L300 800L0 800Z" } },
      },
    ]);
    addText(doc);
    const node = doc.get("text");
    if (!node) throw new Error("text fixture missing");
    doc.apply([
      {
        op: "set",
        id: "text",
        prop: "glyphLayout",
        value: { key: glyphKey(node.props), w: 40, h: 40, refs: [glyph], g: [0, 0, 24], size: 20 },
      },
    ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(builder.build("p")).ok).toBe(true);
      const before = tiled(e);
      doc.apply([
        {
          op: "set",
          id: "outlines",
          prop: "glyphOutlines",
          value: { [glyph]: "M0 0L900 0L900 800L0 800Z" },
        },
      ]);
      const patch = builder.update();
      if (patch) expect(e.apply(patch).ok).toBe(true);
      const after = tiled(e);
      const want = fresh(mod, scene, measurer);
      expect(same(before, want)).toBe(false);
      expect(same(after, want)).toBe(true);
    } finally {
      e.dispose();
    }
  });

  it("redraw text when faces arrive", () => {
    const doc = page();
    addText(doc);
    let generation = 0;
    let width = 300;
    const changing: TextMeasurer = {
      ...measurer,
      missing: () => false,
      get generation() {
        return generation;
      },
      shape: () => ({
        glyphs: [{ path: null, d: `M0 0H${width}V800H0Z`, x: 0, y: 0, cluster: 0 }],
        width: 16,
        scale: 0.02,
      }),
    };
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, changing);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(builder.build("p")).ok).toBe(true);
      const before = tiled(e);
      generation = 1;
      width = 900;
      const patch = builder.update();
      if (patch) expect(e.apply(patch).ok).toBe(true);
      const after = tiled(e);
      const want = fresh(mod, scene, changing);
      expect(same(before, want)).toBe(false);
      expect(same(after, want)).toBe(true);
    } finally {
      e.dispose();
    }
  });

  it("redraw an image fill once its image arrives", () => {
    const doc = page();
    const ref = "a".repeat(64);
    doc.apply([
      {
        op: "create",
        id: "image",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          x: 10,
          y: 12,
          width: 70,
          height: 50,
          fills: [{ type: "image", scaleMode: "stretch", ref }],
        },
      },
    ]);
    const pixels = new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const held = new Map<string, { handle: number; width: number; height: number }>();
    const options: DisplayListOptions = { image: (r) => held.get(r) ?? null };
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer, options);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(builder.build("p")).ok).toBe(true);
      // Loading: the checkerboard.
      const before = tiled(e);
      expect(e.putImage(1, 4, 4, pixels).ok).toBe(true);
      held.set(ref, { handle: 1, width: 4, height: 4 });
      builder.imageReady(ref);
      const patch = builder.update();
      if (patch) expect(e.apply(patch).ok).toBe(true);
      const after = tiled(e);
      const want = fresh(mod, scene, measurer, "p", options, (f) => {
        expect(f.putImage(1, 4, 4, pixels).ok).toBe(true);
      });
      expect(same(before, want)).toBe(false);
      expect(same(after, want)).toBe(true);
    } finally {
      e.dispose();
    }
  });

  it("show nothing of the last page after a page switch, even while moving", () => {
    const doc = page();
    doc.apply([
      { op: "create", id: "q", type: "page", parent: ROOT_ID, key: "a1", props: {} },
      {
        op: "create",
        id: "red",
        type: "rect",
        parent: "p",
        key: "a0",
        props: { width: 90, height: 70, fills: [{ type: "solid", color: "#ff0000" }] },
      },
      {
        op: "create",
        id: "blue",
        type: "rect",
        parent: "q",
        key: "a0",
        props: {
          x: 20,
          y: 20,
          width: 30,
          height: 30,
          fills: [{ type: "solid", color: "#0000ff" }],
        },
      },
    ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(builder.build("p")).ok).toBe(true);
      tiled(e);
      expect(e.apply(builder.build("q")).ok).toBe(true);
      // Moving, no budget: what nothing stands in for is drawn anyway, and the last page's frame
      // doesn't stand in.
      const r = e.renderCpuTiled(W, H, camera, BG, { ...TILES, moving: true, maxJobs: 0 });
      if (!r.ok) throw new Error(r.message);
      expect(r.value.stats.exact).toBe(true);
      expect(same(r.value.pixels, fresh(mod, scene, measurer, "q"))).toBe(true);
    } finally {
      e.dispose();
    }
  });
});
