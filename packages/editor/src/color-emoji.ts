/// <reference path="./opentype.d.ts" />
import type { CjkRegion } from "@drawpane/model";
import { type Face, faceKey } from "@drawpane/raster";
import { colorLayers } from "./colr";
import type { ShapedGlyph, ShapedText, TextMeasurer } from "./text";
import type { TextDirection } from "./text-bidi";

type HarfBuzz = typeof import("harfbuzzjs");
type HbFace = InstanceType<HarfBuzz["Face"]>;
type HbFont = InstanceType<HarfBuzz["Font"]>;

export const ENGINE_EMOJI_FACE: Face = {
  family: "Drawpane Colour Emoji",
  weight: 400,
  italic: false,
};
export const ENGINE_EMOJI_KEY = faceKey(ENGINE_EMOJI_FACE);

const presentation = /\p{Emoji_Presentation}|\u20e3|\ufe0f/u;
const segments = new Intl.Segmenter("und", { granularity: "grapheme" });

export const hasColorEmoji = (text: string): boolean => presentation.test(text);

export interface ColorGlyphLayer {
  readonly d: string;
  /** Null uses the text's own paint. */
  readonly color: string | null;
}

/** Glyph outlines from the same static colour font in browsers and Workers. */
export async function colorEmojiFont(bytes: ArrayBuffer, face: HbFace) {
  const colors = colorLayers(face.referenceTable("COLR"), face.referenceTable("CPAL"));
  const { parse } = await import("opentype.js");
  const font = parse(bytes, { lowMemory: true });
  const paths = new Map<number, string>();
  const path = (id: number) => {
    let d = paths.get(id);
    if (d !== undefined) return d;
    // Glyph coordinates point up, as they do in HarfBuzz's outline data.
    d = font.glyphs
      .get(id)
      .path.commands.map((command) => {
        switch (command.type) {
          case "M":
          case "L":
            return `${command.type}${command.x} ${command.y}`;
          case "Q":
            return `Q${command.x1} ${command.y1} ${command.x} ${command.y}`;
          case "C":
            return `C${command.x1} ${command.y1} ${command.x2} ${command.y2} ${command.x} ${command.y}`;
          case "Z":
            return "Z";
          default:
            return "";
        }
      })
      .join("");
    paths.set(id, d);
    return d;
  };
  const paint = new Map<number, readonly ColorGlyphLayer[]>();
  const layersOf = (id: number) => {
    let layers = paint.get(id);
    if (layers === undefined) {
      layers = (colors.get(id) ?? []).map(({ glyph, color }) => ({ d: path(glyph), color }));
      paint.set(id, layers);
    }
    return layers;
  };
  return {
    shape(hb: HarfBuzz, hbFont: HbFont, text: string, size: number): ShapedText | null {
      const buffer = new hb.Buffer();
      try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        hb.shape(hbFont, buffer);
        const infos = buffer.getGlyphInfos();
        const positions = buffer.getGlyphPositions();
        const scale = size / face.upem;
        const glyphs: ShapedGlyph[] = [];
        let pen = 0;
        for (const [index, info] of infos.entries()) {
          const pos = positions[index];
          if (!pos || info.codepoint === 0) return null;
          const layers = layersOf(info.codepoint);
          if (layers.length === 0) {
            if (pos.xAdvance !== 0) return null;
            continue;
          }
          glyphs.push({
            x: (pen + pos.xOffset) * scale,
            y: pos.yOffset * scale,
            d: "",
            path: null,
            cluster: info.cluster,
            colorLayers: layers,
          });
          pen += pos.xAdvance;
        }
        return glyphs.length ? { glyphs, scale, width: pen * scale } : null;
      } finally {
        buffer.destroy();
      }
    },
  };
}

export type ColorEmojiFont = Awaited<ReturnType<typeof colorEmojiFont>>;

interface EmojiPiece {
  readonly start: number;
  readonly end: number;
  readonly shaped: ShapedText | null;
}

/** Keep each positive emoji presentation grapheme in one shaping call. */
export function emojiPieces(
  text: string,
  shape: (segment: string) => ShapedText | null,
): EmojiPiece[] {
  if (!hasColorEmoji(text)) return [];
  const pieces: EmojiPiece[] = [];
  let start = 0;
  for (const { segment, index } of segments.segment(text)) {
    if (!hasColorEmoji(segment) || segment.includes("\ufe0e")) continue;
    const shaped = shape(segment);
    if (!shaped) continue;
    if (start < index) pieces.push({ start, end: index, shaped: null });
    start = index + segment.length;
    pieces.push({ start: index, end: start, shaped });
  }
  if (pieces.length > 0 && start < text.length)
    pieces.push({ start, end: text.length, shaped: null });
  return pieces;
}

/** Layout positions for the pieces taken out of an already measured text fragment. */
export function emojiPiecePositions(
  pieces: readonly EmojiPiece[],
  text: string,
  font: string,
  spacing: number,
  direction: TextDirection | undefined,
  measurer: TextMeasurer,
  region?: CjkRegion,
) {
  const rtl = direction === "rtl";
  const at = (end: number) => {
    if (end === 0) return 0;
    const prefix = text.slice(0, end);
    return measurer.width(font, prefix, null, direction, region) + spacing * [...prefix].length;
  };
  const total = rtl ? at(text.length) : 0;
  let from = 0;
  const positioned = pieces.map((piece) => {
    const to = at(piece.end);
    const result = { ...piece, x: rtl ? total - to : from, width: to - from };
    from = to;
    return result;
  });
  return rtl ? positioned.reverse() : positioned;
}
