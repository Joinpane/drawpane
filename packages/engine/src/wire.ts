/**
 * The display list's wire format, written (docs/decisions/0040-display-list.md). The engine
 * reads it in `rust/src/wire.rs`, `record.rs` and `store.rs`; the numbers here must match.
 *
 * A message is little-endian words in one ArrayBuffer: a header, then commands, each an opcode,
 * its body's length in bytes, and its body. A message applies all or nothing, to the revision
 * it names.
 */

export const MAGIC = 0x4c445044; // "DPDL", little-endian
export const MAJOR = 1;
export const MINOR = 4;
/** A message with this base replaces everything; it starts with a reset. */
export const ANY_REVISION = 0xffffffff;
/** The page: the root top-level records hang from. */
export const ROOT = 0;

export const COMMAND = {
  reset: 1,
  glyph: 2,
  glyphFree: 3,
  set: 4,
  remove: 5,
  order: 6,
  transform: 7,
} as const;

/**
 * Record flags. `provisional`: sent ahead of its real drawing (text not shaped yet while a page
 * opens), drawn as its coarse ops at every scale and never exact; sent again whole soon after.
 * Bit 16 is reserved for phase 3B's `context` flag.
 */
export const FLAG = {
  hidden: 1,
  isolate: 2,
  group: 4,
  provisional: 8,
  post: 32,
  blend: 64,
  mask: 128,
  endsMask: 256,
} as const;
export const MASK = {
  outlineShapeNonZero: 1,
  outlineShapeEvenOdd: 2,
  outlinePicture: 3,
  alpha: 4,
  luminance: 5,
} as const;
export const POST = { layerBlur: 1 } as const;

export const PATH = {
  path: 1,
  rect: 2,
  ellipse: 3,
  glyphs: 4,
  outside: 5,
  box: 6,
  oval: 7,
} as const;
export const OP = {
  fill: 1,
  stroke: 2,
  clip: 3,
  unclip: 4,
  children: 5,
  read: 6,
  layer: 7,
  unlayer: 8,
  // 9..=12 reserved for phase 3B reader ops.
  dropShadow: 13,
  innerShadow: 14,
} as const;
export const BLEND = {
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
  "linear-dodge": 16,
  "linear-burn": 17,
} as const;
export const COMPOSE = { srcOver: 0, destOut: 1, destIn: 2 } as const;
export const PAINT = {
  solid: 1,
  linear: 2,
  radial: 3,
  angular: 4,
  diamond: 5,
  image: 6,
  placeholder: 7,
} as const;
export const VERB = { move: 0, line: 1, quad: 2, cubic: 3, close: 4 } as const;
export const JOIN = { miter: 0, round: 1, bevel: 2 } as const;
export const CAP = { butt: 0, round: 1, square: 2 } as const;

/**
 * Features a record needs that the engine doesn't draw yet (a bit each). The builder sets them;
 * the engine refuses to draw a record with any (`ErrorCode.Unsupported`), so a page holding one
 * falls back to the canvas renderer whole.
 */
export const UNSUPPORTED = {
  shadow: 1 << 0,
  layerBlur: 1 << 1,
  backgroundBlur: 1 << 2,
  glass: 1 << 3,
  noise: 1 << 4,
  texture: 1 << 5,
  mask: 1 << 6,
  blend: 1 << 7,
  textWithoutOutlines: 1 << 8,
  /** Retired in phase 3C (corner smoothing is drawn natively). Kept for bit stability. */
  cornerSmoothing: 1 << 9,
  progressiveBlur: 1 << 10,
  /** Retired in phase 3C (outside text strokes use OP.layer / OP.unlayer). Kept for bit stability. */
  textStrokeOutside: 1 << 11,
  /** Retired in phase 3C (diamond gradients are drawn natively). Kept for bit stability. */
  diamondGradient: 1 << 12,
  /** Set by the engine itself: a backdrop reader, outside the tests (phase 3). */
  backdropReader: 1 << 13,
} as const;
export type UnsupportedFeature = keyof typeof UNSUPPORTED;

export function unsupportedNames(bits: number): UnsupportedFeature[] {
  return (Object.keys(UNSUPPORTED) as UnsupportedFeature[]).filter((k) => bits & UNSUPPORTED[k]);
}

export type Matrix = readonly [number, number, number, number, number, number];
export type Rgba = readonly [number, number, number, number];

/** A path in local units, as verbs and coordinates (f32 on the wire). */
export class PathData {
  readonly verbs: number[] = [];
  readonly coords: number[] = [];
  moveTo(x: number, y: number): this {
    this.verbs.push(VERB.move);
    this.coords.push(x, y);
    return this;
  }
  lineTo(x: number, y: number): this {
    this.verbs.push(VERB.line);
    this.coords.push(x, y);
    return this;
  }
  quadTo(x1: number, y1: number, x: number, y: number): this {
    this.verbs.push(VERB.quad);
    this.coords.push(x1, y1, x, y);
    return this;
  }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.verbs.push(VERB.cubic);
    this.coords.push(x1, y1, x2, y2, x, y);
    return this;
  }
  close(): this {
    this.verbs.push(VERB.close);
    return this;
  }
  get empty(): boolean {
    return this.verbs.length === 0;
  }
}

export type PathEntry =
  | { readonly kind: "path"; readonly path: PathData }
  | {
      readonly kind: "rect";
      readonly w: number;
      readonly h: number;
      readonly radii: readonly [number, number, number, number];
      readonly smoothing: number;
    }
  | { readonly kind: "ellipse"; readonly w: number; readonly h: number }
  | {
      readonly kind: "glyphs";
      /** Font units to px; the engine flips y. */
      readonly scale: number;
      /** Glyph handle, then x and y of its origin on the baseline, in the layer's units. */
      readonly glyphs: readonly number[];
    }
  | { readonly kind: "outside"; readonly of: number }
  | {
      readonly kind: "box";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly radii: readonly [number, number, number, number];
      readonly smoothing: number;
    }
  | {
      readonly kind: "oval";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
    };

export interface GradientStop {
  readonly position: number;
  readonly color: Rgba;
}

export type WirePaint =
  | { readonly kind: "solid"; readonly color: Rgba; readonly blend?: number }
  | {
      readonly kind: "linear" | "radial" | "angular" | "diamond";
      /** The unit gradient into the layer's units. */
      readonly matrix: Matrix;
      readonly stops: readonly GradientStop[];
      readonly blend?: number;
    }
  | {
      readonly kind: "image";
      readonly image: number;
      /** The image's unit square into the layer's units (one tile, when tiled). */
      readonly matrix: Matrix;
      readonly tile: boolean;
      readonly opacity: number;
      readonly blend?: number;
    }
  /** The loading checkerboard, at the image paint's opacity. */
  | { readonly kind: "placeholder"; readonly opacity: number; readonly blend?: number };

export interface StrokeStyle {
  readonly width: number;
  readonly join: number;
  readonly cap: number;
  readonly miter: number;
  readonly dashes: readonly number[];
  readonly dashOffset: number;
}

export type WireOp =
  | {
      readonly op: "fill";
      readonly path: number;
      readonly evenOdd: boolean;
      readonly paint: WirePaint;
    }
  | {
      readonly op: "stroke";
      readonly path: number;
      readonly style: StrokeStyle;
      readonly paint: WirePaint;
    }
  | { readonly op: "clip"; readonly path: number; readonly evenOdd: boolean }
  | { readonly op: "unclip" }
  | { readonly op: "children" }
  | { readonly op: "read"; readonly kernel: number; readonly halo: number }
  | { readonly op: "layer"; readonly compose: number }
  | { readonly op: "unlayer" }
  | {
      readonly op: "dropShadow";
      readonly paths: readonly number[];
      readonly evenOdd: boolean;
      readonly dx: number;
      readonly dy: number;
      readonly blur: number;
      readonly color: Rgba;
      readonly blend: number;
      /** When set, cast the shadow by stroking `paths` with this style (open stroke-only layers). */
      readonly stroke?: StrokeStyle;
    }
  | {
      readonly op: "innerShadow";
      readonly shape: number;
      readonly hole: number | null;
      readonly evenOdd: boolean;
      readonly dx: number;
      readonly dy: number;
      readonly blur: number;
      readonly color: Rgba;
      readonly blend: number;
    };

export type WirePostEffect = { readonly kind: "layerBlur"; readonly radius: number };

export interface WireRecord {
  readonly flags: number;
  readonly opacity: number;
  /** Local units to the parent record's. */
  readonly transform: Matrix;
  readonly width: number;
  readonly height: number;
  /** Below this many device pixels per unit, `coarse` is drawn instead (0: never). */
  readonly coarseBelow: number;
  /** How far it may paint past its box, in its units (strokes, effects, overhanging type). */
  readonly reach: number;
  readonly unsupported: number;
  readonly paths: readonly PathEntry[];
  readonly ops: readonly WireOp[];
  readonly coarse: readonly WireOp[];
  readonly postEffects?: readonly WirePostEffect[];
  readonly blend?: number;
  readonly mask?: number;
}

const PAINT_KIND = PAINT;

/** Writes one message. */
export class ListWriter {
  #buf: ArrayBuffer;
  #view: DataView;
  #bytes: Uint8Array;
  #at = 0;
  #commands = 0;
  #countAt: number;

  constructor(base: number, revision: number, initial = 64 * 1024, minor = MINOR) {
    this.#buf = new ArrayBuffer(initial);
    this.#view = new DataView(this.#buf);
    this.#bytes = new Uint8Array(this.#buf);
    this.u32(MAGIC);
    this.#reserve(4);
    this.#view.setUint16(this.#at, MAJOR, true);
    this.#view.setUint16(this.#at + 2, minor, true);
    this.#at += 4;
    this.u32(base >>> 0);
    this.u32(revision >>> 0);
    this.#countAt = this.#at;
    this.u32(0);
  }

  get commands(): number {
    return this.#commands;
  }

  #reserve(n: number): void {
    if (this.#at + n <= this.#buf.byteLength) return;
    let size = this.#buf.byteLength * 2;
    while (size < this.#at + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.#bytes.subarray(0, this.#at));
    this.#buf = next;
    this.#view = new DataView(next);
    this.#bytes = new Uint8Array(next);
  }

  u32(v: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#at, v >>> 0, true);
    this.#at += 4;
  }
  // Numbers are written as they are: one that isn't finite (or overflows an f32) reaches the
  // engine as infinity or NaN, which refuses the message as malformed, never draws it as zero.
  f32(v: number): void {
    this.#reserve(4);
    this.#view.setFloat32(this.#at, v, true);
    this.#at += 4;
  }
  f64(v: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#at, v, true);
    this.#at += 8;
  }
  matrix(m: Matrix): void {
    for (const v of m) this.f64(v);
  }
  rgba(c: Rgba): void {
    for (const v of c) this.f32(v);
  }
  path(p: PathData): void {
    const n = p.verbs.length;
    this.u32(n);
    this.u32(p.coords.length);
    const padded = (n + 3) & ~3;
    this.#reserve(padded + p.coords.length * 4);
    for (let i = 0; i < padded; i++) this.#bytes[this.#at + i] = i < n ? (p.verbs[i] as number) : 0;
    this.#at += padded;
    for (const c of p.coords) {
      this.#view.setFloat32(this.#at, c, true);
      this.#at += 4;
    }
  }

  /** Writes a command: its opcode, then its body, then goes back to fill in the body's length. */
  #command(op: number, body: () => void): void {
    this.u32(op);
    const lengthAt = this.#at;
    this.u32(0);
    const start = this.#at;
    body();
    this.#view.setUint32(lengthAt, this.#at - start, true);
    this.#commands++;
  }

  reset(): void {
    this.#command(COMMAND.reset, () => {});
  }
  glyph(id: number, path: PathData): void {
    this.#command(COMMAND.glyph, () => {
      this.u32(id);
      this.path(path);
    });
  }
  glyphFree(id: number): void {
    this.#command(COMMAND.glyphFree, () => this.u32(id));
  }
  remove(id: number): void {
    this.#command(COMMAND.remove, () => this.u32(id));
  }
  order(parent: number, ids: readonly number[]): void {
    this.#command(COMMAND.order, () => {
      this.u32(parent);
      this.u32(ids.length);
      for (const id of ids) this.u32(id);
    });
  }
  transform(id: number, m: Matrix): void {
    this.#command(COMMAND.transform, () => {
      this.u32(id);
      this.matrix(m);
    });
  }
  set(id: number, parent: number, r: WireRecord): void {
    this.#command(COMMAND.set, () => {
      this.u32(id);
      this.u32(parent);
      this.u32(r.flags);
      this.f32(r.opacity);
      this.matrix(r.transform);
      this.f32(r.width);
      this.f32(r.height);
      this.f32(r.coarseBelow);
      this.f32(Math.max(0, r.reach));
      this.u32(r.unsupported);
      this.u32(r.paths.length);
      for (const p of r.paths) this.#entry(p);
      this.#ops(r.ops);
      this.#ops(r.coarse);
      if (r.flags & FLAG.post) {
        const post = r.postEffects ?? [];
        this.u32(post.length);
        for (const pe of post) {
          switch (pe.kind) {
            case "layerBlur":
              this.u32(POST.layerBlur);
              this.f32(Math.max(0, pe.radius));
              break;
          }
        }
      }
      if (r.flags & FLAG.blend) {
        this.u32(r.blend ?? 0);
      }
      if (r.flags & FLAG.mask) {
        this.u32(r.mask ?? 0);
      }
    });
  }

  #entry(p: PathEntry): void {
    switch (p.kind) {
      case "path":
        this.u32(PATH.path);
        this.path(p.path);
        return;
      case "rect":
        this.u32(PATH.rect);
        this.f32(p.w);
        this.f32(p.h);
        for (const r of p.radii) this.f32(Math.max(0, r));
        this.f32(p.smoothing);
        return;
      case "ellipse":
        this.u32(PATH.ellipse);
        this.f32(p.w);
        this.f32(p.h);
        return;
      case "glyphs": {
        this.u32(PATH.glyphs);
        this.f32(p.scale);
        const n = Math.floor(p.glyphs.length / 3);
        this.u32(n);
        for (let i = 0; i < n * 3; i += 3) {
          this.u32(p.glyphs[i] as number);
          this.f32(p.glyphs[i + 1] as number);
          this.f32(p.glyphs[i + 2] as number);
        }
        return;
      }
      case "outside":
        this.u32(PATH.outside);
        this.u32(p.of);
        return;
      case "box":
        this.u32(PATH.box);
        this.f32(p.x);
        this.f32(p.y);
        this.f32(p.w);
        this.f32(p.h);
        for (const r of p.radii) this.f32(Math.max(0, r));
        this.f32(p.smoothing);
        return;
      case "oval":
        this.u32(PATH.oval);
        this.f32(p.x);
        this.f32(p.y);
        this.f32(p.w);
        this.f32(p.h);
    }
  }

  #ops(ops: readonly WireOp[]): void {
    this.u32(ops.length);
    for (const o of ops) {
      switch (o.op) {
        case "fill":
          this.u32(OP.fill);
          this.u32(o.path);
          this.u32(o.evenOdd ? 1 : 0);
          this.#paint(o.paint);
          break;
        case "stroke":
          this.u32(OP.stroke);
          this.u32(o.path);
          this.f32(o.style.width);
          this.u32(o.style.join);
          this.u32(o.style.cap);
          this.f32(o.style.miter);
          this.u32(o.style.dashes.length);
          for (const d of o.style.dashes) this.f32(d);
          this.f32(o.style.dashOffset);
          this.#paint(o.paint);
          break;
        case "clip":
          this.u32(OP.clip);
          this.u32(o.path);
          this.u32(o.evenOdd ? 1 : 0);
          break;
        case "unclip":
          this.u32(OP.unclip);
          break;
        case "children":
          this.u32(OP.children);
          break;
        case "read":
          this.u32(OP.read);
          this.u32(o.kernel);
          this.f32(o.halo);
          break;
        case "layer":
          this.u32(OP.layer);
          this.u32(o.compose);
          break;
        case "unlayer":
          this.u32(OP.unlayer);
          break;
        case "dropShadow":
          this.u32(OP.dropShadow);
          this.u32(o.paths.length);
          for (const p of o.paths) this.u32(p);
          this.u32((o.evenOdd ? 1 : 0) | (o.stroke ? 2 : 0));
          this.f32(o.dx);
          this.f32(o.dy);
          this.f32(o.blur);
          this.rgba(o.color);
          this.u32(o.blend);
          if (o.stroke) {
            this.f32(o.stroke.width);
            this.u32(o.stroke.join);
            this.u32(o.stroke.cap);
            this.f32(o.stroke.miter);
            this.u32(o.stroke.dashes.length);
            for (const d of o.stroke.dashes) this.f32(d);
            this.f32(o.stroke.dashOffset);
          }
          break;
        case "innerShadow":
          this.u32(OP.innerShadow);
          this.u32(o.shape);
          this.u32(o.hole === null ? 0xffffffff : o.hole);
          this.u32(o.evenOdd ? 1 : 0);
          this.f32(o.dx);
          this.f32(o.dy);
          this.f32(o.blur);
          this.rgba(o.color);
          this.u32(o.blend);
      }
    }
  }

  #paint(p: WirePaint): void {
    this.u32(PAINT_KIND[p.kind]);
    this.u32(p.blend ?? 0);
    switch (p.kind) {
      case "solid":
        this.rgba(p.color);
        return;
      case "linear":
      case "radial":
      case "angular":
      case "diamond":
        this.matrix(p.matrix);
        this.u32(p.stops.length);
        for (const s of p.stops) {
          this.f32(s.position);
          this.rgba(s.color);
        }
        return;
      case "image":
        this.u32(p.image);
        this.matrix(p.matrix);
        this.u32(p.tile ? 1 : 0);
        this.f32(p.opacity);
        return;
      case "placeholder":
        this.f32(p.opacity);
    }
  }

  /** The finished message: a view of the writer's buffer (no copy; the writer is done with it). */
  finish(): Uint8Array {
    this.#view.setUint32(this.#countAt, this.#commands, true);
    return this.#bytes.subarray(0, this.#at);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.#at;
  }
}
