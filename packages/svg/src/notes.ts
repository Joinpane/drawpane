/**
 * What an SVG import couldn't carry over exactly, for the one notice after
 * it (see NoteBook). Kinds follow what SVG can say that Drawpane's layers
 * can't: filters beyond shadows and blurs, patterns, embedded images and
 * HTML, markers, and the odd mask, clip or gradient that only approximates.
 */
import { NoteBook } from "@drawpane/import-kit";

export const NOTE_TEXT = {
  filter: ["filter effect was left out", "filter effects were left out"],
  pattern: ["pattern fill was left out", "pattern fills were left out"],
  image: ["embedded image was left out", "embedded images were left out"],
  foreign: ["block of HTML was left out", "blocks of HTML were left out"],
  marker: ["line-end marker was left out", "line-end markers were left out"],
  mask: ["mask was simplified", "masks were simplified"],
  clip: ["clip path was simplified", "clip paths were simplified"],
  gradient: ["gradient was approximated", "gradients were approximated"],
  stroke: [
    "stroke on a stretched shape got an average width",
    "strokes on stretched shapes got an average width",
  ],
  "dash-offset": ["dash offset was left out", "dash offsets were left out"],
  text: ["text was laid out approximately", "texts were laid out approximately"],
  "too-long": ["path was too detailed to keep", "paths were too detailed to keep"],
} as const satisfies Record<string, readonly [string, string]>;

export type NoteKind = keyof typeof NOTE_TEXT;

export class Notes extends NoteBook<NoteKind> {
  constructor() {
    super(NOTE_TEXT);
  }
}
