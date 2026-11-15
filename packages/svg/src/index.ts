export {
  type ConvertedSvg,
  type ConvertOptions,
  convertSvg,
  SVG_MAX_LAYERS,
  type SvgLayer,
  svgSize,
} from "./convert";
export { NOTE_TEXT, type NoteKind, Notes } from "./notes";
export { looksLikeSvg, parseSvg, SVG_MAX_BYTES, SVG_MAX_ELEMENTS, SvgProblem } from "./parse";

import { type ConvertedSvg, type ConvertOptions, convertSvg } from "./convert";
import { parseSvg } from "./parse";

/** SVG text straight to layers. Throws an SvgProblem, in plain words, when it can't. */
export function svgToLayers(
  text: string,
  options: ConvertOptions & { parser?: DOMParser } = {},
): ConvertedSvg {
  return convertSvg(parseSvg(text, options.parser), options);
}
