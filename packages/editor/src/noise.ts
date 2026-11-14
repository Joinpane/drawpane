/**
 * The noise effect (decision 0008): grain over a layer, only where it
 * paints.
 *
 * A tile of NOISE_TILE × NOISE_TILE cells, one pixel each, is made once per
 * look from a fixed seed, and drawn as a pattern over the layer's picture
 * with `source-atop`: it lands only where the layer paints, and keeps its
 * edges. The pattern follows the layer's transform at `size` units a cell,
 * so the grain moves, scales and turns with the layer and doesn't crawl as
 * the view pans. It's all 2D canvas: no per-pixel work in a frame.
 */
import type { Noise } from "@drawpane/model";
import type { Matrix } from "./geometry";
import { type AnyCanvas, type Ctx, scratch } from "./webgl";

/** Cells along a tile's side. Big enough that its repeat doesn't show in grain. */
export const NOISE_TILE = 128;

/** The seed every noise tile starts from, so a file looks the same on every screen. */
const SEED = 0x5eed_d9a1;

/** mulberry32: a tiny seeded generator, uniform on [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `#rrggbb[aa]` as straight RGBA bytes. */
function rgba(hex: string): [number, number, number, number] {
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length > 7 ? n(7) : 255];
}

/** What a noise tile depends on: not its size, which only scales the pattern. */
export type NoiseLook = Pick<
  Noise,
  "noiseType" | "density" | "color" | "secondaryColor" | "opacity"
>;

/**
 * A noise tile's pixels, straight (not premultiplied) RGBA, one per cell.
 * Every cell draws the same four numbers whatever the look, so which cells
 * are on doesn't change with the kind or the colours, only with the density.
 */
export function noisePixels(look: NoiseLook, side = NOISE_TILE): Uint8ClampedArray<ArrayBuffer> {
  const random = seeded(SEED);
  const pixels = new Uint8ClampedArray(side * side * 4);
  const density = Math.min(1, Math.max(0, look.density / 100));
  const on = rgba(look.color);
  const off = rgba(look.secondaryColor);
  const multiAlpha = Math.round(Math.min(1, Math.max(0, look.opacity / 100)) * 255);
  for (let i = 0; i < side * side; i++) {
    const lit = random() < density;
    const r = random();
    const g = random();
    const b = random();
    let px: readonly number[] | null = null;
    if (look.noiseType === "multi") {
      if (lit) px = [r * 256, g * 256, b * 256, multiAlpha];
    } else if (lit) px = on;
    else if (look.noiseType === "duo") px = off;
    if (px) pixels.set(px, i * 4);
  }
  return pixels;
}

function lookKey(look: NoiseLook): string {
  return look.noiseType === "multi"
    ? `multi ${look.density} ${look.opacity}`
    : look.noiseType === "duo"
      ? `duo ${look.density} ${look.color} ${look.secondaryColor}`
      : `mono ${look.density} ${look.color}`;
}

/** The tiles a renderer has made, by look; the least recently used go past a few. */
export class NoiseTiles {
  readonly #tiles = new Map<string, AnyCanvas>();
  readonly #limit: number;

  constructor(limit = 12) {
    this.#limit = limit;
  }

  /** The tile for a look, made on first use; null with no canvas to make it on. */
  get(look: NoiseLook): AnyCanvas | null {
    const key = lookKey(look);
    const kept = this.#tiles.get(key);
    if (kept) {
      // Most recently used goes last.
      this.#tiles.delete(key);
      this.#tiles.set(key, kept);
      return kept;
    }
    const tile = scratch(null, NOISE_TILE, NOISE_TILE);
    const ctx = tile?.getContext("2d") as Ctx | null | undefined;
    if (!tile || !ctx) return null;
    ctx.putImageData(new ImageData(noisePixels(look), NOISE_TILE, NOISE_TILE), 0, 0);
    this.#tiles.set(key, tile);
    for (const old of this.#tiles.keys()) {
      if (this.#tiles.size <= this.#limit) break;
      this.#tiles.delete(old);
    }
    return tile;
  }
}

/**
 * Draws `noise` over the w × h pixels at the canvas's top left, only where
 * they have something: draw the layer alone there first. `layer` takes the
 * layer's own units to the canvas's pixels.
 */
export function paintNoise(
  ctx: Ctx,
  tiles: NoiseTiles,
  noise: Noise,
  layer: Matrix,
  w: number,
  h: number,
): void {
  if (typeof DOMMatrix === "undefined") return;
  const tile = tiles.get(noise);
  const pattern = tile ? ctx.createPattern(tile, "repeat") : null;
  if (!pattern) return;
  const [a, b, c, d, e, f] = layer;
  const s = noise.size;
  pattern.setTransform(new DOMMatrix([a * s, b * s, c * s, d * s, e, f]));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-atop";
  // Crisp square cells; smoothed only when they're smaller than a pixel, where crisp would shimmer.
  ctx.imageSmoothingEnabled = Math.hypot(a, b) * s < 1;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
