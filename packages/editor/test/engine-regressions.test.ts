import { type EngineModule, ErrorCode, RenderEngine, unsupportedNames } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { FLAG } from "@drawpane/engine/wire";
import { glyphKey, ROOT_ID } from "@drawpane/model";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { DisplayListBuilder } from "../src/engine/display-list";
import { encodeLayer } from "../src/engine/layer";
import { greekLines } from "../src/render";
import { Scene } from "../src/scene";
import type { TextMeasurer } from "../src/text";

const measurer: TextMeasurer = {
  missing: () => true,
  width: () => 16,
  shape: () => ({
    glyphs: [{ path: null, d: "M0 0H500V800H0Z", x: 0, y: 0, cluster: 0 }],
    width: 16,
    scale: 0.02,
  }),
};
const camera = { zoom: 1, x: 0, y: 0, dpr: 1 };

function page(): Doc {
  const doc = new Doc();
  doc.apply([{ op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} }]);
  return doc;
}

function addText(doc: Doc, props: Record<string, unknown>): void {
  doc.apply([
    {
      op: "create",
      id: "text",
      type: "text",
      parent: "p",
      key: "a0",
      props: { x: 4, y: 4, width: 40, height: 40, characters: "A", fontSize: 20, ...props },
    },
  ]);
}

describe("Document regressions (review of PR 216)", () => {
  it("bounds coarse geometry by actual text, even for a tall box", () => {
    const doc = page();
    addText(doc, { height: 80_000, textAutoResize: "none", lineHeight: { unit: "px", value: 1 } });
    const list = new DisplayListBuilder(new Scene(doc), measurer).build("p");
    expect(list.length).toBeLessThan(32 * 1024);
  });

  it("gives the canvas renderer the same few bars for it", () => {
    const doc = page();
    addText(doc, { height: 80_000, textAutoResize: "none", lineHeight: { unit: "px", value: 1 } });
    const node = doc.get("text");
    if (!node) throw new Error("text fixture missing");
    expect(greekLines(node, measurer).lines).toBe(1);
  });

  it("supports smoothed corners natively without flagging them unsupported", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "box",
        type: "rect",
        parent: "p",
        key: "a0",
        props: { width: 40, height: 40, cornerRadius: 10, cornerSmoothing: 0.6 },
      },
    ]);
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    builder.build("p");
    expect(unsupportedNames(builder.unsupported.get("box") ?? 0)).toEqual([]);
  });

  it("doesn't shape hidden text", () => {
    const doc = page();
    addText(doc, { visible: false });
    let shaped = 0;
    const counting: TextMeasurer = {
      ...measurer,
      missing: () => false,
      shape: (t, r) => {
        shaped++;
        return measurer.shape?.(t, r) ?? null;
      },
    };
    new DisplayListBuilder(new Scene(doc), counting).build("p");
    expect(shaped).toBe(0);
  });

  it("isolates a faded layer combining a backdrop reader with a visible fill or stroke", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "fadedBlurWithFill",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          width: 40,
          height: 40,
          opacity: 0.9,
          fills: [{ type: "solid", color: "#000000", blendMode: "screen" }],
          effects: [{ type: "background-blur", radius: 20 }],
        },
      },
      {
        op: "create",
        id: "fadedBlurOnly",
        type: "rect",
        parent: "p",
        key: "a1",
        props: {
          width: 40,
          height: 40,
          opacity: 0.9,
          fills: [],
          effects: [{ type: "background-blur", radius: 20 }],
        },
      },
      {
        op: "create",
        id: "opaqueBlurWithFill",
        type: "rect",
        parent: "p",
        key: "a2",
        props: {
          width: 40,
          height: 40,
          opacity: 1,
          fills: [{ type: "solid", color: "#ffffff33" }],
          effects: [{ type: "background-blur", radius: 20 }],
        },
      },
    ]);
    const scene = new Scene(doc);
    const ctx = {
      scene,
      measurer,
      hidden: new Set<string>(),
      whole: null,
      glyph: () => 1,
      image: () => undefined,
    };
    const flags = (id: string) => {
      const node = doc.get(id);
      if (!node) throw new Error(`missing ${id}`);
      return encodeLayer(node, ctx).record.flags;
    };
    expect((flags("fadedBlurWithFill") & FLAG.isolate) !== 0).toBe(true);
    expect((flags("fadedBlurOnly") & FLAG.isolate) !== 0).toBe(false);
    expect((flags("opaqueBlurWithFill") & FLAG.isolate) !== 0).toBe(false);
  });
});

describe.skipIf(!built())("Saved glyphs, images and revisions (review of PR 216)", () => {
  let module: EngineModule;
  beforeAll(async () => {
    module = await loadNodeEngine();
  });

  it("keeps a transparent image fill invisible while the asset loads", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "image",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          width: 32,
          height: 32,
          fills: [{ type: "image", scaleMode: "stretch", ref: "0".repeat(64), opacity: 0 }],
        },
      },
    ]);
    const engine = new RenderEngine(module);
    try {
      const list = new DisplayListBuilder(new Scene(doc), measurer).build("p");
      expect(engine.apply(list).ok).toBe(true);
      const frame = engine.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      if (!frame.ok) throw new Error(frame.message);
      expect(frame.value.pixels[3]).toBe(0);
    } finally {
      engine.dispose();
    }
  });

  it("matches a fresh build after a reparent, local move, reorder and ancestor deletion", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "a",
        type: "frame",
        parent: "p",
        key: "a0",
        props: { width: 28, height: 28, rotation: 15 },
      },
      {
        op: "create",
        id: "b",
        type: "frame",
        parent: "p",
        key: "a1",
        props: { x: 24, y: 10, width: 30, height: 30, rotation: -15, clipContent: true },
      },
      {
        op: "create",
        id: "red",
        type: "rect",
        parent: "a",
        key: "a0",
        props: { width: 20, height: 22, fills: [{ type: "solid", color: "#ff0000" }] },
      },
      {
        op: "create",
        id: "blue",
        type: "rect",
        parent: "b",
        key: "a1",
        props: { width: 20, height: 20, fills: [{ type: "solid", color: "#0000ff" }] },
      },
    ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const retained = new RenderEngine(module);
    const fresh = new RenderEngine(module);
    try {
      expect(retained.apply(builder.build("p")).ok).toBe(true);
      doc.apply([
        { op: "move", id: "red", parent: "b", key: "a2" },
        { op: "set", id: "red", prop: "x", value: 6 },
        { op: "move", id: "blue", parent: "b", key: "a3" },
        { op: "delete", id: "a" },
      ]);
      const patch = builder.update();
      if (!patch) throw new Error("fixture did not emit a patch");
      expect(retained.apply(patch).ok).toBe(true);
      expect(fresh.apply(new DisplayListBuilder(scene, measurer).build("p")).ok).toBe(true);
      const actual = retained.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      const expected = fresh.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      if (!actual.ok || !expected.ok) throw new Error("fixture did not render");
      expect(Buffer.from(actual.value.pixels).equals(expected.value.pixels)).toBe(true);
    } finally {
      retained.dispose();
      fresh.dispose();
    }
  });

  it("re-encodes text when only a referenced glyph set changes", () => {
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
    addText(doc, {});
    const node = doc.get("text");
    if (!node) throw new Error("text fixture missing");
    doc.apply([
      {
        op: "set",
        id: "text",
        prop: "glyphLayout",
        value: {
          key: glyphKey(node.props),
          w: 40,
          h: 40,
          refs: [glyph],
          g: [0, 0, 24],
          size: 20,
        },
      },
    ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const retained = new RenderEngine(module);
    const fresh = new RenderEngine(module);
    try {
      expect(retained.apply(builder.build("p")).ok).toBe(true);
      const before = retained.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      doc.apply([
        {
          op: "set",
          id: "outlines",
          prop: "glyphOutlines",
          value: { [glyph]: "M0 0L900 0L900 800L0 800Z" },
        },
      ]);
      const patch = builder.update();
      if (patch) expect(retained.apply(patch).ok).toBe(true);
      expect(fresh.apply(new DisplayListBuilder(scene, measurer).build("p")).ok).toBe(true);
      const actual = retained.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      const expected = fresh.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      if (!before.ok || !actual.ok || !expected.ok) throw new Error("fixture did not render");
      expect(Buffer.from(before.value.pixels).equals(expected.value.pixels)).toBe(false);
      expect(Buffer.from(actual.value.pixels).equals(expected.value.pixels)).toBe(true);
    } finally {
      retained.dispose();
      fresh.dispose();
    }
  });

  it("frees glyphs no record uses any more", () => {
    const doc = page();
    addText(doc, {});
    const scene = new Scene(doc);
    const shaping: TextMeasurer = { ...measurer, missing: () => false };
    const builder = new DisplayListBuilder(scene, shaping);
    const engine = new RenderEngine(module);
    try {
      expect(engine.apply(builder.build("p")).ok).toBe(true);
      expect(engine.glyphs.count).toBe(1);
      doc.apply([{ op: "delete", id: "text" }]);
      const patch = builder.update();
      if (!patch) throw new Error("no patch for the deletion");
      expect(engine.apply(patch).ok).toBe(true);
      expect(engine.glyphs.count).toBe(0);
    } finally {
      engine.dispose();
    }
  });

  it("answers a refused message with a fresh list past the engine's revision", () => {
    const doc = page();
    addText(doc, {});
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const engine = new RenderEngine(module);
    try {
      expect(engine.apply(builder.build("p")).ok).toBe(true);
      builder.acknowledge(true, engine.revision);
      doc.apply([{ op: "set", id: "text", prop: "x", value: 9 }]);
      // This patch never reaches the engine (lost): the next one is made for the wrong revision.
      builder.update();
      doc.apply([{ op: "set", id: "text", prop: "x", value: 12 }]);
      const stale = builder.update();
      if (!stale) throw new Error("no patch");
      const refused = engine.apply(stale);
      expect(refused).toMatchObject({ ok: false, code: ErrorCode.Revision });
      builder.acknowledge(false, engine.revision);
      const fresh = builder.update();
      if (!fresh) throw new Error("no fresh list");
      expect(builder.stats.fresh).toBe(true);
      expect(engine.apply(fresh).ok).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it("re-encodes text whose glyph set changed even when it also moved", () => {
    const doc = page();
    const glyph = "fedcba9876543210";
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
    addText(doc, {});
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
    const retained = new RenderEngine(module);
    const fresh = new RenderEngine(module);
    try {
      expect(retained.apply(builder.build("p")).ok).toBe(true);
      // The outline and the layer's place change before the next update.
      doc.apply([
        {
          op: "set",
          id: "outlines",
          prop: "glyphOutlines",
          value: { [glyph]: "M0 0L900 0L900 800L0 800Z" },
        },
        { op: "set", id: "text", prop: "x", value: 9 },
      ]);
      const patch = builder.update();
      if (patch) expect(retained.apply(patch).ok).toBe(true);
      expect(fresh.apply(new DisplayListBuilder(scene, measurer).build("p")).ok).toBe(true);
      const actual = retained.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      const expected = fresh.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      if (!actual.ok || !expected.ok) throw new Error("fixture did not render");
      expect(Buffer.from(actual.value.pixels).equals(expected.value.pixels)).toBe(true);
    } finally {
      retained.dispose();
      fresh.dispose();
    }
  });

  it("re-encodes text when faces arrive even when it also moved", () => {
    const doc = page();
    addText(doc, {});
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
    const retained = new RenderEngine(module);
    const fresh = new RenderEngine(module);
    try {
      expect(retained.apply(builder.build("p")).ok).toBe(true);
      // A face arrives (the glyph is wider) and the layer moves, before the next update.
      generation = 1;
      width = 900;
      doc.apply([{ op: "set", id: "text", prop: "x", value: 9 }]);
      const patch = builder.update();
      if (patch) expect(retained.apply(patch).ok).toBe(true);
      expect(fresh.apply(new DisplayListBuilder(scene, changing).build("p")).ok).toBe(true);
      const actual = retained.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      const expected = fresh.renderCpu(64, 64, camera, [0, 0, 0, 0], false);
      if (!actual.ok || !expected.ok) throw new Error("fixture did not render");
      expect(Buffer.from(actual.value.pixels).equals(expected.value.pixels)).toBe(true);
    } finally {
      retained.dispose();
      fresh.dispose();
    }
  });

  it("pulls in transitive backdrop inputs for contextual exports across stacked background blurs", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "bg",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 160,
          height: 100,
          fills: [{ type: "solid", color: "#000000" }],
        },
      },
      {
        op: "create",
        id: "stripe",
        type: "rect",
        parent: "p",
        key: "a1",
        props: {
          x: 52,
          y: 0,
          width: 12,
          height: 100,
          fills: [{ type: "solid", color: "#ffffff" }],
        },
      },
      {
        op: "create",
        id: "lowerBlur",
        type: "rect",
        parent: "p",
        key: "a2",
        props: {
          x: 68,
          y: 0,
          width: 25,
          height: 100,
          fills: [{ type: "solid", color: "#00000001" }],
          effects: [{ type: "background-blur", radius: 44 }],
        },
      },
      {
        op: "create",
        id: "upperBlur",
        type: "rect",
        parent: "p",
        key: "a3",
        props: {
          x: 80,
          y: 0,
          width: 60,
          height: 100,
          fills: [{ type: "solid", color: "#00000001" }],
          effects: [{ type: "background-blur", radius: 6 }],
        },
      },
    ]);
    const scene = new Scene(doc);
    const wholeEngine = new RenderEngine(module);
    const cropEngine = new RenderEngine(module);
    try {
      expect(wholeEngine.apply(new DisplayListBuilder(scene, measurer).build("p")).ok).toBe(true);
      expect(
        cropEngine.apply(
          new DisplayListBuilder(scene, measurer).buildLayers(["upperBlur"], { context: true }),
        ).ok,
      ).toBe(true);
      const whole = wholeEngine.renderCpu(160, 100, camera, [0, 0, 0, 0], false);
      const crop = cropEngine.renderCpu(160, 100, camera, [0, 0, 0, 0], false);
      if (!whole.ok || !crop.ok) throw new Error("render failed");
      const at = (px: Uint8Array) => {
        const i = (50 * 160 + 81) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
      };
      const wPx = at(whole.value.pixels);
      const cPx = at(crop.value.pixels);
      expect(wPx[0]).toBeGreaterThan(10);
      expect(cPx).toEqual(wPx);
    } finally {
      wholeEngine.dispose();
      cropEngine.dispose();
    }
  });

  it("falls back to uniform background blur when progressive fields are absent or degenerate", () => {
    const doc = page();
    doc.apply([
      {
        op: "create",
        id: "stripe",
        type: "rect",
        parent: "p",
        key: "a0",
        props: { x: 0, y: 0, width: 32, height: 64, fills: [{ type: "solid", color: "#ffffff" }] },
      },
      {
        op: "create",
        id: "bg",
        type: "rect",
        parent: "p",
        key: "a1",
        props: { x: 32, y: 0, width: 32, height: 64, fills: [{ type: "solid", color: "#000000" }] },
      },
      {
        op: "create",
        id: "blurLayer",
        type: "rect",
        parent: "p",
        key: "a2",
        props: {
          x: 0,
          y: 0,
          width: 64,
          height: 64,
          fills: [{ type: "solid", color: "#ffffff05" }],
          effects: [{ type: "background-blur", radius: 16 }],
        },
      },
    ]);
    const renderWith = (effects: unknown[]) => {
      doc.apply([{ op: "set", id: "blurLayer", prop: "effects", value: effects }]);
      const eng = new RenderEngine(module);
      try {
        expect(eng.apply(new DisplayListBuilder(new Scene(doc), measurer).build("p")).ok).toBe(
          true,
        );
        const r = eng.renderCpu(64, 64, camera, [0, 0, 0, 1], false);
        if (!r.ok) throw new Error(r.message);
        return r.value.pixels.slice();
      } finally {
        eng.dispose();
      }
    };
    const uniform = renderWith([{ type: "background-blur", radius: 16 }]);
    const missingOffsets = renderWith([
      { type: "background-blur", radius: 16, blurType: "progressive" },
    ]);
    const equalRadii = renderWith([
      {
        type: "background-blur",
        radius: 16,
        blurType: "progressive",
        startRadius: 16,
        startOffset: { x: 0.5, y: 0 },
        endOffset: { x: 0.5, y: 1 },
      },
    ]);
    const progressive = renderWith([
      {
        type: "background-blur",
        radius: 16,
        blurType: "progressive",
        startRadius: 0,
        startOffset: { x: 0.5, y: 0 },
        endOffset: { x: 0.5, y: 1 },
      },
    ]);
    expect(Buffer.from(missingOffsets).equals(Buffer.from(uniform))).toBe(true);
    expect(Buffer.from(equalRadii).equals(Buffer.from(uniform))).toBe(true);
    expect(Buffer.from(progressive).equals(Buffer.from(uniform))).toBe(false);
  });

  it("clips neighboring frames when selecting export backdrop context", () => {
    const doc = page();
    doc.apply([
      // Earlier sibling cell clipped at x=0..100, containing a child with an unsupported blend
      // that overflows past x=100 into the neighboring cell if unclipped.
      {
        op: "create",
        id: "neighbor",
        type: "frame",
        parent: "p",
        key: "a0",
        props: {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          clipContent: true,
          fills: [{ type: "solid", color: "#222222" }],
        },
      },
      {
        op: "create",
        id: "overflowBlend",
        type: "rect",
        parent: "neighbor",
        key: "a0",
        props: {
          x: 80,
          y: 0,
          width: 120,
          height: 100,
          blendMode: "color-dodge",
          fills: [{ type: "solid", color: "#ff0000" }],
        },
      },
      // Adjacent exported cell starting at x=120 with a background-blur whose reach reaches x=100.
      {
        op: "create",
        id: "exported",
        type: "frame",
        parent: "p",
        key: "a1",
        props: {
          x: 120,
          y: 0,
          width: 100,
          height: 100,
          clipContent: true,
          fills: [{ type: "solid", color: "#ffffff" }],
        },
      },
      {
        op: "create",
        id: "blurCard",
        type: "rect",
        parent: "exported",
        key: "a0",
        props: {
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          fills: [{ type: "solid", color: "#ffffff22" }],
          effects: [{ type: "background-blur", radius: 12 }],
        },
      },
    ]);
    const scene = new Scene(doc);
    const builder = new DisplayListBuilder(scene, measurer);
    const list = builder.buildLayers(["exported"], { context: true });
    expect(builder.unsupported.size).toBe(0);
    const engine = new RenderEngine(module);
    try {
      expect(engine.apply(list).ok).toBe(true);
      const res = engine.renderCpu(
        100,
        100,
        { zoom: 1, x: -120, y: 0, dpr: 1 },
        [0, 0, 0, 0],
        false,
      );
      expect(res.ok).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it("renders a faded backdrop-blur + fill layer inside an alpha mask at Figma's alpha end-to-end", () => {
    const renderCenterAlpha = (maskColor: string) => {
      const doc = page();
      doc.apply([
        {
          op: "create",
          id: "bg",
          type: "rect",
          parent: "p",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 120,
            height: 120,
            fills: [{ type: "solid", color: "#00000080" }],
          },
        },
        {
          op: "create",
          id: "scope",
          type: "frame",
          parent: "p",
          key: "a1",
          props: { x: 10, y: 10, width: 100, height: 100, clipContent: false, fills: [] },
        },
        {
          op: "create",
          id: "mask",
          type: "frame",
          parent: "scope",
          key: "a0",
          props: {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            isMask: true,
            maskType: "alpha",
            fills: [{ type: "solid", color: maskColor }],
          },
        },
        {
          op: "create",
          id: "blur",
          type: "rect",
          parent: "scope",
          key: "a1",
          props: {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            opacity: 0.9,
            fills: [{ type: "solid", color: "#000000", blendMode: "screen" }],
            effects: [{ type: "background-blur", radius: 10 }],
          },
        },
      ]);
      const engine = new RenderEngine(module);
      try {
        const list = new DisplayListBuilder(new Scene(doc), measurer).build("p");
        expect(engine.apply(list).ok).toBe(true);
        const res = engine.renderCpu(120, 120, camera, [0, 0, 0, 0], false);
        if (!res.ok) throw new Error(res.message);
        return res.value.pixels[(60 * 120 + 60) * 4 + 3];
      } finally {
        engine.dispose();
      }
    };
    // Mask 0.502 * 0.9 over 0.502 backdrop -> 185; mask 0.667 * 0.9 over 0.502 -> 204 (Figma
    // scroll-edge-mask golden, vs 209 from the non-isolated canvas path).
    expect(renderCenterAlpha("#ffffff80")).toBe(185);
    expect(renderCenterAlpha("#ffffffaa")).toBe(204);
  });
});
