/**
 * The display list on the scale corpus (decision 0027's generated kit; decision 0040, phase
 * 1): building the largest page's list, patching it after a drag, a restyle and a hundred
 * restyles, applying each to the engine, and drawing frames on the CPU backend. CPU-side only:
 * this VM has no GPU. Off unless asked for:
 *
 *   ENGINE_SCALE=500000 pnpm --filter @drawpane/corpus exec vitest run test/engine-scale.test.ts
 *
 * Prints a table and writes it to ENGINE_SCALE_OUT (JSON) if set. Medians of ENGINE_SCALE_RUNS
 * (default 5) runs; the VM is shared, so compare against a baseline run, not a budget.
 */
import { writeFileSync } from "node:fs";
import {
  DisplayListBuilder,
  Doc,
  Scene,
  type ShapedText,
  type TextMeasurer,
} from "@drawpane/editor";
import { RenderEngine } from "@drawpane/engine";
import { built, loadNodeEngine } from "@drawpane/engine/node";
import { getProp, type Op } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { generateKit } from "../src/index";

const LAYERS = Number(process.env.ENGINE_SCALE ?? 0);
const RUNS = Number(process.env.ENGINE_SCALE_RUNS ?? 5);

/** Glyphs without fonts: a box with a counter per character, as the builder's test measurer. */
const runs = new Map<string, ShapedText>();
const measurer: TextMeasurer = {
  width: (_font, text) => text.length * 7,
  metrics: () => ({ ascent: 11, descent: 3 }),
  shape(text, run): ShapedText {
    // Kept per run and text, as the shaper keeps them.
    const key = `${run.key}\u0000${text}`;
    const hit = runs.get(key);
    if (hit) return hit;
    const scale = run.size / 1000;
    const glyphs = [...text].map((ch, i) => {
      const w = 300 + (ch.charCodeAt(0) % 7) * 40;
      return {
        path: null,
        d:
          ch === " "
            ? ""
            : `M0 0L${w} 0L${w} 700L0 700ZM80 120L80 580L${w - 80} 580L${w - 80} 120Z`,
        x: i * 560 * scale,
        y: 0,
        cluster: i,
      };
    });
    const shaped = { glyphs, width: text.length * 560 * scale, scale };
    runs.set(key, shaped);
    return shaped;
  },
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const time = (fn: () => void) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe.skipIf(!LAYERS || !built("worker"))("the display list at scale", () => {
  it(`builds, patches and draws a ${LAYERS.toLocaleString()}-layer kit's largest page`, async () => {
    const t0 = performance.now();
    const kit = generateKit({ layers: LAYERS });
    const genMs = performance.now() - t0;
    // Phase 1 draws no effects (a page with one falls back whole): the kit's few shadows are
    // taken out so the CPU frames measure what the engine draws. Counted in the output.
    let stripped = 0;
    const nodes = kit.nodes.map((n) => {
      const effects = (n.props as { effects?: unknown[] }).effects;
      if (!effects?.length) return n;
      stripped++;
      return { ...n, props: { ...n.props, effects: [] } };
    });
    const doc = new Doc();
    doc.reset(nodes);
    const pages = doc.childIds("root").length ? doc.childIds("root") : [];
    const counts = pages.map((p) => {
      let n = 0;
      const stack = [p];
      while (stack.length) {
        const at = stack.pop() as string;
        n++;
        stack.push(...doc.childIds(at));
      }
      return { page: p, layers: n - 1 };
    });
    counts.sort((a, b) => b.layers - a.layers);
    const largest = counts[0] as { page: string; layers: number };
    const scene = new Scene(doc);
    const engine = new RenderEngine(await loadNodeEngine("worker"));
    const builder = new DisplayListBuilder(scene, measurer);

    // A fresh list of the largest page, and applying it.
    const builds: number[] = [];
    const applies: number[] = [];
    let bytes = 0;
    let records = 0;
    for (let i = 0; i < RUNS; i++) {
      let list: Uint8Array = new Uint8Array();
      builds.push(time(() => (list = builder.build(largest.page))));
      bytes = list.length;
      records = builder.stats.records;
      applies.push(time(() => expect(engine.apply(list).ok).toBe(true)));
    }
    const fresh = new DisplayListBuilder(new Scene(doc), measurer);
    const coldBuild = time(() => fresh.build(largest.page));

    // Patches: a drag (a top-level board moved), one restyle, a hundred restyles.
    const top = doc.childIds(largest.page);
    const leaves: string[] = [];
    for (const stack = [...top]; stack.length > 0 && leaves.length < 100; ) {
      const at = stack.pop() as string;
      const node = doc.get(at);
      // Leaf layers that paint: what a restyle changes.
      if (node && node.type !== "group" && node.type !== "text" && doc.childIds(at).length === 0)
        leaves.push(at);
      stack.push(...doc.childIds(at));
    }
    const patch = (ops: Op[]) => {
      doc.apply(ops);
      let p: Uint8Array | null = null;
      const buildMs = time(() => (p = builder.update()));
      const stats = builder.stats;
      let applyMs = 0;
      if (p) applyMs = time(() => expect(engine.apply(p as unknown as Uint8Array).ok).toBe(true));
      return {
        buildMs,
        applyMs,
        records: stats.records,
        transforms: stats.transforms,
        bytes: stats.bytes,
      };
    };
    const board = top[0] as string;
    const drags = Array.from({ length: RUNS }, (_, i) =>
      patch([
        {
          op: "set",
          id: board,
          prop: "x",
          value: getProp((doc.get(board) as { props: object }).props as never, "x") + 10 + i,
        },
      ]),
    );
    const restyles = Array.from({ length: RUNS }, (_, i) =>
      patch([
        {
          op: "set",
          id: leaves[0] as string,
          prop: "fills",
          value: [{ type: "solid", color: i % 2 ? "#ff0000" : "#00ff00" }],
        },
      ]),
    );
    const hundred = Array.from({ length: RUNS }, (_, i) =>
      patch(
        leaves.map(
          (id) =>
            ({
              op: "set",
              id,
              prop: "fills",
              value: [{ type: "solid", color: i % 2 ? "#3366cc" : "#cc6633" }],
            }) as Op,
        ),
      ),
    );

    // CPU frames: the whole page fit into 1440 × 900, and 100% at its top left (a laptop at 1×).
    const extent = scene.extent(board) ?? { x: 0, y: 0, width: 1000, height: 1000 };
    let page = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const id of top) {
      const e = scene.extent(id);
      if (e)
        page = {
          x0: Math.min(page.x0, e.x),
          y0: Math.min(page.y0, e.y),
          x1: Math.max(page.x1, e.x + e.width),
          y1: Math.max(page.y1, e.y + e.height),
        };
    }
    const fit = Math.min(1440 / (page.x1 - page.x0), 900 / (page.y1 - page.y0));
    const frame = (zoom: number, x: number, y: number) => {
      const ms: number[] = [];
      let stats = null as unknown;
      for (let i = 0; i < RUNS; i++)
        ms.push(
          time(() => {
            const r = engine.renderCpu(
              1440,
              900,
              { zoom, x, y, dpr: 1 },
              [0.92, 0.92, 0.9, 1],
              true,
            );
            if (!r.ok)
              throw new Error(
                `${r.message}; unsupported: ${JSON.stringify(builder.unsupportedCounts())}`,
              );
            if (r.ok) stats = r.value.stats;
          }),
        );
      return { ms: median(ms), first: ms[0], stats };
    };
    const fitFrame = frame(fit, -page.x0 * fit, -page.y0 * fit);
    const closeFrame = frame(1, -extent.x, -extent.y);
    const pan = frame(1, -extent.x - 300, -extent.y - 120);

    const out = {
      kit: {
        layers: kit.stats.layers,
        pages: kit.stats.pages,
        generateMs: Math.round(genMs),
        effectsStripped: stripped,
      },
      largestPage: { layers: largest.layers, records, listBytes: bytes },
      build: { coldMs: coldBuild, medianMs: median(builds), applyMs: median(applies) },
      drag: {
        buildMs: median(drags.map((d) => d.buildMs)),
        applyMs: median(drags.map((d) => d.applyMs)),
        sample: drags[0],
      },
      restyle: {
        buildMs: median(restyles.map((d) => d.buildMs)),
        applyMs: median(restyles.map((d) => d.applyMs)),
        sample: restyles[0],
      },
      hundredRestyles: {
        buildMs: median(hundred.map((d) => d.buildMs)),
        applyMs: median(hundred.map((d) => d.applyMs)),
        sample: hundred[0],
      },
      cpuFrames: { fit: { zoom: fit, ...fitFrame }, at100: closeFrame, panAt100: pan },
      engineMemory: engine.build,
    };
    console.log(JSON.stringify(out, null, 2));
    if (process.env.ENGINE_SCALE_OUT)
      writeFileSync(process.env.ENGINE_SCALE_OUT, `${JSON.stringify(out, null, 2)}\n`);
    // A change costs what it touches: a drag is one transform, a restyle one record.
    expect(drags[0]).toMatchObject({ records: 0, transforms: 1 });
    expect(restyles[0]).toMatchObject({ records: 1 });
  }, 3_600_000);
});
