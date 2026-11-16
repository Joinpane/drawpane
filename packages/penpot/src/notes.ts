/**
 * What an import couldn't carry over exactly, counted by kind, so the person
 * importing gets a short, honest summary ("3 boolean groups became paths")
 * instead of silent differences.
 */
import { NoteBook } from "@drawpane/import-kit";

export const NOTE_TEXT = {
  "boolean-flattened": ["boolean group became a path", "boolean groups became paths"],
  "svg-raw-skipped": ["raw SVG element wasn't imported", "raw SVG elements weren't imported"],
  "missing-image": ["image was missing from the export", "images were missing from the export"],
  "image-offset": ["image's crop was reset", "images' crops were reset"],
  "elliptical-gradient": [
    "elliptical radial gradient became circular",
    "elliptical radial gradients became circular",
  ],
  "stroke-weights": [
    "layer's strokes now share one weight",
    "layers' strokes now share one weight",
  ],
  "stroke-sides": [
    "layer's per-side stroke widths became one width",
    "layers' per-side stroke widths became one width",
  ],
  skewed: ["skewed layer was straightened", "skewed layers were straightened"],
  "layout-spacing": [
    "auto layout's space-around/evenly became space-between",
    "auto layouts' space-around/evenly became space-between",
  ],
  "layout-margins": [
    "layer's auto layout margins were dropped",
    "layers' auto layout margins were dropped",
  ],
  "group-fill": [
    "group set to Fill in an auto layout keeps its own size",
    "groups set to Fill in auto layouts keep their own size",
  ],
  "dotted-square": [
    "dotted border's round dots became square",
    "dotted borders' round dots became square",
  ],
  "grid-percent": ["grid track in percent became a share", "grid tracks in percent became shares"],
  "library-component": [
    "copy of a component from another file was detached",
    "copies of components from other files were detached",
  ],
  "component-not-frame": [
    "component that wasn't a board became a plain layer",
    "components that weren't boards became plain layers",
  ],
  "custom-font": [
    "text uses a team font that isn't in the export",
    "texts use team fonts that aren't in the export",
  ],
  "text-mixed-paragraphs": [
    "text's per-paragraph alignment or line height became one",
    "texts' per-paragraph alignments or line heights became one",
  ],
  "interaction-skipped": [
    "prototype interaction wasn't imported",
    "prototype interactions weren't imported",
  ],
  tokens: ["design token set wasn't imported", "design token sets weren't imported"],
  "library-color-paint": [
    "library colour that's a gradient or an image wasn't kept as a variable",
    "library colours that are gradients or images weren't kept as variables",
  ],
  "text-rtl": [
    "right-to-left text is laid out left to right",
    "right-to-left texts are laid out left to right",
  ],
  "stroke-caps": [
    "line's two different end caps became one",
    "lines' two different end caps became one",
  ],
  "overlay-position": [
    "overlay's manual position became centred",
    "overlays' manual positions became centred",
  ],
  "unknown-features": [
    "file uses Penpot features this import doesn't know yet, so some of it may look different",
    "files use Penpot features this import doesn't know yet, so some of them may look different",
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type NoteKind = keyof typeof NOTE_TEXT;

/** Penpot's notes (see NoteBook). */
export class Notes extends NoteBook<NoteKind> {
  constructor() {
    super(NOTE_TEXT);
  }
}
