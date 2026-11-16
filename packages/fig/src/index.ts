/**
 * Figma .fig import: reads a file saved with Figma's "Save local copy" into
 * the file Figma's REST API would return, for `@drawpane/figma` to convert.
 * Open Pencil's MIT packages (@open-pencil/fig, kiwi and scene-graph) do the
 * decoding and fill in instances; see NOTICE for their licences.
 */
export { sniffFig } from "./container";
export { ImportError, type ImportErrorCode } from "./errors";
export { commandsToPath, gradientHandles } from "./geometry";
export { type FigImage, imageMime } from "./images";
export { FIG_NOTE_TEXT, type FigNoteKind, FigNotes } from "./notes";
export {
  type BuildOptions,
  type FigFile,
  type FigPage,
  MAX_FILE_BYTES,
  MAX_LAYERS,
  MAX_RECORDS,
  type OpenedFig,
  type OpenOptions,
  openFig,
  planPasses,
  type ReadOptions,
  type ReadProgress,
  readFig,
} from "./read";
