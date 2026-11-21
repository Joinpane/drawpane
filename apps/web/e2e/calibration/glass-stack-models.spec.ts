/**
 * Reproducible candidate-model sweep and residual ROI attribution for Figma's stacked-glass
 * rule (docs/decisions/0007-glass-effect.md, tools/figma-parity/scenes/glass-stack.json).
 *
 * Evaluates all seven candidate stacking models using Drawpane's exact CanvasRenderer, glass
 * shader, text shaping, and fonts against the committed Figma 2x exportAsync goldens:
 *
 *   (a)  Faithful nested glass (every reader sees earlier glass)
 *   (b)  Glass skips earlier glass; background-blur still sees earlier glass
 *   (b*) Unified no-glass backdrop: neither glass nor background-blur sees earlier glass
 *   (b2) Per-region suppression under upper glass
 *   (c1) Earlier non-ancestor glass layers omitted completely
 *   (c2) Earlier glass layers' own glass/fills/strokes omitted, children kept
 *   (d)  Shared pre-glass backdrop captured before the first glass layer
 *
 * Also runs single-reader attribution controls for `diff-params` and `partial-overlap`, and
 * reports full-cell mean, p99, worst 32x32 tile, and per-ROI (outside / one-reader / overlap /
 * text-box) error breakdowns.
 *
 * Run:
 *   PARITY_PORT=9246 pnpm --filter @drawpane/web exec playwright test \
 *     e2e/calibration/glass-stack-models.spec.ts --project=calibration
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { decodePng } from "../parity/pixels";
import {
  build,
  exportRect,
  gridSize,
  type Layer,
  ROOT,
  SCALE,
  type Suite,
  waitForFonts,
} from "../parity/suites";

const OUT =
  process.env.GLASS_STACK_MODELS_OUT ??
  fileURLToPath(new URL("../../test-results/glass-stack-models", import.meta.url));

type ModelKey = "a" | "b" | "b*" | "b2" | "c1" | "c2" | "d";
const MODELS: readonly ModelKey[] = ["a", "b", "b*", "b2", "c1", "c2", "d"];

interface RoiStats {
  readonly mean: number;
  readonly p99: number;
  readonly worstTile: number;
  readonly severe40: number;
  readonly pixels: number;
}

interface Box {
  readonly kind: "reader" | "text";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function collectBoxes(layers: readonly Layer[], ox = 0, oy = 0, out: Box[] = []): Box[] {
  for (const layer of layers) {
    const x = ox + layer.x;
    const y = oy + layer.y;
    if (layer.type === "text") {
      out.push({ kind: "text", x, y, width: layer.width, height: layer.height });
    }
    const effects = Array.isArray(layer.effects)
      ? (layer.effects as Array<{ type?: string; visible?: boolean }>)
      : [];
    if (
      effects.some(
        (e) => e.visible !== false && (e.type === "glass" || e.type === "background-blur"),
      )
    ) {
      out.push({ kind: "reader", x, y, width: layer.width, height: layer.height });
    }
    if (layer.children) collectBoxes(layer.children, x, y, out);
  }
  return out;
}

function scoreRois(
  got: Uint8Array,
  want: Uint8Array,
  width: number,
  height: number,
  boxes: readonly Box[],
): Record<string, RoiStats> {
  const tags = ["all", "outside", "one", "overlap", "text-box"] as const;
  const maxes: Record<string, number[]> = Object.fromEntries(tags.map((t) => [t, []]));
  const sums: Record<string, number> = Object.fromEntries(tags.map((t) => [t, 0]));

  // 32x32 tiles for worstTile over full cell
  const cols = Math.ceil(width / 32);
  const rows = Math.ceil(height / 32);
  const tileSums = new Float64Array(cols * rows);
  const tileCounts = new Uint32Array(cols * rows);

  for (let y = 0; y < height; y++) {
    const py = y / SCALE;
    const ty = y >> 5;
    for (let x = 0; x < width; x++) {
      const px = x / SCALE;
      const i = (y * width + x) * 4;
      const dr = Math.abs((got[i] ?? 0) - (want[i] ?? 0));
      const dg = Math.abs((got[i + 1] ?? 0) - (want[i + 1] ?? 0));
      const db = Math.abs((got[i + 2] ?? 0) - (want[i + 2] ?? 0));
      const rgbSum = dr + dg + db;
      const m = Math.max(dr, dg, db);

      const tidx = ty * cols + (x >> 5);
      tileSums[tidx] = (tileSums[tidx] ?? 0) + rgbSum / 3;
      tileCounts[tidx] = (tileCounts[tidx] ?? 0) + 1;

      let readers = 0;
      let inText = false;
      for (const b of boxes) {
        if (b.kind === "reader") {
          if (px >= b.x - 1 && px < b.x + b.width + 1 && py >= b.y - 1 && py < b.y + b.height + 1)
            readers++;
        } else if (px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height) {
          inText = true;
        }
      }
      const bucket = readers === 0 ? "outside" : readers === 1 ? "one" : "overlap";
      for (const tag of inText
        ? (["all", bucket, "text-box"] as const)
        : (["all", bucket] as const)) {
        maxes[tag]?.push(m);
        sums[tag] = (sums[tag] ?? 0) + rgbSum;
      }
    }
  }

  let worstTile = 0;
  for (let i = 0; i < tileSums.length; i++) {
    const c = tileCounts[i] ?? 0;
    if (c > 0) worstTile = Math.max(worstTile, (tileSums[i] ?? 0) / c);
  }

  const out: Record<string, RoiStats> = {};
  for (const tag of tags) {
    const arr = maxes[tag] ?? [];
    if (arr.length === 0) continue;
    arr.sort((a, b) => a - b);
    const severe40 = arr.filter((v) => v >= 40).length;
    out[tag] = {
      mean: Math.round(((sums[tag] ?? 0) / (3 * arr.length)) * 100) / 100,
      p99: arr[Math.floor(arr.length * 0.99)] ?? 0,
      worstTile: Math.round(worstTile * 100) / 100,
      severe40,
      pixels: arr.length,
    };
  }
  return out;
}

function scoreBoxRoi(
  got: Uint8Array,
  want: Uint8Array,
  width: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
): { mean: number; p99: number } {
  const arr: number[] = [];
  let sum = 0;
  for (let y = rect.y0 * SCALE; y < rect.y1 * SCALE; y++) {
    for (let x = rect.x0 * SCALE; x < rect.x1 * SCALE; x++) {
      const i = (y * width + x) * 4;
      const dr = Math.abs((got[i] ?? 0) - (want[i] ?? 0));
      const dg = Math.abs((got[i + 1] ?? 0) - (want[i + 1] ?? 0));
      const db = Math.abs((got[i + 2] ?? 0) - (want[i + 2] ?? 0));
      sum += dr + dg + db;
      arr.push(Math.max(dr, dg, db));
    }
  }
  arr.sort((a, b) => a - b);
  return {
    mean: Math.round((sum / (3 * Math.max(1, arr.length))) * 100) / 100,
    p99: arr[Math.floor(arr.length * 0.99)] ?? 0,
  };
}

interface RenderSpec {
  readonly key: string;
  readonly model: ModelKey;
  readonly flattenLowerFadedGroup?: boolean;
  readonly stripLowerBgBlur?: boolean;
  readonly omitLowerLayer?: boolean;
  readonly onlyReaderIndex?: number;
}

/**
 * Renders every requested candidate model and control for one cell inside a single browser call,
 * caching identical `(targetNode, mutatedSubtreeState)` renders so all seven models stay 100%
 * general while avoiding redundant SwiftShader WebGL passes.
 */
async function renderCellSpecs(
  page: Page,
  frameId: string,
  rect: { x: number; y: number; width: number; height: number },
  specs: readonly RenderSpec[],
): Promise<Record<string, Uint8Array>> {
  const b64Map = await page.evaluate(
    async ({ frameId, rect, scale, specs }) => {
      interface EffectLike {
        type: string;
        visible?: boolean;
      }
      interface NodeLike {
        id: string;
        parent: string;
        type: string;
        props: Record<string, unknown>;
      }
      const w = window as unknown as {
        drawpane: {
          doc: { get(id: string): NodeLike | undefined; childIds(id: string): string[] };
          scene: {
            bounds(id: string): { x: number; y: number; width: number; height: number } | null;
          };
          commit(ops: Array<Record<string, unknown>>): boolean;
        };
        drawpaneParity: {
          render(
            id: string,
            rect: { x: number; y: number; width: number; height: number },
            scale: number,
            width: number,
            height: number,
          ): Promise<{ png: string }>;
        };
      };

      const width = rect.width * scale;
      const height = rect.height * scale;
      const doc = w.drawpane.doc;
      const subtree: string[] = [];
      const walk = (id: string) => {
        subtree.push(id);
        for (const c of doc.childIds(id)) walk(c);
      };
      walk(frameId);

      const saved = new Map<
        string,
        {
          effects: unknown;
          fills: unknown;
          strokes: unknown;
          visible: unknown;
          opacity: unknown;
          blendMode: unknown;
        }
      >();
      for (const id of subtree) {
        const n = doc.get(id);
        if (!n) continue;
        saved.set(id, {
          effects: structuredClone(n.props.effects),
          fills: structuredClone(n.props.fills),
          strokes: structuredClone(n.props.strokes),
          visible: n.props.visible,
          opacity: n.props.opacity,
          blendMode: n.props.blendMode,
        });
      }

      const mustCommit = (ops: Array<Record<string, unknown>>) => {
        if (ops.length === 0) return;
        const ok = w.drawpane.commit(ops);
        if (!ok) throw new Error(`drawpane.commit rejected ops: ${JSON.stringify(ops)}`);
      };

      const val = (v: unknown) => (v === undefined ? null : v);

      const restore = () => {
        const ops: Array<Record<string, unknown>> = [];
        for (const [id, s] of saved) {
          const n = doc.get(id);
          if (!n) continue;
          if (JSON.stringify(n.props.effects) !== JSON.stringify(s.effects))
            ops.push({ op: "set", id, prop: "effects", value: val(structuredClone(s.effects)) });
          if (JSON.stringify(n.props.fills) !== JSON.stringify(s.fills))
            ops.push({ op: "set", id, prop: "fills", value: val(structuredClone(s.fills)) });
          if (JSON.stringify(n.props.strokes) !== JSON.stringify(s.strokes))
            ops.push({ op: "set", id, prop: "strokes", value: val(structuredClone(s.strokes)) });
          if (n.props.visible !== s.visible)
            ops.push({ op: "set", id, prop: "visible", value: val(s.visible) });
          if (n.props.opacity !== s.opacity)
            ops.push({ op: "set", id, prop: "opacity", value: val(s.opacity) });
          if (n.props.blendMode !== s.blendMode)
            ops.push({ op: "set", id, prop: "blendMode", value: val(s.blendMode) });
        }
        mustCommit(ops);
      };

      const stateKey = () =>
        subtree
          .map((id) => {
            const n = doc.get(id);
            if (!n) return "";
            return JSON.stringify([
              n.props.visible ?? true,
              n.props.opacity ?? 1,
              n.props.blendMode ?? "normal",
              n.props.effects ?? null,
              n.props.fills ?? null,
              n.props.strokes ?? null,
            ]);
          })
          .join("|");

      const effectsOf = (id: string): EffectLike[] => {
        const eff = saved.get(id)?.effects;
        return Array.isArray(eff) ? (eff as EffectLike[]) : [];
      };
      const hasGlass = (id: string) =>
        effectsOf(id).some((e) => e.visible !== false && e.type === "glass");
      const hasBgBlur = (id: string) =>
        effectsOf(id).some((e) => e.visible !== false && e.type === "background-blur");
      const isReader = (id: string) => hasGlass(id) || hasBgBlur(id);
      const isAncestor = (anc: string, desc: string) => {
        let cur = doc.get(desc)?.parent;
        while (cur) {
          if (cur === anc) return true;
          cur = doc.get(cur)?.parent;
        }
        return false;
      };
      const overlaps = (aId: string, bId: string) => {
        const a = w.drawpane.scene.bounds(aId);
        const b = w.drawpane.scene.bounds(bId);
        if (!a || !b) return false;
        return (
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
        );
      };
      const stripGlass = (id: string) => effectsOf(id).filter((e) => e.type !== "glass");
      const stripBgBlur = (id: string) => effectsOf(id).filter((e) => e.type !== "background-blur");

      const bmpCache = new Map<string, ImageBitmap>();
      const renderNode = async (id: string) => {
        const key = `${id}::${stateKey()}`;
        const hit = bmpCache.get(key);
        if (hit) return hit;
        const { png } = await w.drawpaneParity.render(id, rect, scale, width, height);
        const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        bmpCache.set(key, bmp);
        return bmp;
      };

      const encodeCanvas = (c: OffscreenCanvas) => {
        const data = (c.getContext("2d") as OffscreenCanvasRenderingContext2D).getImageData(
          0,
          0,
          width,
          height,
        ).data;
        let s = "";
        for (let i = 0; i < data.length; i += 0x8000)
          s += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return btoa(s);
      };

      const results: Record<string, string> = {};
      const readers = subtree.filter((id) => id !== frameId && isReader(id));
      const firstGlassIdx = readers.findIndex((id) => hasGlass(id));
      const firstGlassId = firstGlassIdx >= 0 ? readers[firstGlassIdx] : null;
      const firstGlassTreePos = firstGlassId ? subtree.indexOf(firstGlassId) : -1;

      const hideAfter = (stopId: string, includeStop: boolean) => {
        const pos = subtree.indexOf(stopId);
        const ops: Array<Record<string, unknown>> = [];
        for (let i = 1; i < subtree.length; i++) {
          const id = subtree[i] as string;
          const after = includeStop ? i >= pos : i > pos;
          if (after && !isAncestor(id, stopId)) {
            ops.push({ op: "set", id, prop: "visible", value: false });
          }
        }
        mustCommit(ops);
      };

      try {
        for (const spec of specs) {
          const applyFlatten = () => {
            if (!spec.flattenLowerFadedGroup) return;
            for (const id of subtree) {
              const n = doc.get(id);
              if (!n || id === frameId) continue;
              const op = typeof n.props.opacity === "number" ? n.props.opacity : 1;
              const kids = doc.childIds(id);
              if (op < 1 && kids.length === 1 && hasGlass(kids[0] as string)) {
                mustCommit([
                  { op: "set", id, prop: "opacity", value: 1 },
                  { op: "set", id: kids[0], prop: "opacity", value: op },
                ]);
              }
            }
          };
          const resetToBase = () => {
            restore();
            applyFlatten();
          };

          resetToBase();

          if (spec.onlyReaderIndex !== undefined) {
            const ops: Array<Record<string, unknown>> = [];
            for (let i = 0; i < readers.length; i++) {
              if (i !== spec.onlyReaderIndex) {
                ops.push({ op: "set", id: readers[i], prop: "visible", value: false });
              }
            }
            mustCommit(ops);
            const bmp = await renderNode(frameId);
            const out = new OffscreenCanvas(width, height);
            (out.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(bmp, 0, 0);
            results[spec.key] = encodeCanvas(out);
            continue;
          }

          const model = spec.model;
          if (model === "a" || readers.length <= 1) {
            if (spec.stripLowerBgBlur && readers.length >= 2) {
              mustCommit([
                {
                  op: "set",
                  id: readers[0],
                  prop: "effects",
                  value: stripBgBlur(readers[0] as string),
                },
              ]);
            }
            const bmp = await renderNode(frameId);
            const out = new OffscreenCanvas(width, height);
            (out.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(bmp, 0, 0);
            results[spec.key] = encodeCanvas(out);
            continue;
          }

          const out = new OffscreenCanvas(width, height);
          const octx = out.getContext("2d") as OffscreenCanvasRenderingContext2D;

          const secondReader = readers[1] as string;
          hideAfter(secondReader, true);
          const prefixBmp = await renderNode(frameId);
          octx.drawImage(prefixBmp, 0, 0);

          for (let rIdx = 1; rIdx < readers.length; rIdx++) {
            const rid = readers[rIdx] as string;
            const ridPos = subtree.indexOf(rid);
            const isGlass = hasGlass(rid);
            const earlierReaders = readers.slice(0, rIdx);
            const applyBackdropRule = isGlass || model === "b*";
            const overlapsEarlierGlass = earlierReaders.some(
              (prev) => hasGlass(prev) && overlaps(prev, rid),
            );
            const savedNode = saved.get(rid);
            const origBlend =
              typeof savedNode?.blendMode === "string" ? savedNode.blendMode : "normal";
            const origOpacity = typeof savedNode?.opacity === "number" ? savedNode.opacity : 1;
            const needsPerRegionErase =
              model === "b2" &&
              applyBackdropRule &&
              overlapsEarlierGlass &&
              (origOpacity < 1 || (origBlend !== "normal" && origBlend !== "pass-through"));

            let noGlassPrefixBmp: ImageBitmap | null = null;
            if (needsPerRegionErase) {
              resetToBase();
              hideAfter(rid, true);
              const stripOps = earlierReaders
                .filter((id) => hasGlass(id))
                .map((id) => ({ op: "set", id, prop: "effects", value: stripGlass(id) }));
              mustCommit(stripOps);
              noGlassPrefixBmp = await renderNode(frameId);
            }

            resetToBase();
            const ops: Array<Record<string, unknown>> = [];
            if (applyBackdropRule) {
              if (model === "b" || model === "b*") {
                for (const prev of earlierReaders) {
                  if (hasGlass(prev)) {
                    ops.push({ op: "set", id: prev, prop: "effects", value: stripGlass(prev) });
                  }
                }
              } else if (model === "b2") {
                if (overlapsEarlierGlass) {
                  for (const prev of earlierReaders) {
                    if (hasGlass(prev) && overlaps(prev, rid)) {
                      ops.push({ op: "set", id: prev, prop: "effects", value: stripGlass(prev) });
                    }
                  }
                }
              } else if (model === "c1") {
                for (const prev of earlierReaders) {
                  if (hasGlass(prev) && !isAncestor(prev, rid)) {
                    ops.push({ op: "set", id: prev, prop: "visible", value: false });
                  } else if (hasGlass(prev)) {
                    ops.push(
                      { op: "set", id: prev, prop: "effects", value: stripGlass(prev) },
                      { op: "set", id: prev, prop: "fills", value: [] },
                      { op: "set", id: prev, prop: "strokes", value: [] },
                    );
                    for (let i = subtree.indexOf(prev) + 1; i < ridPos; i++) {
                      const desc = subtree[i] as string;
                      if (isAncestor(prev, desc) && !isAncestor(desc, rid)) {
                        ops.push({ op: "set", id: desc, prop: "visible", value: false });
                      }
                    }
                  }
                }
              } else if (model === "c2") {
                for (const prev of earlierReaders) {
                  if (hasGlass(prev)) {
                    ops.push(
                      { op: "set", id: prev, prop: "effects", value: stripGlass(prev) },
                      { op: "set", id: prev, prop: "fills", value: [] },
                      { op: "set", id: prev, prop: "strokes", value: [] },
                    );
                  }
                }
              } else if (model === "d" && firstGlassTreePos >= 0) {
                for (let i = firstGlassTreePos; i < ridPos; i++) {
                  const nid = subtree[i] as string;
                  if (!isAncestor(nid, rid)) {
                    ops.push({ op: "set", id: nid, prop: "visible", value: false });
                  } else {
                    ops.push(
                      { op: "set", id: nid, prop: "effects", value: stripGlass(nid) },
                      { op: "set", id: nid, prop: "fills", value: [] },
                      { op: "set", id: nid, prop: "strokes", value: [] },
                    );
                  }
                }
              }
            }
            if (spec.stripLowerBgBlur) {
              for (const prev of earlierReaders) {
                if (hasBgBlur(prev)) {
                  ops.push({ op: "set", id: prev, prop: "effects", value: stripBgBlur(prev) });
                }
              }
            }
            if (spec.omitLowerLayer && earlierReaders.length > 0) {
              for (const prev of earlierReaders) {
                if (!isAncestor(prev, rid)) {
                  ops.push({ op: "set", id: prev, prop: "visible", value: false });
                }
              }
            }
            // Render `rid` isolated with normal blend so its own fills composite normally over
            // its glass, then composite `layerBmp` onto `out` using `origBlend`.
            if (origBlend !== "normal" && origBlend !== "pass-through") {
              ops.push({ op: "set", id: rid, prop: "blendMode", value: "normal" });
            }
            mustCommit(ops);

            const layerBmp = await renderNode(rid);

            if (model === "b2" && noGlassPrefixBmp) {
              // Erase lower glass across 100% of `rid`'s footprint (regardless of `rid`'s opacity).
              let shapeMaskBmp = layerBmp;
              if (origOpacity < 1) {
                mustCommit([{ op: "set", id: rid, prop: "opacity", value: 1 }]);
                shapeMaskBmp = await renderNode(rid);
              }
              const mask = new OffscreenCanvas(width, height);
              const mctx = mask.getContext("2d") as OffscreenCanvasRenderingContext2D;
              mctx.drawImage(noGlassPrefixBmp, 0, 0);
              mctx.globalCompositeOperation = "destination-in";
              mctx.drawImage(shapeMaskBmp, 0, 0);
              octx.save();
              octx.globalCompositeOperation = "source-over";
              octx.drawImage(mask, 0, 0);
              octx.restore();
            }

            octx.save();
            octx.globalCompositeOperation =
              origBlend === "normal" || origBlend === "pass-through"
                ? "source-over"
                : (origBlend as GlobalCompositeOperation);
            octx.drawImage(layerBmp, 0, 0);
            octx.restore();

            const nextReaderPos =
              rIdx + 1 < readers.length
                ? subtree.indexOf(readers[rIdx + 1] as string)
                : subtree.length;
            for (let i = ridPos + 1; i < nextReaderPos; i++) {
              const nid = subtree[i] as string;
              if (isAncestor(rid, nid)) continue;
              resetToBase();
              const siblingBmp = await renderNode(nid);
              octx.drawImage(siblingBmp, 0, 0);
            }
          }

          results[spec.key] = encodeCanvas(out);
        }
        return results;
      } finally {
        restore();
      }
    },
    { frameId, rect, scale: SCALE, specs },
  );
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(b64Map)) out[k] = Buffer.from(v, "base64");
  return out;
}

test("reproduces the stacked-glass candidate sweep and diff-params residual attribution", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const port = Number(process.env.PARITY_PORT ?? 8947);
  const instance: Instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  try {
    const page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    const suite = JSON.parse(
      readFileSync(join(ROOT, "scenes", "glass-stack.json"), "utf8"),
    ) as Suite;
    const grid = gridSize(suite);
    await page.setViewportSize({
      width: Math.min(2400, grid.width * SCALE + 200),
      height: Math.min(2000, grid.height * SCALE + 200),
    });
    await page.goto("/");
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    const frames = await build(page, suite);
    await waitForFonts(page, suite);
    await page.waitForTimeout(800);

    const table: Record<
      string,
      Record<ModelKey, { mean: number; p99: number; worstTile: number }>
    > = {};
    const roisByCell: Record<string, Record<string, RoiStats>> = {};
    const totals: Record<ModelKey, { mean: number; p99: number }> = Object.fromEntries(
      MODELS.map((m) => [m, { mean: 0, p99: 0 }]),
    ) as Record<ModelKey, { mean: number; p99: number }>;

    const controls: Record<string, unknown> = {};

    for (const [i, cell] of suite.cells.entries()) {
      const goldenPath = join(ROOT, "goldens", "glass-stack", `${cell.id}.png`);
      const rect = exportRect(suite, i);
      const width = rect.width * SCALE;
      const height = rect.height * SCALE;
      const theirs = await decodePng(page, goldenPath);
      expect(theirs.width).toBe(width);
      const want = Buffer.from(theirs.data, "base64");
      const boxes = collectBoxes(cell.layers);
      const flatten = cell.id === "lower-faded-group";

      const specs: RenderSpec[] = MODELS.map((m) => ({
        key: m,
        model: m,
        flattenLowerFadedGroup: flatten,
      }));
      if (cell.id === "bg-blur-over-glass") {
        specs.push({ key: "omit-lower", model: "b*", omitLowerLayer: true });
      }
      if (cell.id === "lower-faded-group") {
        specs.push({ key: "raw-canvas", model: "a", flattenLowerFadedGroup: false });
      }
      if (cell.id === "over-bg-blur") {
        specs.push({ key: "strip-lower-bg-blur", model: "b*", stripLowerBgBlur: true });
      }
      if (cell.id === "diff-params" || cell.id === "partial-overlap") {
        specs.push(
          { key: "only-lower", model: "a", onlyReaderIndex: 0 },
          { key: "only-upper", model: "a", onlyReaderIndex: 1 },
        );
      }

      const rendered = await renderCellSpecs(page, frames[i] as string, rect, specs);

      const row = {} as Record<ModelKey, { mean: number; p99: number; worstTile: number }>;
      table[cell.id] = row;
      for (const m of MODELS) {
        const got = rendered[m] as Uint8Array;
        const r = scoreRois(got, want, width, height, boxes);
        const all = r.all as RoiStats;
        row[m] = { mean: all.mean, p99: all.p99, worstTile: all.worstTile };
        totals[m].mean += all.mean;
        totals[m].p99 += all.p99;
        if (m === "b*") roisByCell[cell.id] = r;

        if (cell.id === "bg-blur-over-glass" && (m === "b*" || m === "a")) {
          controls[`bg-blur-over-glass:overlap:${m}`] = scoreBoxRoi(got, want, width, {
            x0: 90,
            y0: 20,
            x1: 150,
            y1: 140,
          });
        }
        if (cell.id === "adjacent-frost" && (m === "b*" || m === "a")) {
          controls[`adjacent-frost:seam:${m}`] = scoreBoxRoi(got, want, width, {
            x0: 120,
            y0: 20,
            x1: 160,
            y1: 140,
          });
        }
        if (cell.id === "lower-faded-group" && (m === "b*" || m === "a" || m === "c1")) {
          controls[`lower-faded-group:overlap:${m}`] = scoreBoxRoi(got, want, width, {
            x0: 90,
            y0: 20,
            x1: 150,
            y1: 140,
          });
        }
      }

      if (cell.id === "bg-blur-over-glass") {
        controls["bg-blur-over-glass:overlap:omit-lower"] = scoreBoxRoi(
          rendered["omit-lower"] as Uint8Array,
          want,
          width,
          { x0: 90, y0: 20, x1: 150, y1: 140 },
        );
      }
      if (cell.id === "lower-faded-group") {
        controls["lower-faded-group:raw-canvas"] = scoreRois(
          rendered["raw-canvas"] as Uint8Array,
          want,
          width,
          height,
          boxes,
        ).all;
      }
      if (cell.id === "over-bg-blur") {
        controls["over-bg-blur:strip-lower-bg-blur"] = scoreRois(
          rendered["strip-lower-bg-blur"] as Uint8Array,
          want,
          width,
          height,
          boxes,
        ).all;
      }
      if (cell.id === "diff-params" || cell.id === "partial-overlap") {
        const lowerOnly = rendered["only-lower"] as Uint8Array;
        const upperOnly = rendered["only-upper"] as Uint8Array;
        controls[`${cell.id}:single-lower-in-lower-only-roi`] = scoreBoxRoi(
          lowerOnly,
          want,
          width,
          { x0: 20, y0: 20, x1: 90, y1: 140 },
        );
        controls[`${cell.id}:single-upper-in-upper-only-roi`] = scoreBoxRoi(
          upperOnly,
          want,
          width,
          { x0: 150, y0: 20, x1: 220, y1: 140 },
        );
        controls[`${cell.id}:single-upper-in-overlap-roi`] = scoreBoxRoi(upperOnly, want, width, {
          x0: 90,
          y0: 20,
          x1: 150,
          y1: 140,
        });
      }
    }

    const n = suite.cells.length;
    const averages = Object.fromEntries(
      MODELS.map((m) => [
        m,
        {
          mean: Math.round((totals[m].mean / n) * 100) / 100,
          avgCellP99: Math.round(totals[m].p99 / n),
        },
      ]),
    ) as Record<ModelKey, { mean: number; avgCellP99: number }>;

    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "results.json"),
      `${JSON.stringify({ averages, table, roisByCell, controls }, null, 2)}\n`,
    );

    console.log("Candidate model averages across 15 cells:", JSON.stringify(averages));
    console.log("Controls:", JSON.stringify(controls, null, 2));
    console.log("b* ROI breakdown:", JSON.stringify(roisByCell, null, 2));

    // Verify b* is the lowest-error tested candidate overall and beats faithful nesting clearly.
    for (const m of MODELS) {
      if (m !== "b*") {
        expect(averages["b*"].mean, `b* should beat ${m}`).toBeLessThan(averages[m].mean);
      }
    }
    // Verify the diff-params p99=121 tail originates in the single-lens lower card, not overlap.
    const diffRoi = roisByCell["diff-params"] as Record<string, RoiStats>;
    expect(diffRoi.one?.p99 ?? 0).toBeGreaterThan((diffRoi.overlap?.p99 ?? 0) * 2);
  } finally {
    await instance.stop();
  }
});
