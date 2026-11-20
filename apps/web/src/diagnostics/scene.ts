/**
 * Fixed, deterministic test cells for `/diagnostics/renderer`.
 *
 * Every cell builds a self-contained display list with zero network or system-font
 * dependencies so the expected pixels shipped beside the page match bit-for-bit on the CPU
 * path and within decision 0040's tolerance on WebGPU and WebGL2 across Chrome, Edge,
 * Safari, and Firefox.
 *
 * Phase 3A/3B effects (shadows, blurs, glass, blend modes, grain) drop straight into
 * `DIAGNOSTIC_CELLS` as new entries once they land in the engine.
 */
import {
  CAP,
  COMPOSE,
  JOIN,
  ListWriter,
  PathData,
  ROOT,
  type WireOp,
  type WireRecord,
} from "@drawpane/engine/wire";

export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 128;
export const CELL_CAMERA = { zoom: 1, x: 0, y: 0, dpr: 1 } as const;

export interface DiagnosticImage {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface DiagnosticCell {
  readonly id: string;
  readonly title: string;
  readonly category: "fills" | "gradients" | "geometry" | "strokes" | "text" | "images" | "clips";
  readonly description: string;
  readonly background: readonly [number, number, number, number];
  /** Optional procedural RGBA8 images uploaded via `putImage` before `apply`. */
  readonly images?: readonly DiagnosticImage[];
  /** Builds the display-list message (fresh reset to `revision`, default 1). */
  build(revision?: number): Uint8Array;
}

const ID: readonly [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/** Exact 8-bit sRGB color (multiples of 1/255) so CPU and GPU UNORM8 clear/blend agree. */
const rgb = (r: number, g: number, b: number, a = 1): readonly [number, number, number, number] => [
  r / 255,
  g / 255,
  b / 255,
  a,
];

const PAPER = rgb(245, 244, 240);
const INK = rgb(28, 28, 26);
const ACCENT = rgb(224, 79, 26);
const BLUE = rgb(41, 94, 224);
const TEAL = rgb(13, 128, 122);
const WHITE = rgb(255, 255, 255);

function rec(partial: Partial<WireRecord>): WireRecord {
  return {
    flags: 0,
    opacity: 1,
    transform: ID,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    coarseBelow: 0,
    reach: 0,
    unsupported: 0,
    paths: [],
    ops: [],
    coarse: [],
    ...partial,
  };
}

function makeList(revision: number, fn: (w: ListWriter) => void): Uint8Array {
  const w = new ListWriter(0xffffffff, revision);
  w.reset();
  fn(w);
  return w.finish();
}

/** Deterministic geometric glyphs (font units, y up) so text tests need no system fonts. */
function registerGlyphs(w: ListWriter): void {
  // Glyph 1: bold "D" with counter (evenodd / nonzero safe opposite winding).
  w.glyph(
    1,
    new PathData()
      .moveTo(40, 0)
      .lineTo(360, 0)
      .cubicTo(560, 0, 680, 140, 680, 350)
      .cubicTo(680, 560, 560, 700, 360, 700)
      .lineTo(40, 700)
      .close()
      .moveTo(190, 130)
      .lineTo(190, 570)
      .lineTo(340, 570)
      .cubicTo(465, 570, 525, 485, 525, 350)
      .cubicTo(525, 215, 465, 130, 340, 130)
      .close(),
  );
  // Glyph 2: bold "P" with upper bowl counter.
  w.glyph(
    2,
    new PathData()
      .moveTo(40, 0)
      .lineTo(190, 0)
      .lineTo(190, 260)
      .lineTo(380, 260)
      .cubicTo(540, 260, 630, 350, 630, 480)
      .cubicTo(630, 610, 540, 700, 380, 700)
      .lineTo(40, 700)
      .close()
      .moveTo(190, 385)
      .lineTo(190, 575)
      .lineTo(365, 575)
      .cubicTo(445, 575, 485, 535, 485, 480)
      .cubicTo(485, 425, 445, 385, 365, 385)
      .close(),
  );
  // Glyph 3: bold "A" with triangular counter.
  w.glyph(
    3,
    new PathData()
      .moveTo(20, 0)
      .lineTo(175, 0)
      .lineTo(225, 160)
      .lineTo(475, 160)
      .lineTo(525, 0)
      .lineTo(680, 0)
      .lineTo(430, 700)
      .lineTo(270, 700)
      .close()
      .moveTo(265, 290)
      .lineTo(350, 560)
      .lineTo(435, 290)
      .close(),
  );
}

/** Procedural 64x64 RGBA8 test image (color quadrants + diagonal stripe + soft alpha edge). */
function makeDiagnosticImage(): DiagnosticImage {
  const width = 64;
  const height = 64;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) & 1;
      const diag = Math.abs(x - y) <= 3;
      const dx = x - 31.5;
      const dy = y - 31.5;
      const dist = Math.hypot(dx, dy);
      if (diag) {
        rgba[i] = 250;
        rgba[i + 1] = 204;
        rgba[i + 2] = 21;
        rgba[i + 3] = 255;
      } else if (dist < 18) {
        rgba[i] = 224;
        rgba[i + 1] = 79;
        rgba[i + 2] = 26;
        rgba[i + 3] = 255;
      } else {
        const right = x >= 32;
        const bottom = y >= 32;
        rgba[i] = right ? (checker ? 38 : 66) : checker ? 235 : 210;
        rgba[i + 1] = bottom ? (checker ? 140 : 175) : checker ? 95 : 130;
        rgba[i + 2] = right ? (checker ? 210 : 240) : checker ? 110 : 140;
        rgba[i + 3] = x < 4 || y < 4 ? 170 : 255;
      }
    }
  }
  return { id: 1, width, height, rgba };
}

const TEST_IMAGE = makeDiagnosticImage();

export const DIAGNOSTIC_CELLS: readonly DiagnosticCell[] = [
  {
    id: "solid-fills",
    title: "Solid fills & winding",
    category: "fills",
    description: "Opaque, translucent, nonzero and even-odd path fills over a light canvas.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 14, 14],
            width: 76,
            height: 100,
            paths: [{ kind: "rect", w: 76, h: 100, radii: [10, 10, 10, 10], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: ACCENT },
              },
            ],
          }),
        );
        // Overlapping translucent circle (alpha 153/255 = 0.6 exact).
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 56, 22],
            width: 84,
            height: 84,
            paths: [{ kind: "ellipse", w: 84, h: 84 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: rgb(41, 94, 224, 0.6) },
              },
            ],
          }),
        );
        // Even-odd ring on the right.
        const ring = new PathData()
          .moveTo(0, 0)
          .lineTo(52, 0)
          .lineTo(52, 52)
          .lineTo(0, 52)
          .close()
          .moveTo(14, 14)
          .lineTo(38, 14)
          .lineTo(38, 38)
          .lineTo(14, 38)
          .close();
        w.set(
          3,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 126, 38],
            width: 52,
            height: 52,
            paths: [{ kind: "path", path: ring }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: true,
                paint: { kind: "solid", color: TEAL },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "opacity-isolation",
    title: "Opacity isolation",
    category: "fills",
    description: "Isolated group opacity (faded as one) compared beside stacked alpha.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        // Left: isolated group at 0.6 (153/255 exact) opacity (overlap must not darken).
        w.set(
          1,
          ROOT,
          rec({
            flags: 2, // ISOLATE
            opacity: 0.6,
            transform: [1, 0, 0, 1, 14, 18],
            width: 80,
            height: 92,
            ops: [{ op: "children" }],
          }),
        );
        w.set(
          2,
          1,
          rec({
            width: 54,
            height: 54,
            paths: [{ kind: "rect", w: 54, h: 54, radii: [8, 8, 8, 8], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: INK },
              },
            ],
          }),
        );
        w.set(
          3,
          1,
          rec({
            transform: [1, 0, 0, 1, 24, 34],
            width: 54,
            height: 54,
            paths: [{ kind: "ellipse", w: 54, h: 54 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: ACCENT },
              },
            ],
          }),
        );
        // Right: non-isolated individual alpha at 0.6 (overlap blends).
        w.set(
          4,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 104, 18],
            width: 54,
            height: 54,
            paths: [{ kind: "rect", w: 54, h: 54, radii: [8, 8, 8, 8], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: rgb(28, 28, 26, 0.6) },
              },
            ],
          }),
        );
        w.set(
          5,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 128, 52],
            width: 54,
            height: 54,
            paths: [{ kind: "ellipse", w: 54, h: 54 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: rgb(224, 79, 26, 0.6) },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "gradients-linear-radial",
    title: "Linear & radial gradients",
    category: "gradients",
    description:
      "Multi-stop unpremultiplied linear gradient with alpha beside an elliptical radial gradient.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 12, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [10, 10, 10, 10], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "linear",
                  matrix: [78, 0, 0, 96, 0, 0],
                  stops: [
                    { position: 0, color: rgb(242, 89, 31) },
                    { position: 0.5, color: rgb(250, 209, 51, 0.8) },
                    { position: 1, color: rgb(31, 115, 235) },
                  ],
                },
              },
            ],
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 102, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [10, 10, 10, 10], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "radial",
                  matrix: [39, 0, 0, 48, 39, 48],
                  stops: [
                    { position: 0, color: WHITE },
                    { position: 0.45, color: rgb(13, 166, 153) },
                    { position: 1, color: rgb(23, 36, 87) },
                  ],
                },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "gradients-angular-diamond",
    title: "Angular & diamond gradients",
    category: "gradients",
    description: "Sweep (angular) gradient beside an exact L1 diamond gradient (CPU + WGSL pass).",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 12, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [12, 12, 12, 12], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "angular",
                  matrix: [39, 0, 0, 48, 39, 48],
                  stops: [
                    { position: 0, color: rgb(230, 64, 51) },
                    { position: 0.33, color: rgb(51, 184, 102) },
                    { position: 0.66, color: rgb(46, 107, 235) },
                    { position: 1, color: rgb(230, 64, 51) },
                  ],
                },
              },
            ],
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 102, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [12, 12, 12, 12], smoothing: 0.6 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "diamond",
                  matrix: [39, 0, 0, 48, 39, 48],
                  stops: [
                    { position: 0, color: rgb(255, 242, 102) },
                    { position: 0.55, color: ACCENT },
                    { position: 1, color: rgb(38, 31, 89) },
                  ],
                },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "corner-smoothing",
    title: "Corner smoothing (squircles)",
    category: "geometry",
    description: "60% iOS squircle, 100% full smoothing, and asymmetric per-corner radii.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 12, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [24, 24, 24, 24], smoothing: 0.6 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: INK },
              },
            ],
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 102, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [0, 26, 36, 12], smoothing: 1.0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: TEAL },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "strokes-align-dashes",
    title: "Strokes, alignment & dashes",
    category: "strokes",
    description: "Inside, center, outside, and dashed strokes with round joins on squircles.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        // Inside stroke.
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 14, 18],
            width: 48,
            height: 92,
            paths: [{ kind: "rect", w: 48, h: 92, radii: [14, 14, 14, 14], smoothing: 0.6 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: WHITE },
              },
              { op: "clip", path: 0, evenOdd: false },
              {
                op: "stroke",
                path: 0,
                style: {
                  width: 12,
                  join: JOIN.round,
                  cap: CAP.butt,
                  miter: 10,
                  dashes: [],
                  dashOffset: 0,
                },
                paint: { kind: "solid", color: INK },
              },
              { op: "unclip" },
            ],
          }),
        );
        // Outside stroke.
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 76, 22],
            width: 42,
            height: 84,
            reach: 10,
            paths: [
              { kind: "rect", w: 42, h: 84, radii: [12, 12, 12, 12], smoothing: 0.6 },
              { kind: "outside", of: 0 },
            ],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: rgb(250, 227, 217) },
              },
              { op: "clip", path: 1, evenOdd: true },
              {
                op: "stroke",
                path: 0,
                style: {
                  width: 12,
                  join: JOIN.round,
                  cap: CAP.butt,
                  miter: 10,
                  dashes: [],
                  dashOffset: 0,
                },
                paint: { kind: "solid", color: ACCENT },
              },
              { op: "unclip" },
            ],
          }),
        );
        // Dashed center stroke.
        w.set(
          3,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 134, 18],
            width: 44,
            height: 92,
            reach: 4,
            paths: [{ kind: "rect", w: 44, h: 92, radii: [14, 14, 14, 14], smoothing: 0 }],
            ops: [
              {
                op: "stroke",
                path: 0,
                style: {
                  width: 3,
                  join: JOIN.round,
                  cap: CAP.round,
                  miter: 10,
                  dashes: [8, 5],
                  dashOffset: 0,
                },
                paint: { kind: "solid", color: BLUE },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "text-glyphs",
    title: "Glyph cache & subpixel text",
    category: "text",
    description: "Cached solid glyphs at fractional positions and a larger outlined gradient run.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        registerGlyphs(w);
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 16, 16],
            width: 160,
            height: 44,
            paths: [
              {
                kind: "glyphs",
                scale: 0.045,
                glyphs: [1, 0, 36, 2, 34.4, 36, 3, 66.8, 36, 1, 102.2, 36, 2, 136.6, 36],
              },
            ],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: INK },
              },
            ],
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 16, 62],
            width: 160,
            height: 54,
            paths: [
              {
                kind: "glyphs",
                scale: 0.068,
                glyphs: [1, 0, 48, 2, 52, 48, 3, 100, 48],
              },
            ],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "linear",
                  matrix: [150, 0, 0, 50, 0, 0],
                  stops: [
                    { position: 0, color: ACCENT },
                    { position: 1, color: BLUE },
                  ],
                },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "text-stroke-outside",
    title: "Text stroke outside",
    category: "text",
    description:
      "Filled and hollow glyphs with isolated DestOut outside strokes over a colored backdrop.",
    background: rgb(38, 64, 115),
    build: (rev = 1) =>
      makeList(rev, (w) => {
        registerGlyphs(w);
        const outsideText = (filled: boolean): WireOp[] => {
          const ops: WireOp[] = [];
          if (filled) {
            ops.push({
              op: "fill",
              path: 0,
              evenOdd: false,
              paint: { kind: "solid", color: rgb(250, 245, 235) },
            });
          }
          ops.push(
            { op: "layer", compose: COMPOSE.srcOver },
            {
              op: "stroke",
              path: 0,
              style: {
                width: 10,
                join: JOIN.round,
                cap: CAP.butt,
                miter: 10,
                dashes: [],
                dashOffset: 0,
              },
              paint: { kind: "solid", color: rgb(242, 115, 36) },
            },
            { op: "layer", compose: COMPOSE.destOut },
            { op: "fill", path: 0, evenOdd: false, paint: { kind: "solid", color: rgb(0, 0, 0) } },
            { op: "unlayer" },
            { op: "unlayer" },
          );
          return ops;
        };
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 16, 16],
            width: 80,
            height: 96,
            reach: 8,
            paths: [{ kind: "glyphs", scale: 0.1, glyphs: [1, 4, 82] }],
            ops: outsideText(true),
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 102, 16],
            width: 80,
            height: 96,
            reach: 8,
            paths: [{ kind: "glyphs", scale: 0.1, glyphs: [3, 4, 82] }],
            ops: outsideText(false),
          }),
        );
      }),
  },
  {
    id: "image-mips",
    title: "Image fills & tiling",
    category: "images",
    description: "Uploaded RGBA8 image rendered stretched and tiled with mipmap filtering.",
    background: PAPER,
    images: [TEST_IMAGE],
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 12, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [12, 12, 12, 12], smoothing: 0.6 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "image",
                  image: 1,
                  matrix: [78, 0, 0, 96, 0, 0],
                  tile: false,
                  opacity: 1,
                },
              },
            ],
          }),
        );
        w.set(
          2,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 102, 16],
            width: 78,
            height: 96,
            paths: [{ kind: "rect", w: 78, h: 96, radii: [12, 12, 12, 12], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "image",
                  image: 1,
                  matrix: [26, 0, 0, 26, 0, 0],
                  tile: true,
                  opacity: 0.8,
                },
              },
            ],
          }),
        );
      }),
  },
  {
    id: "clips-nested",
    title: "Nested clips & transforms",
    category: "clips",
    description: "Rotated children clipped inside nested squircle and elliptical frames.",
    background: PAPER,
    build: (rev = 1) =>
      makeList(rev, (w) => {
        w.set(
          1,
          ROOT,
          rec({
            transform: [1, 0, 0, 1, 16, 14],
            width: 160,
            height: 100,
            paths: [{ kind: "rect", w: 160, h: 100, radii: [24, 24, 24, 24], smoothing: 0.6 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: WHITE },
              },
              { op: "clip", path: 0, evenOdd: false },
              { op: "children" },
              { op: "unclip" },
            ],
          }),
        );
        w.set(
          2,
          1,
          rec({
            transform: [0.94, 0.34, -0.34, 0.94, 18, -16],
            width: 110,
            height: 110,
            paths: [{ kind: "rect", w: 110, h: 110, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: { kind: "solid", color: ACCENT },
              },
            ],
          }),
        );
        w.set(
          3,
          1,
          rec({
            transform: [1, 0, 0, 1, 76, 12],
            width: 96,
            height: 96,
            paths: [{ kind: "ellipse", w: 96, h: 96 }],
            ops: [{ op: "clip", path: 0, evenOdd: false }, { op: "children" }, { op: "unclip" }],
          }),
        );
        w.set(
          4,
          3,
          rec({
            transform: [1, 0, 0, 1, -10, -10],
            width: 116,
            height: 116,
            paths: [{ kind: "rect", w: 116, h: 116, radii: [0, 0, 0, 0], smoothing: 0 }],
            ops: [
              {
                op: "fill",
                path: 0,
                evenOdd: false,
                paint: {
                  kind: "linear",
                  matrix: [116, 0, 0, 116, 0, 0],
                  stops: [
                    { position: 0, color: TEAL },
                    { position: 1, color: BLUE },
                  ],
                },
              },
            ],
          }),
        );
      }),
  },
];
