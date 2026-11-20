/**
 * The app's shaper for OpenType features and variable axes (docs/decisions/
 * 0005-opentype-features.md, 0009-variable-fonts.md): one for every editor and
 * player, so HarfBuzz and each font file load once. Fonts come as their
 * TrueType or OpenType files (font-files.ts), variable ones for text that
 * sets axes; a family without readable files (system, local) draws without
 * its features and axes.
 */
import {
  CanvasTextMeasurer,
  type FontBytesLoader,
  MISSING_GLYPH_FAMILY,
  missingGlyphFont,
  PRIVATE_USE_UNICODE_RANGE,
  Shaper,
  ShapingMeasurer,
} from "@drawpane/editor";
import { faceFileUrl, variableFileUrl } from "../fonts/font-files";
import { fonts } from "../fonts/fonts";

/** A face's TrueType or OpenType file, through the font proxy (Google, built-in) or the team's fonts. */
export const fontBytes: FontBytesLoader = async (face) => {
  const url = face.variable ? await variableFileUrl(face) : await faceFileUrl(face, ["ttf", "otf"]);
  if (!url) return null;
  const response = await fetch(url);
  return response.ok ? response.arrayBuffer() : null;
};

/**
 * How long a face may load before its text goes without it (`Shaper`'s 3 s), unless the debug
 * setting `drawpane:face-deadline-ms` says otherwise (tests that hold a face back).
 */
function faceDeadline(): { loadDeadlineMs: number } | Record<string, never> {
  try {
    const ms = Number(globalThis.localStorage?.getItem("drawpane:face-deadline-ms"));
    return ms > 0 ? { loadDeadlineMs: ms } : {};
  } catch {
    return {};
  }
}

export const shaper = new Shaper(fontBytes, faceDeadline());

let boxAdded = false;
/**
 * The missing-glyph box (decision 0036), for the page and the canvas: every
 * private-use character a text's font lacks draws as it. Its unicode-range
 * keeps it from being anyone's first available font, so it never changes a
 * line's height.
 */
export function addMissingGlyphFont(): void {
  if (boxAdded || typeof document === "undefined" || typeof FontFace === "undefined") return;
  boxAdded = true;
  const face = new FontFace(MISSING_GLYPH_FAMILY, missingGlyphFont().slice(0), {
    unicodeRange: PRIVATE_USE_UNICODE_RANGE,
  });
  document.fonts.add(face);
  void face.load().catch(() => {});
}

/**
 * A measurer for an editor: the canvas, the shaper for runs with features or
 * axes, and the font registry for which family each run is drawn in (font
 * aliases, decision 0036).
 */
export function textMeasurer(): ShapingMeasurer {
  addMissingGlyphFont();
  return new ShapingMeasurer(new CanvasTextMeasurer(), shaper, fonts);
}
