/**
 * What an import couldn't carry over exactly, counted by kind, so the person
 * importing gets a short, honest summary ("3 boolean groups became paths")
 * instead of silent differences.
 */
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
} as const satisfies Record<string, readonly [string, string]>;

export type NoteKind = keyof typeof NOTE_TEXT;

export class Notes {
  readonly #counts = new Map<NoteKind, number>();

  add(kind: NoteKind, count = 1): void {
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + count);
  }

  merge(other: Notes): void {
    for (const [kind, count] of other.entries()) this.add(kind, count);
  }

  entries(): Array<[NoteKind, number]> {
    return [...this.#counts.entries()];
  }

  /** "2 boolean groups became paths", one line per kind. */
  lines(): string[] {
    return this.entries().map(([kind, count]) => {
      const [one, many] = NOTE_TEXT[kind];
      return count === 1 ? `1 ${one}` : `${count} ${many}`;
    });
  }
}
