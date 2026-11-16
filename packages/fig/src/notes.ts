/**
 * What reading a .fig couldn't carry over exactly, before the converter
 * sees it. The converter adds its own notes (`@drawpane/figma`'s Notes);
 * the import shows both.
 */
import { NoteBook } from "@drawpane/import-kit";

export const FIG_NOTE_TEXT = {
  "paint-noise": ["noise or custom fill was dropped", "noise or custom fills were dropped"],
  "effect-unsupported": [
    "repeat, symmetry or custom effect was dropped",
    "repeat, symmetry or custom effects were dropped",
  ],
  "text-path": ["text on a path became plain text", "texts on paths became plain text"],
  "component-missing": [
    "copy of a component that's no longer in the file came in empty",
    "copies of components that are no longer in the file came in empty",
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type FigNoteKind = keyof typeof FIG_NOTE_TEXT;

export class FigNotes extends NoteBook<FigNoteKind> {
  constructor() {
    super(FIG_NOTE_TEXT);
  }
}
