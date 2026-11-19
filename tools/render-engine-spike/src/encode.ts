/**
 * The display list's wire format (decision 0040, "The boundary"), written from TypeScript and
 * read by `engine/src/dl.rs`: little-endian 32-bit words, an opcode then its operands. Paths
 * are verbs (one word each in the spike) and coordinates; colours straight RGBA floats; every
 * transform maps the op's local units to device pixels.
 */

export const MAGIC = 0x4c445044; // "DPDL", little-endian
export const VERSION = 1;

export const OP = {
  fill: 1,
  stroke: 2,
  pushClip: 3,
  pushGroup: 4,
  pushBlur: 5,
  pop: 6,
  pushIsolate: 7,
  glass: 8,
} as const;

/** Figma's blends, as the engine numbers them; 100 and up are drawn apart by a kernel. */
export const BLENDS: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  "color-dodge": 6,
  "color-burn": 7,
  "hard-light": 8,
  "soft-light": 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  "linear-dodge": 100,
  "linear-burn": 101,
};

export type Matrix = readonly [number, number, number, number, number, number];
export type Rgba = readonly [number, number, number, number];
export type Bounds = readonly [number, number, number, number];

/** A path in local units, as verbs and points. */
export class Path {
  readonly verbs: number[] = [];
  readonly coords: number[] = [];
  moveTo(x: number, y: number): this {
    this.verbs.push(0);
    this.coords.push(x, y);
    return this;
  }
  lineTo(x: number, y: number): this {
    this.verbs.push(1);
    this.coords.push(x, y);
    return this;
  }
  quadTo(x1: number, y1: number, x: number, y: number): this {
    this.verbs.push(2);
    this.coords.push(x1, y1, x, y);
    return this;
  }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.verbs.push(3);
    this.coords.push(x1, y1, x2, y2, x, y);
    return this;
  }
  close(): this {
    this.verbs.push(4);
    return this;
  }
  append(other: Path): this {
    this.verbs.push(...other.verbs);
    this.coords.push(...other.coords);
    return this;
  }
  get empty(): boolean {
    return this.verbs.length === 0;
  }
}

export interface GlassOperands {
  readonly transform: Matrix;
  readonly w: number;
  readonly h: number;
  readonly radii: readonly [number, number, number, number];
  readonly refraction: number;
  readonly depth: number;
  readonly dispersion: number;
  readonly frost: number;
  readonly splay: number;
  readonly light: readonly [number, number];
  readonly intensity: number;
  readonly unitPx: number;
  readonly falloff: number;
  readonly hairline: number;
  readonly front: number;
  readonly frontStart: number;
  readonly back: number;
  readonly backStart: number;
  readonly shade: number;
  readonly shadeReach: number;
  readonly region: Bounds;
  readonly margin: number;
}

export interface StrokeOperands {
  readonly width: number;
  readonly join: "miter" | "round" | "bevel";
  readonly cap: "butt" | "round" | "square";
  readonly miter: number;
  readonly dashes: readonly number[];
  readonly dashOffset: number;
}

const JOIN = { miter: 0, round: 1, bevel: 2 } as const;
const CAP = { butt: 0, round: 1, square: 2 } as const;

/** Writes ops into a growing buffer. */
export class Encoder {
  #buf = new ArrayBuffer(1 << 16);
  #view = new DataView(this.#buf);
  #at = 0;
  /** Ops written, by opcode, for the report. */
  readonly counts = new Map<number, number>();

  constructor(width: number, height: number) {
    this.#u32(MAGIC);
    this.#u32(VERSION);
    this.#u32(width);
    this.#u32(height);
  }

  #room(bytes: number): void {
    if (this.#at + bytes <= this.#buf.byteLength) return;
    let size = this.#buf.byteLength * 2;
    while (size < this.#at + bytes) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.#buf, 0, this.#at));
    this.#buf = next;
    this.#view = new DataView(next);
  }
  #u32(v: number): void {
    this.#room(4);
    this.#view.setUint32(this.#at, v >>> 0, true);
    this.#at += 4;
  }
  #f32(v: number): void {
    this.#room(4);
    this.#view.setFloat32(this.#at, v, true);
    this.#at += 4;
  }
  #op(code: number): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    this.#u32(code);
  }
  #matrix(m: Matrix): void {
    for (const v of m) this.#f32(v);
  }
  #rgba(c: Rgba): void {
    for (const v of c) this.#f32(v);
  }
  #bounds(b: Bounds): void {
    for (const v of b) this.#f32(v);
  }
  #path(p: Path): void {
    this.#u32(p.verbs.length);
    let at = 0;
    const take = (n: number) => {
      for (let i = 0; i < n; i++) this.#f32(p.coords[at++] as number);
    };
    for (const verb of p.verbs) {
      this.#u32(verb);
      take(verb === 0 || verb === 1 ? 2 : verb === 2 ? 4 : verb === 3 ? 6 : 0);
    }
  }

  fill(transform: Matrix, path: Path, evenOdd: boolean, color: Rgba): void {
    this.#op(OP.fill);
    this.#matrix(transform);
    this.#path(path);
    this.#u32(evenOdd ? 1 : 0);
    this.#rgba(color);
  }
  stroke(transform: Matrix, path: Path, s: StrokeOperands, color: Rgba): void {
    this.#op(OP.stroke);
    this.#matrix(transform);
    this.#path(path);
    this.#f32(s.width);
    this.#u32(JOIN[s.join]);
    this.#u32(CAP[s.cap]);
    this.#f32(s.miter);
    this.#u32(s.dashes.length);
    for (const d of s.dashes) this.#f32(d);
    this.#f32(s.dashOffset);
    this.#rgba(color);
  }
  pushClip(transform: Matrix, path: Path, evenOdd = false): void {
    this.#op(OP.pushClip);
    this.#matrix(transform);
    this.#path(path);
    this.#u32(evenOdd ? 1 : 0);
  }
  pushGroup(opacity: number, blend: number): void {
    this.#op(OP.pushGroup);
    this.#f32(opacity);
    this.#u32(blend);
  }
  pushBlur(sigma: number): void {
    this.#op(OP.pushBlur);
    this.#f32(sigma);
  }
  pop(): void {
    this.#op(OP.pop);
  }
  pushIsolate(blend: number, opacity: number, bounds: Bounds): void {
    this.#op(OP.pushIsolate);
    this.#u32(blend);
    this.#f32(opacity);
    this.#bounds(bounds);
  }
  glass(g: GlassOperands): void {
    this.#op(OP.glass);
    this.#matrix(g.transform);
    this.#f32(g.w);
    this.#f32(g.h);
    for (const r of g.radii) this.#f32(r);
    for (const v of [
      g.refraction,
      g.depth,
      g.dispersion,
      g.frost,
      g.splay,
      g.light[0],
      g.light[1],
      g.intensity,
      g.unitPx,
      g.falloff,
      g.hairline,
      g.front,
      g.frontStart,
      g.back,
      g.backStart,
      g.shade,
      g.shadeReach,
    ])
      this.#f32(v);
    this.#bounds(g.region);
    this.#f32(g.margin);
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.#buf.slice(0, this.#at));
  }
}

/** Absolute SVG path data (M L H V Q C Z, as the editor writes outlines) as a Path. */
export function parseSvgPath(d: string, into = new Path()): Path {
  const re = /([MLHVQCZ])([^MLHVQCZ]*)/gi;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  for (let m = re.exec(d); m !== null; m = re.exec(d)) {
    const letter = (m[1] as string).toUpperCase();
    const n = (m[2] as string)
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (letter === "Z") {
      into.close();
      x = sx;
      y = sy;
      continue;
    }
    const step = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6 }[letter] ?? 2;
    for (let i = 0; i + step <= n.length; i += step) {
      const a = n.slice(i, i + step) as number[];
      if (letter === "M" && i === 0) {
        into.moveTo(a[0] as number, a[1] as number);
        [x, y, sx, sy] = [a[0] as number, a[1] as number, a[0] as number, a[1] as number];
      } else if (letter === "M" || letter === "L") {
        into.lineTo(a[0] as number, a[1] as number);
        [x, y] = [a[0] as number, a[1] as number];
      } else if (letter === "H") {
        x = a[0] as number;
        into.lineTo(x, y);
      } else if (letter === "V") {
        y = a[0] as number;
        into.lineTo(x, y);
      } else if (letter === "Q") {
        into.quadTo(a[0] as number, a[1] as number, a[2] as number, a[3] as number);
        [x, y] = [a[2] as number, a[3] as number];
      } else {
        into.cubicTo(
          a[0] as number,
          a[1] as number,
          a[2] as number,
          a[3] as number,
          a[4] as number,
          a[5] as number,
        );
        [x, y] = [a[4] as number, a[5] as number];
      }
    }
  }
  return into;
}
