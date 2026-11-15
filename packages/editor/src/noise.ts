/**
 * The noise effect (decision 0008, revised by 0013): grain over a layer,
 * only where it paints.
 *
 * Grain is Figma's: blobs where a smooth noise field rises past a
 * threshold, with soft edges, about `size` units across. Density sets the
 * threshold, as Figma does: measured against its renders, the field (three
 * octaves of gradient noise, standardised) is cut at z = 2.82 − 2.85 ×
 * density deviations, which covers 1.3% of the layer at 20% density, 8.6%
 * at 50% and a third at 85% (about half at 100%).
 *
 * A tile of that field, NOISE_TILE pixels square at PIXELS_PER_UNIT pixels a
 * size unit and periodic so it repeats seamlessly, is made once per look
 * from a fixed seed, and drawn as a pattern over the layer's picture with
 * `source-atop`: it lands only where the layer paints, and keeps its edges.
 * The pattern follows the layer's transform, so the grain moves, scales and
 * turns with the layer and doesn't crawl as the view pans. It's all 2D
 * canvas: no per-pixel work in a frame.
 */
import type { Noise } from "@drawpane/model";
import type { Matrix } from "./geometry";
import { type AnyCanvas, type Ctx, scratch } from "./webgl";

/** Tile pixels per size unit: enough for a blob's soft edge to stay smooth when drawn larger. */
export const PIXELS_PER_UNIT = 4;
/** Size units per lattice cell of the noise: blobs past the threshold come out about a unit across. */
const UNITS_PER_CELL = 1.25;
/** Lattice cells along a tile's side: big enough that its repeat doesn't show in grain. */
const CELLS = 64;
/** A tile's side, in pixels. */
export const NOISE_TILE = CELLS * UNITS_PER_CELL * PIXELS_PER_UNIT;

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

/** Where density puts the cut, in the field's standard deviations (fitted to Figma's renders). */
export function noiseThresholdZ(density: number): number {
  return 2.82 - 2.85 * Math.min(1, Math.max(0, density / 100));
}

/**
 * Periodic gradient noise (Perlin's), `period` lattice cells across a tile
 * of `side` pixels: smooth, about zero on average, and seamless when tiled.
 */
function gradientNoise(period: number, side: number, random: () => number): Float32Array {
  const gx = new Float32Array(period * period);
  const gy = new Float32Array(period * period);
  for (let i = 0; i < period * period; i++) {
    const a = random() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const out = new Float32Array(side * side);
  const scale = period / side;
  for (let y = 0; y < side; y++) {
    const fy = (y + 0.5) * scale;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const v = fade(ty);
    const r0 = (y0 % period) * period;
    const r1 = ((y0 + 1) % period) * period;
    for (let x = 0; x < side; x++) {
      const fx = (x + 0.5) * scale;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const u = fade(tx);
      const c0 = x0 % period;
      const c1 = (x0 + 1) % period;
      const dot = (i: number, dx: number, dy: number) =>
        (gx[i] as number) * dx + (gy[i] as number) * dy;
      const n00 = dot(r0 + c0, tx, ty);
      const n10 = dot(r0 + c1, tx - 1, ty);
      const n01 = dot(r1 + c0, tx, ty - 1);
      const n11 = dot(r1 + c1, tx - 1, ty - 1);
      const top = n00 + (n10 - n00) * u;
      const bottom = n01 + (n11 - n01) * u;
      out[y * side + x] = top + (bottom - top) * v;
    }
  }
  return out;
}

/** A field's values as standard deviations from its mean. */
function standardise(field: Float32Array): Float32Array {
  let sum = 0;
  for (const v of field) sum += v;
  const mean = sum / field.length;
  let sq = 0;
  for (const v of field) sq += (v - mean) ** 2;
  const sd = Math.sqrt(sq / field.length) || 1;
  for (let i = 0; i < field.length; i++) field[i] = ((field[i] as number) - mean) / sd;
  return field;
}

/** What a noise tile depends on: not its size, which only scales the pattern. */
export type NoiseLook = Pick<
  Noise,
  "noiseType" | "density" | "color" | "secondaryColor" | "opacity"
>;

/** The grain field, standardised, made once per tile size (it doesn't depend on the look). */
const fields = new Map<
  number,
  { grain: Float32Array; second: Float32Array; hues: Float32Array[] }
>();
function grainField(side: number) {
  let kept = fields.get(side);
  if (!kept) {
    const random = seeded(SEED);
    const cells = Math.max(1, Math.round(side / (UNITS_PER_CELL * PIXELS_PER_UNIT)));
    // Three octaves: blobs with irregular, slightly ragged edges, like Figma's.
    const field = () => {
      const a = gradientNoise(cells, side, random);
      const b = gradientNoise(cells * 2, side, random);
      const c = gradientNoise(cells * 4, side, random);
      for (let i = 0; i < a.length; i++)
        a[i] = (a[i] as number) + 0.5 * (b[i] as number) + 0.25 * (c[i] as number);
      return standardise(a);
    };
    const grain = field();
    // Duo's second colour: grain of its own, between the first's.
    const second = field();
    // Multi's colours: three slower fields, so each blob takes a colour of its own.
    const hues = [0, 1, 2].map(() =>
      standardise(gradientNoise(Math.max(1, cells >> 1), side, random)),
    );
    kept = { grain, second, hues };
    fields.set(side, kept);
  }
  return kept;
}

/** How soft a blob's edge is, in the field's deviations: about a tile pixel wide. */
const EDGE = 0.1;

/**
 * A noise tile's pixels, straight (not premultiplied) RGBA. Where grain is
 * doesn't depend on the kind or the colours, only on the density.
 */
export function noisePixels(look: NoiseLook, side = NOISE_TILE): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(side * side * 4);
  if (look.density <= 0) return pixels;
  const { grain, second, hues } = grainField(side);
  const z = noiseThresholdZ(look.density);
  const on = rgba(look.color);
  const off = rgba(look.secondaryColor);
  const multiAlpha = Math.min(1, Math.max(0, look.opacity / 100)) * 255;
  for (let i = 0; i < side * side; i++) {
    // How much of this pixel is grain: 0 outside a blob, 1 inside, soft across its edge.
    const k = Math.min(1, Math.max(0, ((grain[i] as number) - z) / EDGE + 0.5));
    const o = i * 4;
    if (look.noiseType === "duo") {
      // Two sets of grain, each as dense: the first colour's, and the second's between them
      // (where both rise past the cut, the one further past it).
      const e1 = (grain[i] as number) - z;
      const e2 = (second[i] as number) - z;
      const firstWins = e1 >= e2;
      const c = firstWins ? on : off;
      const strength = Math.min(1, Math.max(0, (firstWins ? e1 : e2) / EDGE + 0.5));
      if (strength > 0) {
        pixels.set(c.slice(0, 3), o);
        pixels[o + 3] = c[3] * strength;
      }
    } else if (k > 0) {
      if (look.noiseType === "multi") {
        for (let c = 0; c < 3; c++)
          pixels[o + c] = 128 + 110 * Math.max(-1, Math.min(1, (hues[c]?.[i] ?? 0) / 1.5));
        pixels[o + 3] = multiAlpha * k;
      } else {
        pixels.set(on.slice(0, 3), o);
        pixels[o + 3] = on[3] * k;
      }
    }
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
  // A tile pixel is a fraction of a size unit.
  const s = noise.size / PIXELS_PER_UNIT;
  pattern.setTransform(new DOMMatrix([a * s, b * s, c * s, d * s, e, f]));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-atop";
  // Blobs have soft edges: smoothed when drawn larger or smaller than the tile.
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
