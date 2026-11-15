/**
 * SVG text to a detached document, safely. The text is parsed with
 * DOMParser as `image/svg+xml` into a document of its own that's never
 * attached to the page, so nothing in it runs or loads: scripts, event
 * attributes and external references are inert there, and the converter
 * ignores them besides. Markup that isn't well-formed XML (an undeclared
 * `xlink:` prefix, an HTML entity) gets a second, forgiving parse as HTML,
 * also detached. Size is capped before parsing and elements after.
 */

/** Largest SVG accepted, in bytes (UTF-16 code units of its text). */
export const SVG_MAX_BYTES = 10 * 1024 * 1024;
/** Most elements an SVG may have, counted before `<use>` copies them. */
export const SVG_MAX_ELEMENTS = 50_000;

export class SvgProblem extends Error {
  override readonly name = "SvgProblem";
}

/** True when some text is SVG markup (pasted from an icon set or "Copy as SVG"). */
export function looksLikeSvg(text: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s/>]/i.test(
    text.slice(0, 4096).replace(/^\uFEFF/, ""),
  );
}

/** Declares prefixes that copied markup often uses without declaring. */
function declarePrefixes(text: string): string {
  return text.replace(/<svg\b[^>]*>/i, (tag) => {
    let out = tag;
    if (!/\sxmlns\s*=/.test(out))
      out = out.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    if (/\bxlink:/.test(text) && !/\sxmlns:xlink\s*=/.test(out))
      out = out.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    return out;
  });
}

/**
 * The root `<svg>` element of some SVG text, in a detached document.
 * Throws an SvgProblem, in words for the person importing, when it can't be read.
 */
export function parseSvg(text: string, parser: DOMParser = new DOMParser()): Element {
  if (text.length > SVG_MAX_BYTES)
    throw new SvgProblem("SVGs can be up to 10 MB. Simplify it or export a smaller version.");
  const source = declarePrefixes(text);
  let root: Element | null = null;
  const xml = parser.parseFromString(source, "image/svg+xml");
  if (xml.getElementsByTagName("parsererror").length === 0) root = xml.documentElement;
  if (root?.localName !== "svg") {
    // Not well-formed XML: HTML's parser forgives what copied markup gets wrong.
    const html = parser.parseFromString(source, "text/html");
    root = html.getElementsByTagName("svg")[0] ?? null;
  }
  if (root?.localName !== "svg")
    throw new SvgProblem(
      "The file isn't an SVG Drawpane can read. Export it again and try once more.",
    );
  if (root.getElementsByTagName("*").length > SVG_MAX_ELEMENTS)
    throw new SvgProblem(
      "The SVG has more than 50,000 elements, too many to edit as layers. Simplify it first.",
    );
  return root;
}
