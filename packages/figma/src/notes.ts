/**
 * What a Figma import couldn't carry over exactly, for the summary after an
 * import (see NoteBook). Kinds follow the gaps in Drawpane's model that
 * Figma files use most.
 */
import { NoteBook } from "@drawpane/import-kit";

export const NOTE_TEXT = {
  "boolean-flattened": ["boolean group became a path", "boolean groups became paths"],
  "shape-flattened": ["star, polygon or arc became a path", "stars, polygons or arcs became paths"],
  skewed: ["skewed layer was straightened", "skewed layers were straightened"],
  "gradient-diamond": ["diamond gradient became radial", "diamond gradients became radial"],
  "gradient-skewed": [
    "gradient with an unusual width handle became regular",
    "gradients with unusual width handles became regular",
  ],
  "image-missing": ["image couldn't be fetched", "images couldn't be fetched"],
  "image-adjusted": [
    "image's adjustments (exposure, contrast…) were dropped",
    "images' adjustments (exposure, contrast…) were dropped",
  ],
  "image-tile-scale": ["tiled image's scale was reset", "tiled images' scales were reset"],
  "paint-unsupported": ["pattern or video fill was dropped", "pattern or video fills were dropped"],
  "stroke-sides": [
    "layer's per-side stroke widths became one width",
    "layers' per-side stroke widths became one width",
  ],
  "glass-settings": [
    "glass effect came in with default settings (Figma's API doesn't share them)",
    "glass effects came in with default settings (Figma's API doesn't share them)",
  ],
  "blur-progressive": ["progressive blur became even", "progressive blurs became even"],
  "text-paragraphs": [
    "text's per-paragraph styles became one",
    "texts' per-paragraph styles became one",
  ],
  "component-properties": [
    "component's boolean, text or swap properties were resolved into its copies",
    "components' boolean, text or swap properties were resolved into their copies",
  ],
  "library-component": [
    "copy of a component from a library was detached",
    "copies of components from libraries were detached",
  ],
  "component-omitted": [
    "copy of a component on a page left out was detached",
    "copies of components on pages left out were detached",
  ],
  "unsupported-node": [
    "layer of an unsupported kind was skipped",
    "layers of unsupported kinds were skipped",
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type NoteKind = keyof typeof NOTE_TEXT;

export class Notes extends NoteBook<NoteKind> {
  constructor() {
    super(NOTE_TEXT);
  }
}
