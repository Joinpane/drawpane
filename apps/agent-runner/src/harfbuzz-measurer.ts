/**
 * The engine's measurer over HarfBuzz (`harfbuzz.ts`), given HarfBuzz
 * itself: the Worker's, from its bundled module, or one a test sets up in
 * Node.
 */
import {
  type FaceFileLoader,
  HarfBuzzMeasurer,
  type MeasuredFace,
  type TextFace,
} from "@drawpane/editor";
import type { HeadlessMeasurer } from "./measurer";

type HarfBuzz = typeof import("harfbuzzjs");

/** The face the canvas draws plain text in: what the editor measures with. */
const canvasFace = (face: TextFace): MeasuredFace => ({ ...face, canvas: true });

/** The engine's measurer over `harfBuzz`, with font files from `loadFile`. */
export function harfBuzzMeasurerWith(
  loadFile: FaceFileLoader,
  harfBuzz: () => Promise<HarfBuzz>,
): HeadlessMeasurer {
  const measurer = new HarfBuzzMeasurer(loadFile, { harfBuzz });
  return {
    width: (font, text, run) => measurer.width(font, text, run),
    // Runs with OpenType features or axes, as glyphs: what the headless renderer outlines.
    shape: (text, run) => measurer.shape(text, run),
    metrics: (font) => measurer.metrics(font),
    get generation() {
      return measurer.generation;
    },
    // Ready, or known to have no file (then it's measured in the fallback, as the browser draws it).
    has: (face) => measurer.status(canvasFace(face)) !== "loading",
    load: async (faces) => {
      await measurer.load(faces.map(canvasFace));
    },
  };
}
