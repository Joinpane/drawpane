/**
 * The size pill under the selection: "300 Fill × 196 Hug". The overlay draws
 * it and the pointer hit-tests it from the same geometry, so clicking the
 * width or the height opens Explain for exactly that number.
 */
import { getProp } from "@drawpane/model";
import type { Editor } from "./editor";
import { type ExplainAxis, sizeMode } from "./explain";
import type { Rect } from "./geometry";

const FAMILY = '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif';
/** The numbers. */
export const PILL_FONT = `600 11px ${FAMILY}`;
/** "Fill" and "Hug", lighter than the numbers. */
export const PILL_MODE_FONT = `500 11px ${FAMILY}`;
const HEIGHT = 18;
/** Below the selection's bottom edge. */
const OFFSET = 8;
const PAD = 6;
const TIMES = " × ";

export interface SizePillPart {
  readonly axis: ExplainAxis;
  readonly value: string;
  /** "Fill" or "Hug" after the number; null when the size is fixed. */
  readonly mode: string | null;
  /** Where the number starts, and the part's width with its mode, in screen pixels. */
  readonly x: number;
  readonly width: number;
  /** Where the mode word starts. */
  readonly modeX: number;
}

export interface SizePill {
  readonly box: Rect;
  readonly parts: readonly [SizePillPart, SizePillPart];
  /** Where " × " starts. */
  readonly timesX: number;
  /** The text's vertical middle. */
  readonly middle: number;
  /** One layer: each number opens Explain. */
  readonly explainable: boolean;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const MODE_WORDS = { fill: "Fill", hug: "Hug", fixed: null } as const;

/** The pill for the current selection, or null when none shows. */
export function sizePill(editor: Editor): SizePill | null {
  const { selection, prototyping, vectorEdit, cropping, camera, pageId } = editor.s;
  // Not while prototyping: it would sit on the connections.
  if (!pageId || selection.length === 0 || prototyping || vectorEdit || cropping) return null;
  const scene = editor.scene;
  const bounds = scene.unionBounds(selection);
  if (!bounds) return null;
  const single = selection.length === 1 ? editor.doc.get(selection[0] as string) : undefined;
  const own = single && single.type !== "group" && single.type !== "page";
  // A rotated layer reads its own size, not its bounding box's.
  const width = own ? getProp(single.props, "width") : bounds.width;
  const height = own ? getProp(single.props, "height") : bounds.height;
  const measure = (font: string, text: string) => editor.measurer.width(font, text);
  const space = measure(PILL_MODE_FONT, " ");
  const part = (axis: ExplainAxis, size: number, x: number): SizePillPart => {
    const value = fmt(size);
    const mode = own ? MODE_WORDS[sizeMode(editor.doc, single.id, axis)] : null;
    const numberWidth = measure(PILL_FONT, value);
    const modeWidth = mode ? space + measure(PILL_MODE_FONT, mode) : 0;
    return { axis, value, mode, x, width: numberWidth + modeWidth, modeX: x + numberWidth + space };
  };
  // Lay out from 0, then centre under the selection.
  const w = part("width", width, 0);
  const timesWidth = measure(PILL_FONT, TIMES);
  const h = part("height", height, w.width + timesWidth);
  const textWidth = h.x + h.width;
  const bottom = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
  const left = Math.round(bottom.x - textWidth / 2 - PAD);
  const top = Math.round(bottom.y + OFFSET);
  const shift = (p: SizePillPart): SizePillPart => ({
    ...p,
    x: p.x + left + PAD,
    modeX: p.modeX + left + PAD,
  });
  return {
    box: { x: left, y: top, width: textWidth + PAD * 2, height: HEIGHT },
    parts: [shift(w), shift(h)],
    timesX: left + PAD + w.width,
    middle: top + HEIGHT / 2 + 0.5,
    explainable: !!single,
  };
}

/** Which number of the pill is under a screen point, when it can be explained. */
export function sizePillAt(editor: Editor, screen: { x: number; y: number }): ExplainAxis | null {
  const pill = sizePill(editor);
  if (!pill?.explainable) return null;
  const { box, parts, timesX } = pill;
  if (screen.x < box.x || screen.x > box.x + box.width) return null;
  if (screen.y < box.y || screen.y > box.y + box.height) return null;
  // The halves split at the middle of " × ".
  const split = (timesX + parts[1].x) / 2;
  return screen.x < split ? "width" : "height";
}
