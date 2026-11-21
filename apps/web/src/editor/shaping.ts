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
  ENGINE_EMOJI_FACE,
  type FontBytesLoader,
  MISSING_GLYPH_FAMILY,
  missingGlyphFont,
  PRIVATE_USE_UNICODE_RANGE,
  Shaper,
  ShapingMeasurer,
} from "@drawpane/editor";
import emojiUrl from "@drawpane/editor/emoji-font.ttf?url";
import { cjkRegionFor, scriptSubsetsFor } from "@drawpane/model";
import instrumentSansUrl from "../fonts/fallback/InstrumentSans-Variable.ttf?url";
import { fallbackSliceLoader } from "../fonts/fallback-client";
import { faceFileUrl, variableFileUrl } from "../fonts/font-files";
import { fonts } from "../fonts/fonts";

const BUNDLED_FALLBACK = "Instrument Sans Variable";
let instrumentSans: Promise<ArrayBuffer | null> | undefined;
const loadFallbackSlice = fallbackSliceLoader();

/** A face's TrueType or OpenType file: bundled, from the font proxy, or uploaded by the team. */
export const fontBytes: FontBytesLoader = async (face) => {
  if (face.family === ENGINE_EMOJI_FACE.family) return readFont(emojiUrl);
  if (face.subset !== undefined) return loadFallbackSlice(face.family, face.subset);
  if (
    face.family === BUNDLED_FALLBACK ||
    (face.family === "Instrument Sans" &&
      face.variable &&
      fonts.get(face.family)?.source === "bundled")
  ) {
    instrumentSans ??= readFont(instrumentSansUrl).then(
      (bytes) => {
        if (!bytes) instrumentSans = undefined;
        return bytes;
      },
      () => {
        instrumentSans = undefined;
        return null;
      },
    );
    return instrumentSans;
  }
  const source = fonts.get(face.family)?.source;
  if (source === undefined || source === "system" || source === "local") {
    const local = await fonts.localBytes(face);
    if (local) return local;
  }
  const url = face.variable ? await variableFileUrl(face) : await faceFileUrl(face, ["ttf", "otf"]);
  return url ? readFont(url) : null;
};

async function readFont(url: string): Promise<ArrayBuffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return response.ok ? response.arrayBuffer() : null;
}

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

const systemSubstitutes = new Map([
  ["Arial", "Arimo"],
  ["Helvetica", "Arimo"],
  ["Georgia", "Gelasio"],
  ["Times New Roman", "Tinos"],
  ["Courier New", "Cousine"],
  ["system-ui", "Arimo"],
]);

export const shaper = new Shaper(fontBytes, {
  ...faceDeadline(),
  fallbackFamily: BUNDLED_FALLBACK,
  bundledRetryMs: [250, 1000, 4000, 15_000, 30_000],
  fallbackFaces: (text, run) =>
    scriptSubsetsFor(text, run.cjkRegion ?? cjkRegionFor(text, globalThis.navigator?.language)).map(
      (slice) => ({ ...slice, weight: 400, italic: false }),
    ),
  substitute: (face) => {
    const family = systemSubstitutes.get(face.family);
    return family && fonts.get(face.family)?.source === "system" ? { ...face, family } : null;
  },
});
fonts.onLocalFaces((families) => shaper.retryUnavailable(families));

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
  return new ShapingMeasurer(new CanvasTextMeasurer(), shaper, fonts, navigator.language);
}
