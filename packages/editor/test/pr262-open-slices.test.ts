import { type EngineModule, RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { keyBetween, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Doc } from "../src/doc";
import { DisplayListBuilder } from "../src/engine/display-list";
import { Scene } from "../src/scene";
import type { ShapedText, TextMeasurer } from "../src/text";

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

const GLASS = {
  type: "glass",
  angle: 45,
  intensity: 75,
  depth: 22,
  refraction: 70,
  dispersion: 10,
  frost: 12,
  splay: 0,
};
const LOOKS: Array<Record<string, unknown>> = [
  { fills: [{ type: "solid", color: "#3366ccff" }] },
  { fills: [{ type: "solid", color: "#ff000080" }] },
  { effects: [GLASS], fills: [{ type: "solid", color: "#ffffff20" }] },
  {
    effects: [{ type: "background-blur", radius: 8 }],
    fills: [{ type: "solid", color: "#ffffff40" }],
  },
  { effects: [{ type: "layer-blur", radius: 6 }] },
  { effects: [{ type: "drop-shadow", x: 2, y: 2, blur: 4, spread: 0, color: "#00000060" }] },
  { isMask: true },
  { isMask: true, maskType: "luminance" },
  { blendMode: "multiply" },
  { blendMode: "linear-burn" },
  { opacity: 0.5 },
  { clipContent: true },
  { rotation: 30 },
];

type Spec = {
  type: "rect" | "frame" | "group" | "ellipse" | "text";
  parent: number;
  x: number;
  y: number;
  w: number;
  h: number;
  look: number;
};
const spec: fc.Arbitrary<Spec> = fc.record({
  type: fc.constantFrom("rect", "frame", "frame", "group", "ellipse", "text"),
  parent: fc.nat(),
  x: fc.integer({ min: -80, max: 420 }),
  y: fc.integer({ min: -80, max: 320 }),
  w: fc.integer({ min: 4, max: 220 }),
  h: fc.integer({ min: 4, max: 180 }),
  look: fc.nat({ max: LOOKS.length + 3 }),
});

let made = 0;
function opsFor(doc: Doc, s: Spec, page: string): Op[] {
  const containers = [...doc.nodes()].filter(
    (n) =>
      (n.type === "page" && n.id === page) ||
      ((n.type === "frame" || n.type === "group") && pageOf(doc, n) === page),
  );
  const parent = containers[s.parent % containers.length] as NodeRecord;
  const last = doc.childIds(parent.id).at(-1);
  const key = keyBetween(last ? (doc.get(last) as NodeRecord).key : null, null);
  const look = LOOKS[s.look] ?? {};
  const box = { x: s.x, y: s.y, width: s.w, height: s.h };
  const fill = { fills: [{ type: "solid", color: "#cc4422" }] };
  if (s.type === "group") {
    const g = `n${made++}`;
    const { clipContent: _c, rotation: _r, fills: _f, effects: _e, ...groupLook } = look;
    return [
      { op: "create", id: g, type: "group", parent: parent.id, key, props: groupLook } as Op,
      {
        op: "create",
        id: `n${made++}`,
        type: "rect",
        parent: g,
        key: "a0",
        props: { ...box, ...fill },
      } as Op,
    ];
  }
  if (s.type === "text")
    return [
      {
        op: "create",
        id: `n${made++}`,
        type: "text",
        parent: parent.id,
        key,
        props: {
          ...box,
          characters: "Text here",
          fontSize: 14,
          textAutoResize: "none",
          fills: [{ type: "solid", color: "#111111" }],
        },
      } as Op,
    ];
  const { clipContent, ...rest } = look;
  return [
    {
      op: "create",
      id: `n${made++}`,
      type: s.type,
      parent: parent.id,
      key,
      props: {
        ...box,
        ...fill,
        ...rest,
        ...(s.type === "frame" && clipContent ? { clipContent } : {}),
      },
    } as Op,
  ];
}

function pageOf(doc: Doc, n: NodeRecord): string | null {
  for (let at: NodeRecord | undefined = n; at; at = doc.get(at.parent))
    if (at.type === "page") return at.id;
  return null;
}

function picture(e: RenderEngine): string | Uint8Array {
  const r = e.renderCpu(W, H, camera, BG, false);
  return r.ok ? r.value.pixels : `error ${r.code}`;
}
function tiledPicture(e: RenderEngine): string | Uint8Array {
  const options = { tile: 24, slots: 64 };
  e.renderCpuTiled(W, H, camera, BG, { ...options, moving: true, maxJobs: 0 });
  const r = e.renderCpuTiled(W, H, camera, BG, options);
  if (!r.ok) return `error ${r.code}`;
  if (!r.value.stats.exact) return "not exact at rest";
  return r.value.pixels;
}
/** Draws and keeps tiles from whatever list the engine holds now (a partial one, mid-open). */
function warmTiles(e: RenderEngine, moving: boolean): void {
  e.renderCpuTiled(W, H, camera, BG, {
    tile: 24,
    slots: 64,
    moving,
    ...(moving ? { maxJobs: 2 } : {}),
  });
}
function same(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return Buffer.from(a).equals(Buffer.from(b));
}

let clock = 0;
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!built("worker") && !process.env.CI)("sliced page opening", () => {
  let mod: EngineModule;
  beforeAll(async () => {
    mod = await loadNodeEngine("worker");
  });

  it("opened in slices (partial tiles kept, edits and a page switch mid-open) equals fresh", () => {
    let multiSlice = 0;
    fc.assert(
      fc.property(
        fc.array(spec, { minLength: 2, maxLength: 40 }),
        fc.array(spec, { minLength: 0, maxLength: 6 }),
        fc.array(spec, { minLength: 1, maxLength: 10 }),
        fc.double({ min: 0.4, max: 6, noNaN: true }),
        fc.record({
          x0: fc.integer({ min: -100, max: 300 }),
          y0: fc.integer({ min: -100, max: 250 }),
        }),
        fc.nat({ max: 6 }),
        fc.nat({ max: 8 }),
        fc.boolean(),
        (specs, edits, otherPage, step, view, editAt, switchAt, doSwitch) => {
          made = 0;
          const doc = new Doc();
          doc.apply([
            { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
            { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: {} },
          ]);
          for (const s of specs) doc.apply(opsFor(doc, s, "p1"));
          for (const s of otherPage) doc.apply(opsFor(doc, s, "p2"));
          const scene = new Scene(doc);
          const builder = new DisplayListBuilder(scene, measurer);
          builder.setView({ x0: view.x0, y0: view.y0, x1: view.x0 + 200, y1: view.y0 + 150 });
          // A fake clock: every read moves it on by `step` ms, so slices end after a few records.
          vi.spyOn(performance, "now").mockImplementation(() => (clock += step));
          const patched = new RenderEngine(mod);
          const target = doSwitch ? "p2" : "p1";
          let slices = 0;
          let page = "p1";
          do {
            if (doSwitch && page === "p1" && slices === switchAt) {
              page = "p2";
            }
            const editOpeningPage = !doSwitch && slices === editAt && edits.length > 0;
            const editOtherPage = slices > 0 && !doSwitch && !editOpeningPage;
            if (editOpeningPage) {
              for (const s of edits) doc.apply(opsFor(doc, s, "p1"));
            } else if (editOtherPage) {
              doc.apply(opsFor(doc, otherPage[0] as Spec, "p2"));
            }
            const msg = builder.openSlice(page);
            if (editOtherPage) expect(builder.stats.fresh).toBe(false);
            const r = patched.apply(msg);
            builder.acknowledge(r.ok, patched.revision);
            if (!r.ok) throw new Error(`slice refused: ${r.message}`);
            slices++;
            warmTiles(patched, slices % 2 === 0);
            if (slices > 10_000) throw new Error("opening never finished");
          } while (builder.opening || page !== target);
          if (slices > 1) multiSlice++;
          // Drain deferred text the way frames and idle slices do.
          for (let i = 0; builder.pending > 0 && i < 10_000; i++) {
            const p = builder.update(1e9);
            if (p) {
              const r = patched.apply(p);
              builder.acknowledge(r.ok, patched.revision);
              if (!r.ok) throw new Error(`text patch refused: ${r.message}`);
            }
            warmTiles(patched, false);
          }
          expect(builder.pending).toBe(0);
          vi.restoreAllMocks();
          const check = () => {
            const fresh = new RenderEngine(mod);
            const fb = new DisplayListBuilder(new Scene(doc), measurer);
            expect(fresh.apply(fb.build(target)).ok).toBe(true);
            expect(patched.records).toBe(fresh.records);
            const ours = picture(patched);
            const theirs = picture(fresh);
            expect(same(ours, theirs)).toBe(true);
            const ot = tiledPicture(patched);
            const tt = tiledPicture(fresh);
            expect(ot === "not exact at rest" ? ot : "ok").toBe("ok");
            expect(same(ot, tt)).toBe(true);
            fresh.dispose();
          };
          check();
          // A patch after opening finished still equals fresh.
          if (edits.length > 0) {
            for (const s of edits.slice(0, 2)) doc.apply(opsFor(doc, s, target));
            const p = builder.update(1e9);
            if (p) {
              const r = patched.apply(p);
              if (!r.ok) throw new Error(`post-open patch refused: ${r.message}`);
            }
            check();
          }
          patched.dispose();
        },
      ),
      {
        numRuns: Number(process.env.FUZZ_RUNS ?? 24),
        ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}),
      },
    );
    expect(multiSlice).toBeGreaterThan(0);
  }, 180_000);
});
