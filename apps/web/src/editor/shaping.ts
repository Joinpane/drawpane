/**
 * The app's shaper for OpenType features and variable axes (docs/decisions/
 * 0005-opentype-features.md, 0009-variable-fonts.md): one for every editor and
 * player, so HarfBuzz and each font file load once. Fonts come as their
 * TrueType or OpenType files (font-files.ts), variable ones for text that
 * sets axes; a family without readable files (system, local) draws without
 * its features and axes.
 */
import { CanvasTextMeasurer, Shaper, ShapingMeasurer } from "@drawpane/editor";
import { faceFileUrl, variableFileUrl } from "../fonts/font-files";

export const shaper = new Shaper(async (face) => {
  const url = face.variable ? await variableFileUrl(face) : await faceFileUrl(face, ["ttf", "otf"]);
  if (!url) return null;
  const response = await fetch(url);
  return response.ok ? response.arrayBuffer() : null;
});

/** A measurer for an editor: the canvas, and the shaper for runs with features or axes. */
export function textMeasurer(): ShapingMeasurer {
  return new ShapingMeasurer(new CanvasTextMeasurer(), shaper);
}
