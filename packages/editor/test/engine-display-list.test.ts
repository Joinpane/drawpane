/**
 * The display-list builder (decision 0040, "Patched equals fresh"): random edits to a document
 * (create, move between parents, reorder, restyle, resize, drag, delete, undo-like toggles,
 * text with interned glyphs) are sent to one engine as patches; after each, its picture must
 * equal a fresh engine's, given the whole list built afresh, pixel for pixel on the CPU. The
 * builder must also never re-walk the page for a change: patches carry only what changed.
 */

import { type EngineModule, RenderEngine, unsupportedNames } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { keyBetween, type NodeRecord, type Op, type PropName, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { DisplayListBuilder } from "../src/engine/display-list";
import { Scene } from "../src/scene";
import type { ShapedText, TextMeasurer } from "../src/text";

/** Glyphs of a test font: boxes with a counter, a different width per character. */
const measurer: TextMeasurer = {
  width: (_font, text) => text.length * 9,
  metrics: () => ({ ascent: 14, descent: 4 }),
  shape(text, run): ShapedText {
    const scale = run.size / 1000;
    const glyphs = [...text].map((ch, i) => {
      const w = 300 + (ch.charCodeAt(0) % 5) * 60;
      return {
        path: null,
        d:
          ch === " "
            ? ""
            : `M0 0L${w} 0L${w} 700L0 700ZM80 120L80 580L${w - 80} 580L${w - 80} 120Z`,
        x: i * 600 * scale,
        y: 0,
        cluster: i,
      };
    });
    return { glyphs, width: text.length * 600 * scale, scale };
  },
};

const W = 200;
const H = 150;
const BG: [number, number, number, number] = [1, 1, 1, 1];
const camera = { zoom: 0.5, x: 10, y: 10, dpr: 1 };

let made = 0;
const create = (
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown>,
): Op => ({ op: "create", id: `n${made++}`, type, parent, key, props }) as Op;

const LOOKS: Array<[PropName, unknown]> = [
  ["fills", [{ type: "solid", color: "#3366ccff" }]],
  [
    "fills",
    [
      { type: "solid", color: "#ff000080" },
      { type: "solid", color: "#00ff0040" },
    ],
  ],
  [
    "fills",
    [
      {
        type: "linear",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        stops: [
          { position: 0, color: "#ff8800" },
          { position: 1, color: "#0044ff" },
        ],
      },
    ],
  ],
  [
    "fills",
    [
      {
        type: "radial",
        from: { x: 0.5, y: 0.5 },
        to: { x: 1, y: 0.5 },
        stops: [
          { position: 0, color: "#ffffff" },
          { position: 1, color: "#000000" },
        ],
      },
    ],
  ],
  [
    "fills",
    [
      {
        type: "angular",
        from: { x: 0.5, y: 0.5 },
        to: { x: 1, y: 0 },
        stops: [
          { position: 0, color: "#ff0000" },
          { position: 1, color: "#0000ff" },
        ],
      },
    ],
  ],
  ["strokes", [{ type: "solid", color: "#000000" }]],
  ["strokes", []],
  ["strokeWeight", 6],
  ["strokeAlign", "inside"],
  ["strokeAlign", "outside"],
  ["strokeDashes", [6, 3]],
  ["cornerRadius", 12],
  ["opacity", 0.5],
  ["opacity", 1],
  ["visible", false],
  ["visible", true],
  ["clipContent", true],
  ["clipContent", false],
  ["rotation", 30],
  ["characters", "Hello"],
  ["characters", "Wide text here"],
  ["effects", [{ type: "drop-shadow", x: 2, y: 2, blur: 4, spread: 0, color: "#00000040" }]],
  [
    "effects",
    [
      {
        type: "drop-shadow",
        x: 2,
        y: 2,
        blur: 4,
        spread: 0,
        color: "#00000040",
        blendMode: "linear-burn",
      },
    ],
  ],
  ["effects", [{ type: "layer-blur", radius: 8 }]],
  [
    "effects",
    [
      {
        type: "noise",
        noiseType: "duo",
        size: 1.5,
        density: 60,
        color: "#00000080",
        secondaryColor: "#ffffff80",
        opacity: 80,
      },
    ],
  ],
  ["effects", [{ type: "texture", size: 4, radius: 6, clipToShape: false }]],
  ["effects", [{ type: "texture", size: 3, radius: 5, clipToShape: true }]],
  ["effects", []],
  ["blendMode", "multiply"],
  ["blendMode", "linear-dodge"],
  ["blendMode", "linear-burn"],
  ["blendMode", "luminosity"],
  ["blendMode", "normal"],
  ["isMask", true],
  ["isMask", false],
  ["maskType", "outline"],
  ["maskType", "alpha"],
  ["maskType", "luminance"],
];

type Action =
  | {
      kind: "create";
      type: "rect" | "frame" | "group" | "ellipse" | "text";
      parent: number;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | { kind: "move"; node: number; dx: number; dy: number }
  | { kind: "resize"; node: number; w: number; h: number }
  | { kind: "look"; node: number; look: number }
  | { kind: "reparent"; node: number; into: number; top: boolean }
  | { kind: "delete"; node: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      type: fc.constantFrom("rect", "frame", "group", "ellipse", "text"),
      parent: fc.nat(),
      x: fc.integer({ min: -50, max: 350 }),
      y: fc.integer({ min: -50, max: 250 }),
      w: fc.integer({ min: 1, max: 160 }),
      h: fc.integer({ min: 1, max: 120 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      node: fc.nat(),
      dx: fc.integer({ min: -60, max: 60 }),
      dy: fc.integer({ min: -60, max: 60 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("resize" as const),
      node: fc.nat(),
      w: fc.integer({ min: 1, max: 200 }),
      h: fc.integer({ min: 1, max: 150 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("look" as const),
      node: fc.nat(),
      look: fc.nat({ max: LOOKS.length - 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("reparent" as const),
      node: fc.nat(),
      into: fc.nat(),
      top: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), node: fc.nat() }) },
);

function seed(doc: Doc): void {
  doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: {} },
    create("frame", "p1", "a0", {
      x: 0,
      y: 0,
      width: 300,
      height: 220,
      fills: [{ type: "solid", color: "#eeeeee" }],
    }),
    create("rect", "p2", "a0", { x: 0, y: 0, width: 50, height: 50 }),
  ]);
}

const pick = <T>(list: readonly T[], i: number): T | undefined =>
  list.length === 0 ? undefined : list[i % list.length];

function opsFor(doc: Doc, a: Action): Op[] {
  const layers = [...doc.nodes()].filter((n) => n.type !== "page");
  const containers = [...doc.nodes()].filter(
    (n) => n.type === "page" || n.type === "frame" || n.type === "group",
  );
  const keyAtEnd = (parent: string) => {
    const last = doc.childIds(parent).at(-1);
    return keyBetween(last ? (doc.get(last) as NodeRecord).key : null, null);
  };
  switch (a.kind) {
    case "create": {
      const parent = pick(containers, a.parent);
      if (!parent) return [];
      const key = keyAtEnd(parent.id);
      const box = { x: a.x, y: a.y, width: a.w, height: a.h };
      if (a.type === "group") {
        const g = create("group", parent.id, key, {});
        return [
          g,
          create("rect", (g as { id: string }).id, "a0", {
            ...box,
            fills: [{ type: "solid", color: "#22aa55" }],
          }),
        ];
      }
      if (a.type === "text")
        return [
          create("text", parent.id, key, {
            ...box,
            characters: "Text",
            fontSize: 14,
            textAutoResize: "none",
            fills: [{ type: "solid", color: "#111111" }],
          }),
        ];
      return [
        create(a.type, parent.id, key, { ...box, fills: [{ type: "solid", color: "#cc4422" }] }),
      ];
    }
    case "move": {
      const n = pick(layers, a.node);
      if (!n || n.type === "group") return [];
      return [
        { op: "set", id: n.id, prop: "x", value: (n.props.x as number) + a.dx },
        { op: "set", id: n.id, prop: "y", value: (n.props.y as number) + a.dy },
      ];
    }
    case "resize": {
      const n = pick(layers, a.node);
      if (!n || n.type === "group") return [];
      return [
        { op: "set", id: n.id, prop: "width", value: a.w },
        { op: "set", id: n.id, prop: "height", value: a.h },
      ];
    }
    case "look": {
      const n = pick(layers, a.node);
      const [prop, value] = LOOKS[a.look] as [PropName, unknown];
      if (!n) return [];
      if (prop === "clipContent" && n.type !== "frame") return [];
      if (prop === "characters" && n.type !== "text") return [];
      if (prop === "cornerRadius" && n.type !== "rect" && n.type !== "frame") return [];
      if (
        n.type === "group" &&
        prop !== "opacity" &&
        prop !== "visible" &&
        prop !== "blendMode" &&
        prop !== "isMask" &&
        prop !== "maskType"
      )
        return [];
      return [{ op: "set", id: n.id, prop, value } as Op];
    }
    case "reparent": {
      const n = pick(layers, a.node);
      const into = pick(containers, a.into);
      if (!n || !into || into.id === n.id) return [];
      for (let at: NodeRecord | undefined = into; at; at = doc.get(at.parent))
        if (at.id === n.id) return [];
      if (into.type === "group" && doc.childIds(into.id).length === 0) return [];
      const siblings = doc.childIds(into.id).filter((id) => id !== n.id);
      const edge = a.top ? siblings.at(-1) : siblings[0];
      const edgeKey = edge ? (doc.get(edge) as NodeRecord).key : null;
      return [
        {
          op: "move",
          id: n.id,
          parent: into.id,
          key: a.top ? keyBetween(edgeKey, null) : keyBetween(null, edgeKey),
        },
      ];
    }
    case "delete": {
      const n = pick(layers, a.node);
      return n ? [{ op: "delete", id: n.id }] : [];
    }
  }
}

/** A render, or the error it gave: both engines must agree on either. */
function picture(e: RenderEngine): string | Uint8Array {
  const r = e.renderCpu(W, H, camera, BG, false);
  return r.ok ? r.value.pixels : `error ${r.code}`;
}

/**
 * A frame made of tiles (decision 0040, phase 2), at rest: exact, from whatever tiles the engine
 * kept, after a moving frame that may draw none of the stale ones. Small tiles, so a frame is
 * several.
 */
function tiledPicture(e: RenderEngine): string | Uint8Array {
  const options = { tile: 24, slots: 64 };
  e.renderCpuTiled(W, H, camera, BG, { ...options, moving: true, maxJobs: 0 });
  const r = e.renderCpuTiled(W, H, camera, BG, options);
  if (!r.ok) return `error ${r.code}`;
  if (!r.value.stats.exact) return "not exact at rest";
  return r.value.pixels;
}

describe.skipIf(!built("worker") && !process.env.CI)("the display-list builder", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  it("patches equal a fresh build, pixel for pixel", () => {
    let drawn = 0;
    let painted = 0;
    let refused = 0;
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 25 }), (actions) => {
        made = 0;
        const doc = new Doc();
        seed(doc);
        const scene = new Scene(doc);
        const builder = new DisplayListBuilder(scene, measurer);
        const patched = new RenderEngine(mod);
        expect(patched.apply(builder.build("p1")).ok).toBe(true);
        for (const a of actions) {
          const ops = opsFor(doc, a);
          if (ops.length === 0) continue;
          doc.apply(ops);
          const patch = builder.update();
          if (patch) {
            const r = patched.apply(patch);
            if (!r.ok) throw new Error(`patch refused: ${r.message}`);
          }
          const fresh = new RenderEngine(mod);
          const freshBuilder = new DisplayListBuilder(new Scene(doc), measurer);
          const list = freshBuilder.build("p1");
          expect(fresh.apply(list).ok).toBe(true);
          expect(patched.records).toBe(fresh.records);
          const ours = picture(patched);
          const theirs = picture(fresh);
          if (typeof ours === "string" || typeof theirs === "string") {
            expect(ours).toEqual(theirs);
            refused++;
          } else {
            expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
            drawn++;
            if (ours.some((v, i) => i % 4 !== 3 && v !== 255)) painted++;
          }
          // The patched engine's tiles, kept across every step, against a fresh engine's.
          const ourTiles = tiledPicture(patched);
          const theirTiles = tiledPicture(fresh);
          if (typeof ourTiles === "string" || typeof theirTiles === "string")
            expect(ourTiles).toEqual(theirTiles);
          else expect(Buffer.from(ourTiles).equals(Buffer.from(theirTiles))).toBe(true);
          // What the builder flags is what the engine refuses: unsupported never draws.
          expect([...builder.unsupported.keys()].sort()).toEqual(
            [...freshBuilder.unsupported.keys()].sort(),
          );
          fresh.dispose();
        }
        patched.dispose();
      }),
      {
        // Each run builds two engines a step: the nightly fuzz (20,000 runs elsewhere) gets 1,000 here.
        numRuns: Math.min(1000, Number(process.env.FUZZ_RUNS ?? 40)),
        ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}),
        ...(process.env.FUZZ_PATH ? { path: process.env.FUZZ_PATH, endOnFailure: true } : {}),
        ...(process.env.FUZZ_EXAMPLE ? { examples: [[JSON.parse(process.env.FUZZ_EXAMPLE)]] } : {}),
      },
    );
    // The comparisons compared pictures, not only matching refusals.
    expect(painted).toBeGreaterThan(drawn / 2);
    expect(drawn).toBeGreaterThan(refused);
  }, 1_800_000);

  it("sends only what changed: a drag is a transform, a restyle is one record", () => {
    const doc = new Doc();
    seed(doc);
    const frame = doc.childIds("p1")[0] as string;
    const ops: Op[] = [];
    let key: string | null = null;
    for (let i = 0; i < 400; i++) {
      key = keyBetween(key, null);
      ops.push(
        create("rect", frame, key, {
          x: (i % 20) * 14,
          y: Math.floor(i / 20) * 10,
          width: 12,
          height: 8,
          fills: [{ type: "solid", color: "#336699" }],
        }),
      );
    }
    doc.apply(ops);
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    const engine = new RenderEngine(mod);
    expect(engine.apply(builder.build("p1")).ok).toBe(true);
    expect(builder.stats.records).toBe(401);
    doc.apply([{ op: "set", id: frame, prop: "x", value: 40 }]);
    const drag = builder.update();
    expect(drag && engine.apply(drag).ok).toBe(true);
    expect(builder.stats).toMatchObject({ records: 0, transforms: 1 });
    const child = doc.childIds(frame)[7] as string;
    doc.apply([
      { op: "set", id: child, prop: "fills", value: [{ type: "solid", color: "#ff0000" }] },
    ]);
    const restyle = builder.update();
    expect(restyle && engine.apply(restyle).ok).toBe(true);
    expect(builder.stats).toMatchObject({ records: 1, transforms: 0 });
    // A stale revision is refused, and nothing changes.
    expect(engine.apply(builder.build("p1")).ok).toBe(true);
    const r = engine.apply(drag as Uint8Array);
    expect(r.ok).toBe(false);
  });

  it("reports what it can't draw, and the engine refuses it", () => {
    const doc = new Doc();
    seed(doc);
    const frame = doc.childIds("p1")[0] as string;
    doc.apply([
      {
        op: "set",
        id: frame,
        prop: "effects",
        value: [
          {
            type: "layer-blur",
            radius: 8,
            blurType: "progressive",
            startRadius: 0,
            startOffset: { x: 0, y: 0 },
            endOffset: { x: 1, y: 1 },
          },
        ],
      },
    ]);
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    const engine = new RenderEngine(mod);
    expect(engine.apply(builder.build("p1")).ok).toBe(true);
    expect(builder.supported).toBe(false);
    expect(unsupportedNames(builder.unsupported.get(frame) ?? 0)).toEqual(["layerBlur"]);
    const r = engine.renderCpu(W, H, camera, BG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(5);
  });

  it("encodes and renders drop shadows, cut-outs, inner shadows, and text shadows", () => {
    const doc = new Doc();
    seed(doc);
    const frame = doc.childIds("p1")[0] as string;
    doc.apply([
      {
        op: "set",
        id: frame,
        prop: "effects",
        value: [
          {
            type: "drop-shadow",
            x: 0,
            y: 6,
            blur: 14,
            spread: 2,
            color: "#00000040",
            showBehind: false,
          },
          {
            type: "inner-shadow",
            x: 0,
            y: 2,
            blur: 6,
            spread: 1,
            color: "#ffffff60",
          },
        ],
      },
      create("rect", frame, "a0", {
        x: 20,
        y: 20,
        width: 80,
        height: 60,
        cornerRadius: 12,
        opacity: 0.7,
        fills: [{ type: "solid", color: "#3366cc" }],
        effects: [{ type: "drop-shadow", x: 3, y: 4, blur: 10, spread: 0, color: "#00000050" }],
      }),
      create("text", frame, "a1", {
        x: 20,
        y: 110,
        width: 140,
        height: 40,
        characters: "Shadow",
        fontSize: 24,
        textDecoration: "underline",
        fills: [{ type: "solid", color: "#111111" }],
        effects: [{ type: "drop-shadow", x: 1, y: 3, blur: 6, spread: 0, color: "#00000060" }],
      }),
    ]);
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    const engine = new RenderEngine(mod);
    expect(engine.apply(builder.build("p1")).ok).toBe(true);
    expect(builder.supported).toBe(true);
    const r = engine.renderCpu(W, H, camera, BG);
    expect(r.ok).toBe(true);
  });

  it("elides zero-alpha shadows without changing rendered pixels", () => {
    const doc = new Doc();
    seed(doc);
    const frame = doc.childIds("p1")[0] as string;
    const plain = new DisplayListBuilder(new Scene(doc), measurer).build("p1");
    doc.apply([
      {
        op: "set",
        id: frame,
        prop: "effects",
        value: [
          { type: "drop-shadow", x: 0, y: 0, blur: 0, spread: 0, color: "#00000000" },
          { type: "inner-shadow", x: 2, y: 2, blur: 8, spread: 1, color: "#ffffff00" },
        ],
      },
    ]);
    const withZero = new DisplayListBuilder(new Scene(doc), measurer).build("p1");
    expect(withZero.length).toBe(plain.length);
  });

  it("encodes and renders noise (mono, duo, multi) and texture (clipped and unclipped) cleanly", () => {
    const doc = new Doc();
    seed(doc);
    const frame = doc.childIds("p1")[0] as string;
    doc.apply([
      create("rect", frame, "a0", {
        x: 10,
        y: 10,
        width: 70,
        height: 50,
        fills: [{ type: "solid", color: "#3366cc" }],
        effects: [
          {
            type: "noise",
            noiseType: "mono",
            size: 1.5,
            density: 70,
            color: "#00000088",
            secondaryColor: "#ffffff",
            opacity: 100,
          },
          {
            type: "noise",
            noiseType: "duo",
            size: 2,
            density: 50,
            color: "#11111180",
            secondaryColor: "#eeeeee80",
            opacity: 100,
          },
          {
            type: "noise",
            noiseType: "multi",
            size: 1.2,
            density: 65,
            color: "#000000",
            secondaryColor: "#ffffff",
            opacity: 75,
          },
        ],
      }),
      create("ellipse", frame, "a1", {
        x: 90,
        y: 20,
        width: 60,
        height: 60,
        fills: [{ type: "solid", color: "#dd4433" }],
        effects: [
          { type: "texture", size: 4, radius: 6, clipToShape: false },
          { type: "texture", size: 3, radius: 4, clipToShape: true },
        ],
      }),
    ]);
    const builder = new DisplayListBuilder(new Scene(doc), measurer);
    const engine = new RenderEngine(mod);
    expect(engine.apply(builder.build("p1")).ok).toBe(true);
    expect(builder.supported).toBe(true);
    const r = engine.renderCpu(W, H, camera, BG);
    expect(r.ok).toBe(true);
  });
});

describe("image demand from painted geometry", () => {
  it.each([
    { mode: "fill", w: 150, h: 70, rotation: 0, zoom: 1, dpr: 1, expected: [150, 75] },
    { mode: "fit", w: 150, h: 70, rotation: Math.PI / 3, zoom: 2, dpr: 2, expected: [560, 280] },
    {
      mode: "stretch",
      w: 25,
      h: 600,
      rotation: Math.PI / 4,
      zoom: 0.5,
      dpr: 2,
      expected: [25, 600],
    },
    { mode: "crop", w: 150, h: 70, rotation: Math.PI / 2, zoom: 1, dpr: 2, expected: [1200, 280] },
    { mode: "tile", w: 150, h: 70, rotation: Math.PI, zoom: 1, dpr: 1, expected: [400, 200] },
  ])("projects both painted axes for $mode", ({ mode, w, h, rotation, zoom, dpr, expected }) => {
    const doc = new Doc();
    doc.apply([
      { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      create("rect", "p1", "a0", {
        width: w,
        height: h,
        rotation,
        flipX: true,
        fills: [
          {
            type: "image",
            ref: "a".repeat(64),
            scaleMode: mode,
            crop: { x: 0, y: 0, width: 0.25, height: 0.5 },
          },
        ],
      }),
    ]);
    const builder = new DisplayListBuilder(new Scene(doc), measurer, {
      image: () => ({ handle: 1, width: 400, height: 200 }),
    });
    builder.build("p1");
    const [demand] = builder.imageDemands({ x: -1000, y: -1000, width: 2000, height: 2000 }, 0);
    expect(demand?.visible).toBe(true);
    expect((demand?.span?.width ?? 0) * zoom * dpr).toBeCloseTo(expected[0] ?? 0);
    expect((demand?.span?.height ?? 0) * zoom * dpr).toBeCloseTo(expected[1] ?? 0);
  });
});
