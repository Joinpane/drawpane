/**
 * Figma import: Figma's REST file format (GET /v1/files/:key?geometry=paths)
 * as a Drawpane document, with notes on what couldn't come across exactly.
 */
export {
  type ConvertedFile,
  type ConvertOptions,
  convertFile,
  imageRefs,
  networkPath,
  variantProps,
} from "./convert";
export { drawpaneId, mirroredId } from "./ids";
export { NOTE_TEXT, type NoteKind, Notes } from "./notes";
export { hexColor, type ImageLookup } from "./paint";
export type * as Figma from "./rest";
