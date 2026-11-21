/**
 * The engine's measurer over HarfBuzz (`harfbuzz.ts`), given HarfBuzz
 * itself: the Worker's, from its bundled module, or one a test sets up in
 * Node.
 */
import {
  type FaceFileLoader,
  HarfBuzzMeasurer,
  type MeasuredFace,
  measuredFaces,
  type TextFace,
} from "@drawpane/editor";
import type { HeadlessFontResolver } from "./font-aliases";
import type { HeadlessMeasurer } from "./measurer";

type HarfBuzz = typeof import("harfbuzzjs");

/** The face the canvas draws plain text in: what the editor measures with. */
const canvasFace = (face: TextFace): MeasuredFace => ({ ...face, canvas: true });

/**
 * The engine's measurer over `harfBuzz`, with font files from `loadFile`,
 * and text drawn in the families `fonts` aliases it to (decision 0036).
 */
export function harfBuzzMeasurerWith(
  loadFile: FaceFileLoader,
  harfBuzz: () => Promise<HarfBuzz>,
  fonts: HeadlessFontResolver | null = null,
): HeadlessMeasurer {
  const measurer = new HarfBuzzMeasurer(loadFile, { harfBuzz });
  /** A face as text names it, and the faces aliases may draw it in (which one depends on size). */
  const drawnIn = (face: TextFace): MeasuredFace[] => [
    canvasFace(face),
    ...(fonts?.standIns(face.family) ?? []).map((family) => canvasFace({ ...face, family })),
  ];
  return {
    get scriptLocale() {
      return measurer.scriptLocale;
    },
    setScriptLocale: (locale) => measurer.setScriptLocale(locale),
    width: (font, text, run, direction) => measurer.width(font, text, run, direction),
    prepareScriptFallbacks: (subsets) => measurer.prepareScriptFallbacks(subsets),
    // Plain and specially shaped text both arrive at the render engine as outlines.
    shape: (text, run) => measurer.shape(text, run),
    shapeForEngine: (text, run, font) => measurer.shapeForEngine(text, run, font),
    metrics: (font) => measurer.metrics(font),
    family: (family, size) => (fonts ? fonts.family(family, size) : family),
    // No file for the face it's drawn in: text saved with glyph outlines draws from those
    // (decision 0037). A face still loading isn't missing yet.
    missing: (family, size, weight, italic) =>
      measurer.status(
        canvasFace({ family: fonts ? fonts.family(family, size) : family, weight, italic }),
      ) === "unavailable",
    get generation() {
      return measurer.generation + (fonts?.generation ?? 0);
    },
    // Ready, or known to have no file (then it's measured in the fallback, as the browser draws
    // it), in every family it may be drawn in.
    has: (face) =>
      (!fonts || fonts.prepared(face.family)) &&
      drawnIn(face).every((f) => measurer.status(f) !== "loading"),
    load: async (faces) => {
      await fonts?.prepare(faces.map((f) => f.family));
      await measurer.load(faces.flatMap(drawnIn));
    },
    prepareRenderFonts: async (nodes) => {
      const layers = [...nodes];
      await fonts?.prepare(measuredFaces(layers).map((face) => face.family));
      await measurer.load(measuredFaces(layers, fonts));
    },
  };
}
