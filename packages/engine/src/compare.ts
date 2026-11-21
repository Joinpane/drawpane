/**
 * Scores for comparing two renders (decision 0040, "Parity gates"). Inputs are straight
 * (unpremultiplied) RGBA, as PNGs hold them.
 *
 * - `kit`: kit parity's own score (apps/web/e2e/kit-parity.spec.ts, `score`), both pictures
 *   over white: the mean difference over RGB (0 to 255, to a hundredth), the 99th percentile of
 *   each pixel's largest channel difference, and the share of pixels more than 32 apart. Kept so
 *   numbers compare with kit parity's, but it can't see alpha: transparent white and opaque white
 *   score 0 over white.
 * - The rest are what decision 0040 gates on, computed unrounded:
 *   - the same differences over black as well as white, so alpha errors count;
 *   - alpha itself, mean and largest;
 *   - the largest single difference;
 *   - the worst 32 × 32 tile's mean, so a small local defect (a missing symbol, a hairline)
 *     can't hide in a whole frame's average;
 *   - how many pixels are more than 16 apart, and the most of them in any tile.
 */
export interface Score {
  /** Kit parity's score: over white only. */
  readonly kit: { readonly mean: number; readonly p99: number; readonly changed: number };
  /** The larger of the means over white and over black (0 to 255, unrounded). */
  readonly mean: number;
  /** The larger of the 99th percentiles over white and over black. */
  readonly p99: number;
  /** The largest difference in any channel, over either background, or in alpha. */
  readonly max: number;
  readonly alphaMean: number;
  readonly alphaMax: number;
  /** The worst 32 × 32 tile's mean over either background (edge tiles count by their pixels). */
  readonly worstTile: number;
  readonly worstTileAt: readonly [number, number];
  /** Pixels more than 16 apart in any channel or alpha, and the most of them in one tile. */
  readonly severe: number;
  readonly severeInTile: number;
}

export const TILE = 32;
export const SEVERE = 16;

export function score(
  ours: Uint8Array | Uint8ClampedArray,
  theirs: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  includeHeat = true,
): Score & { heat: Uint8Array } {
  const n = width * height;
  if (ours.length !== n * 4 || theirs.length !== n * 4) throw new Error("Sizes differ");
  const backgrounds = [255, 0];
  const tilesX = Math.ceil(width / TILE);
  const tilesY = Math.ceil(height / TILE);
  const tileSum = new Float64Array(tilesX * tilesY * 2);
  const tileCount = new Uint32Array(tilesX * tilesY);
  const tileSevere = new Uint32Array(tilesX * tilesY);
  const histograms = [new Uint32Array(256), new Uint32Array(256)];
  const sums = [0, 0];
  const heat = new Uint8Array(includeHeat ? n * 4 : 0);
  let changedWhite = 0;
  let max = 0;
  let alphaSum = 0;
  let alphaMax = 0;
  let severe = 0;
  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const tile = Math.floor(y / TILE) * tilesX + Math.floor(x / TILE);
    tileCount[tile] = (tileCount[tile] ?? 0) + 1;
    const at = i * 4;
    const oa = ours[at + 3] as number;
    const ta = theirs[at + 3] as number;
    const da = Math.abs(oa - ta);
    const o = oa / 255;
    const t = ta / 255;
    alphaSum += da;
    if (da > alphaMax) alphaMax = da;
    let worst = da;
    for (let b = 0; b < 2; b++) {
      const level = backgrounds[b] as number;
      const backO = level * (1 - o);
      const backT = level * (1 - t);
      const dr = Math.abs(
        Math.round((ours[at] as number) * o + backO) -
          Math.round((theirs[at] as number) * t + backT),
      );
      const dg = Math.abs(
        Math.round((ours[at + 1] as number) * o + backO) -
          Math.round((theirs[at + 1] as number) * t + backT),
      );
      const db = Math.abs(
        Math.round((ours[at + 2] as number) * o + backO) -
          Math.round((theirs[at + 2] as number) * t + backT),
      );
      const mean = (dr + dg + db) / 3;
      sums[b] = (sums[b] as number) + mean;
      tileSum[tile * 2 + b] = (tileSum[tile * 2 + b] as number) + mean;
      const d = Math.max(dr, dg, db);
      const h = histograms[b] as Uint32Array;
      h[d] = (h[d] ?? 0) + 1;
      if (b === 0 && d > 32) changedWhite++;
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > SEVERE) {
      severe++;
      tileSevere[tile] = (tileSevere[tile] ?? 0) + 1;
    }
    if (includeHeat) {
      const v = Math.min(255, worst * 4);
      heat[at] = v;
      heat[at + 1] = v;
      heat[at + 2] = v;
      heat[at + 3] = 255;
    }
  }
  const p99Of = (h: Uint32Array) => {
    const at = Math.floor(n * 0.99);
    for (let v = 0, seen = 0; v < 256; v++) {
      seen += h[v] ?? 0;
      if (seen > at) return v;
    }
    return 255;
  };
  let worstTile = 0;
  let worstTileAt: [number, number] = [0, 0];
  let severeInTile = 0;
  for (let t = 0; t < tilesX * tilesY; t++) {
    const count = tileCount[t] ?? 1;
    const m = Math.max((tileSum[t * 2] ?? 0) / count, (tileSum[t * 2 + 1] ?? 0) / count);
    if (m > worstTile) {
      worstTile = m;
      worstTileAt = [(t % tilesX) * TILE, Math.floor(t / tilesX) * TILE];
    }
    severeInTile = Math.max(severeInTile, tileSevere[t] ?? 0);
  }
  const [white, black] = sums as [number, number];
  return {
    kit: {
      mean: Math.round((white / n) * 100) / 100,
      p99: p99Of(histograms[0] as Uint32Array),
      changed: Math.round((changedWhite / n) * 10000) / 10000,
    },
    mean: Math.max(white, black) / n,
    p99: Math.max(p99Of(histograms[0] as Uint32Array), p99Of(histograms[1] as Uint32Array)),
    max,
    alphaMean: alphaSum / n,
    alphaMax,
    worstTile,
    worstTileAt,
    severe,
    severeInTile,
    heat,
  };
}

/** Decision 0040's CPU-against-GPU tolerance, per frame. */
export const CPU_GPU_TOLERANCE = {
  mean: 0.25,
  p99: 4,
  worstTile: 2,
  /** No cluster: at most this many pixels more than 16 apart in any 32 × 32 tile. */
  severeInTile: 4,
} as const;

/** What breaks the tolerance, or nothing. */
export function outsideTolerance(
  s: Score,
  t: Pick<Score, keyof typeof CPU_GPU_TOLERANCE> = CPU_GPU_TOLERANCE,
): string[] {
  const out: string[] = [];
  if (s.mean > t.mean) out.push(`mean ${s.mean.toFixed(3)} > ${t.mean}`);
  if (s.p99 > t.p99) out.push(`p99 ${s.p99} > ${t.p99}`);
  if (s.worstTile > t.worstTile) out.push(`worst tile ${s.worstTile.toFixed(2)} > ${t.worstTile}`);
  if (s.severeInTile > t.severeInTile)
    out.push(`${s.severeInTile} severe pixels in one tile > ${t.severeInTile}`);
  return out;
}
