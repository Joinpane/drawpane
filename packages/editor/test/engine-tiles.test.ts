/**
 * Board textures (decision 0040, phase 2): the engine's tiles never show a stale picture after
 * what changes them from the editor's side: a saved glyph set edited, faces arriving, an image
 * loading, a page switch. Each change is made with tiles already drawn (warm), then a frame at
 * rest must be exact and bitwise a fresh engine's.
 */
import { type EngineModule, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { glyphKey, keyBetween, type Op, ROOT_ID } from "@drawpane/model";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

  describe("text whose face is", () => {
    /** Two texts: one in a face that's loading (until `arrive`), one in a face at hand. */
    function faces(engineShaping = false) {
      const doc = page();
      for (const [id, family, y] of [
        ["late", "Late", 4],
        ["stable", "Stable", 44],
      ] as const)
        doc.apply([
          {
            op: "create",
            id,
            type: "text",
            parent: "p",
            key: id === "late" ? "a0" : "a1",
            props: {
              x: 8,
              y,
              width: 70,
              height: 30,
              characters: "A",
              fontSize: 20,
              fontFamily: family,
            },
          },
        ]);
      let status: "loading" | "ready" | "unavailable" = "loading";
      let faceGeneration = 0;
      const shaped = {
        glyphs: [{ path: null, d: "M0 0H500V800H0Z", x: 0, y: 0, cluster: 0 }],
        width: 16,
        scale: 0.02,
      };
      const m: TextMeasurer = {
        ...measurer,
        missing: () => false,
        get generation() {
          return faceGeneration;
        },
        get faceGeneration() {
          return faceGeneration;
        },
        shape: (_text, run) => (run.family === "Late" && status !== "ready" ? null : shaped),
        loading: (run) => (run.family === "Late" && status === "loading" ? "face:Late" : null),
        faceStatus: () => status,
        ...(engineShaping
          ? {
              shapeForEngine: (_text, run) => {
                if (run.family !== "Late" || status === "ready") return { shaped, fallback: false };
                if (status === "loading") return { waiting: "face:Late" };
                return { shaped: { ...shaped, scale: shaped.scale / 2 }, fallback: true };
              },
            }
          : {}),
      };
      const settle = (to: "ready" | "unavailable") => {
        status = to;
        faceGeneration++;
      };
      return { doc, m, settle };
    }

    it("loading draws provisional, never on the canvas renderer, and only it is sent again when it arrives", () => {
      const { doc, m, settle } = faces();
      const scene = new Scene(doc);
      const builder = new DisplayListBuilder(scene, m);
      const e = new RenderEngine(mod);
      try {
        expect(e.apply(builder.build("p")).ok).toBe(true);
        // Waiting for its face: provisional (bars), the page still the engine's.
        expect(builder.supported).toBe(true);
        expect(builder.waiting).toBe(1);
        const r = e.renderCpuTiled(W, H, camera, BG, TILES);
        if (!r.ok) throw new Error(r.message);
        expect(r.value.stats.exact).toBe(false);
        // Nothing changes until the face arrives.
        expect(builder.update()).toBeNull();
        settle("ready");
        const patch = builder.update();
        expect(patch).not.toBeNull();
        // Only the text that waited, not the one in a face at hand.
        expect(builder.stats.records).toBe(1);
        if (patch) expect(e.apply(patch).ok).toBe(true);
        expect(builder.waiting).toBe(0);
        expect(same(tiled(e), fresh(mod, scene, m))).toBe(true);
      } finally {
        e.dispose();
      }
    });

    it.each(["fresh", "sliced"])(
      "finishes a %s open with counted fallback outlines when a face never arrives",
      (kind) => {
        const { doc, m, settle } = faces(kind === "sliced");
        const scene = new Scene(doc);
        const builder = new DisplayListBuilder(scene, m);
        const e = new RenderEngine(mod);
        try {
          if (kind === "sliced") {
            do {
              expect(e.apply(builder.openSlice("p")).ok).toBe(true);
            } while (builder.opening);
            expect(builder.pending).toBe(2);
            expect(builder.waiting).toBe(0);
            const deferred = builder.update();
            if (!deferred) throw new Error("Expected deferred text");
            expect(e.apply(deferred).ok).toBe(true);
          } else {
            expect(e.apply(builder.build("p")).ok).toBe(true);
          }
          expect(builder.waiting).toBe(1);
          settle("unavailable");
          const patch = builder.update();
          expect(patch).not.toBeNull();
          if (patch) expect(e.apply(patch).ok).toBe(true);
          expect(builder.supported).toBe(true);
          expect(builder.waiting).toBe(0);
          expect(builder.unsupported.size).toBe(1);
          expect(builder.update()).toBeNull();
          const r = e.renderCpuTiled(W, H, camera, BG, TILES);
          if (!r.ok) throw new Error(r.message);
          expect(r.value.stats.exact).toBe(true);
          expect(same(tiled(e), fresh(mod, scene, m))).toBe(true);

          settle("ready");
          const late = builder.update();
          expect(late).not.toBeNull();
          if (late) expect(e.apply(late).ok).toBe(true);
          expect(builder.unsupported.size).toBe(0);
          expect(same(tiled(e), fresh(mod, scene, m))).toBe(true);
        } finally {
          e.dispose();
        }
      },
    );

    it("at hand is left alone when other faces arrive", () => {
      const { doc, m, settle } = faces();
      const scene = new Scene(doc);
      const builder = new DisplayListBuilder(scene, m);
      const e = new RenderEngine(mod);
      try {
        expect(e.apply(builder.build("p")).ok).toBe(true);
        settle("ready");
        const patch = builder.update();
        if (patch) expect(e.apply(patch).ok).toBe(true);
        // A face nobody waits for arriving sends nothing.
        settle("ready");
        expect(builder.update()).toBeNull();
      } finally {
        e.dispose();
      }
    });
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
      const old = tiled(e);
      expect(e.apply(builder.build("q")).ok).toBe(true);
      // Moving, no budget: the last page's frame doesn't stand in. The first frame of a page
      // just shown is coarse tiles of it (a stand-in), then frames at rest draw it exactly.
      const r = e.renderCpuTiled(W, H, camera, BG, { ...TILES, moving: true, maxJobs: 0 });
      if (!r.ok) throw new Error(r.message);
      expect(r.value.stats.exact).toBe(false);
      expect(same(r.value.pixels, old)).toBe(false);
      let exact: Uint8Array | null = null;
      for (let i = 0; i < 40 && !exact; i++) {
        const f = e.renderCpuTiled(W, H, camera, BG, { ...TILES, maxJobs: 1 });
        if (!f.ok) throw new Error(f.message);
        if (f.value.stats.exact) exact = f.value.pixels;
      }
      if (!exact) throw new Error("never exact at rest");
      expect(same(exact, fresh(mod, scene, measurer, "q"))).toBe(true);
    } finally {
      e.dispose();
    }
  });
});

describe.skipIf(!built("worker") && !process.env.CI)("the builder's drags", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  for (const compactCopies of [false, true])
    it(`sends a layer's move as a move alone${compactCopies ? " (compact copies)" : ""}`, () => {
      // Compact copies name a moved layer's parent among the changes: its children are as they
      // were, so neither its order nor its record goes, and the engine sees a drag.
      const doc = new Doc({ compactCopies });
      doc.apply([
        { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
        {
          op: "create",
          id: "card",
          type: "frame",
          parent: "p",
          key: "a0",
          props: {
            width: 90,
            height: 70,
            clipContent: true,
            fills: [{ type: "solid", color: "#ffffff" }],
          },
        },
        {
          op: "create",
          id: "r",
          type: "rect",
          parent: "card",
          key: "a0",
          props: {
            x: 10,
            y: 10,
            width: 30,
            height: 20,
            fills: [{ type: "solid", color: "#7048e8" }],
          },
        },
      ]);
      const builder = new DisplayListBuilder(new Scene(doc), measurer);
      const e = new RenderEngine(mod);
      try {
        expect(e.apply(builder.build("p")).ok).toBe(true);
        for (let i = 1; i <= 3; i++) {
          doc.apply([
            { op: "set", id: "r", prop: "x", value: 10 + i * 7 },
            { op: "set", id: "r", prop: "y", value: 10 + i * 3 },
          ]);
          const patch = builder.update();
          if (!patch) throw new Error("no patch for a move");
          expect(e.apply(patch).ok).toBe(true);
          expect(builder.stats.records).toBe(0);
          expect(e.dragging).toBe("composited");
        }
        // A real change of children still sends the parent's order (and ends the drag).
        doc.apply([
          {
            op: "create",
            id: "s",
            type: "rect",
            parent: "card",
            key: "a1",
            props: { width: 10, height: 10, fills: [{ type: "solid", color: "#000000" }] },
          },
        ]);
        const patch = builder.update();
        if (!patch) throw new Error("no patch for a new layer");
        expect(e.apply(patch).ok).toBe(true);
        expect(e.dragging).toBe("none");
        expect(e.children(1).ok).toBe(true);
      } finally {
        e.dispose();
      }
    });
});

describe.skipIf(!built("worker") && !process.env.CI)("a page opening", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  it("sends its text provisional first, then whole, ending as a full build draws it", () => {
    const doc = page();
    const shaping: TextMeasurer = { ...measurer, missing: () => false };
    for (let i = 0; i < 6; i++)
      doc.apply([
        {
          op: "create",
          id: `t${i}`,
          type: "text",
          parent: "p",
          key: `a${i}`,
          props: {
            x: 4 + (i % 3) * 30,
            y: 4 + Math.floor(i / 3) * 36,
            width: 28,
            height: 30,
            characters: "Hi",
            fontSize: 20,
          },
        },
      ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, shaping);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(builder.build("p", undefined, { deferText: true })).ok).toBe(true);
      expect(builder.pending).toBe(6);
      // Coarse bars only, for now: a stand-in.
      const first = e.renderCpuTiled(W, H, camera, BG, TILES);
      if (!first.ok) throw new Error(first.message);
      expect(first.value.stats.exact).toBe(false);
      for (let i = 0; i < 20 && builder.pending > 0; i++) {
        const patch = builder.update();
        if (patch) expect(e.apply(patch).ok).toBe(true);
      }
      expect(builder.pending).toBe(0);
      expect(same(tiled(e), fresh(mod, scene, shaping))).toBe(true);
    } finally {
      e.dispose();
    }
  });
});

describe("text sent whole after a page opens", () => {
  /** A page of `n` text layers in a grid of 20 columns, 50 units apart. */
  function grid(n: number): Doc {
    const doc = page();
    const ops: Op[] = [];
    let key: string | null = null;
    for (let i = 0; i < n; i++) {
      key = keyBetween(key, null);
      ops.push({
        op: "create",
        id: `t${i}`,
        type: "text",
        parent: "p",
        key,
        props: {
          x: (i % 20) * 50,
          y: Math.floor(i / 20) * 50,
          width: 40,
          height: 40,
          characters: "Hi",
          fontSize: 20,
        },
      });
    }
    doc.apply(ops);
    return doc;
  }

  it("finds what's in view once a layer however often the view moves, never in a getter", () => {
    // A fit, then a pan a frame while the text is still to come: each view used to sort the
    // whole queue again (every layer's bounds) before the text's budget started.
    const n = 400;
    const scene = new Scene(grid(n));
    const builder = new DisplayListBuilder(scene, { ...measurer, missing: () => false });
    builder.build("p", undefined, { deferText: true });
    const bounds = vi.spyOn(scene, "bounds");
    for (let i = 0; i < 50; i++) {
      builder.setView({ x0: i * 5, y0: 0, x1: i * 5 + 200, y1: 200 });
      const asked = bounds.mock.calls.length;
      void builder.pendingVisible;
      expect(bounds.mock.calls.length).toBe(asked);
      builder.update(0);
    }
    expect(bounds.mock.calls.length).toBeLessThanOrEqual(n);
  });

  it("sends what's in view first", () => {
    const n = 400;
    const builder = new DisplayListBuilder(new Scene(grid(n)), {
      ...measurer,
      missing: () => false,
    });
    builder.build("p", undefined, { deferText: true });
    // The last row's last four layers.
    builder.setView({ x0: 800, y0: 950, x1: 1000, y1: 1000 });
    for (let i = 0; i < n && builder.pendingVisible > 0; i++) builder.update(0);
    expect(builder.pendingVisible).toBe(0);
    expect(n - builder.pending).toBe(4);
    for (let i = 0; i < 2 * n && builder.pending > 0; i++) builder.update(0);
    expect(builder.pending).toBe(0);
  });
});

describe.skipIf(!built("worker") && !process.env.CI)("a see-through text layer", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  it("covers where its lines overlap once, as one shape", () => {
    // Two lines set tighter than their glyphs (16 tall, 8 apart), at half alpha: Figma covers
    // the overlap once (`text-overlap` in the parity suites). Each line was a run of its own,
    // filled in turn, so the overlap was covered twice (alpha 192, not 128).
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "text",
        type: "text",
        parent: "p",
        key: "a0",
        props: {
          x: 10,
          y: 10,
          width: 40,
          height: 40,
          characters: "A\nA",
          fontSize: 20,
          lineHeight: { unit: "px", value: 8 },
          fills: [{ type: "solid", color: "#ff000080" }],
        },
      },
    ]);
    const shaping: TextMeasurer = { ...measurer, missing: () => false };
    const scene = new Scene(doc);
    const e = new RenderEngine(mod);
    try {
      expect(e.apply(new DisplayListBuilder(scene, shaping).build("p")).ok).toBe(true);
      const r = e.renderCpu(W, H, camera, [0, 0, 0, 0], false);
      if (!r.ok) throw new Error(r.message);
      const px = r.value.pixels;
      let most = 0;
      for (let i = 3; i < px.length; i += 4) most = Math.max(most, px[i] ?? 0);
      expect(Math.abs(most - 128)).toBeLessThanOrEqual(1);
    } finally {
      e.dispose();
    }
  });
});
