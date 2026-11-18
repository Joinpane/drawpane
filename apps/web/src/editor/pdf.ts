/**
 * PDF export: each frame a page, at one point per pixel, fully vector.
 *
 * Pages are drawn from the SVG export (shapes, gradients, strokes, images,
 * clipping, masks) by svg2pdf. Text stays real text in its own typeface:
 * every family the pages use is embedded as TrueType, fetched through this
 * server's font proxy (one static file per weight). Built-in system faces
 * map to the PDF standard fonts, and anything unavailable falls back to
 * Helvetica, which the caller is told about. Text with OpenType features
 * goes in as its shaped glyphs (outlines), since PDF text can't take them.
 *
 * jsPDF and svg2pdf load on first use, so they cost nothing until then.
 */
import {
  drawnFamily,
  type Editor,
  ExportError,
  exportBounds,
  exportSvg,
  type Rect,
  type ShapingFace,
  type SvgImageSource,
  shapingFace,
  shapingRun,
  textSpans,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { type Face, faceKey, facesOffered, pickFace } from "../fonts/font-files";
import { fonts } from "../fonts/fonts";
import { embeddedImages, readingOrder } from "./export-assets";
import { shaper } from "./shaping";

/** What a face becomes in the PDF: an embedded font's name, or a standard one with its style. */
interface PdfFont {
  readonly family: string;
  readonly weight: "normal" | "bold";
  readonly style: "normal" | "italic";
}

/** System families the PDF standard fonts stand in for. */
const STANDARD: Readonly<Record<string, "helvetica" | "times" | "courier">> = {
  "system-ui": "helvetica",
  Arial: "helvetica",
  Helvetica: "helvetica",
  Verdana: "helvetica",
  Tahoma: "helvetica",
  "Trebuchet MS": "helvetica",
  Georgia: "times",
  "Times New Roman": "times",
  "Courier New": "courier",
};

const standard = (family: "helvetica" | "times" | "courier", face: Face): PdfFont => ({
  family,
  weight: face.weight >= 600 ? "bold" : "normal",
  style: face.italic ? "italic" : "normal",
});

/** Every face the text inside some layers is drawn in (through font aliases, decision 0034). */
function facesIn(editor: Editor, ids: readonly string[]): Face[] {
  const faces = new Map<string, Face>();
  const visit = (id: string) => {
    const node = editor.doc.get(id);
    if (!node || getProp(node.props, "visible") === false) return;
    if (node.type === "text")
      for (const span of textSpans(node)) {
        const face = {
          family: drawnFamily(span.props, editor.measurer),
          weight: getProp(span.props, "fontWeight"),
          italic: getProp(span.props, "fontStyle") === "italic",
        };
        faces.set(faceKey(face), face);
      }
    for (const child of editor.doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return [...faces.values()];
}

/** The faces shaped runs (OpenType features, variable axes) draw from inside some layers. */
function shapedFacesIn(editor: Editor, ids: readonly string[]): ShapingFace[] {
  const faces = new Map<string, ShapingFace>();
  const visit = (id: string) => {
    const node = editor.doc.get(id);
    if (!node || getProp(node.props, "visible") === false) return;
    if (node.type === "text")
      for (const span of textSpans(node)) {
        const run = shapingRun(span.props, editor.measurer);
        if (!run) continue;
        const face = shapingFace(run);
        faces.set(`${faceKey(face)}\u0000${face.variable ? "v" : ""}`, face);
      }
    for (const child of editor.doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return [...faces.values()];
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // In chunks: String.fromCharCode can't take a whole font as arguments.
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

type JsPdf = import("jspdf").jsPDF;

/**
 * Embeds the fonts for `faces` in `pdf`. Returns how each face is set, and
 * the families that had to fall back to Helvetica.
 */
async function embedFonts(
  pdf: JsPdf,
  faces: readonly Face[],
): Promise<{ fontFor: Map<string, PdfFont>; missing: Set<string> }> {
  const fontFor = new Map<string, PdfFont>();
  const missing = new Set<string>();
  const byFamily = new Map<string, Face[]>();
  for (const face of faces) byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
  let next = 0;

  await Promise.all(
    [...byFamily].map(async ([family, wanted]) => {
      const info = await fonts.resolve(family);
      const fallback = STANDARD[family];
      if (fallback) {
        for (const face of wanted) fontFor.set(faceKey(face), standard(fallback, face));
        return;
      }
      try {
        if (!info) throw new Error("missing");
        // TrueType only: PDFs can't take WOFF, and jsPDF can't take CFF-based OpenType.
        const offered = await facesOffered(family, info, wanted, ["ttf"]);
        if (offered.length === 0) throw new Error("not embeddable");
        const files = new Map<string, Promise<string>>();
        for (const face of wanted) {
          const chosen = pickFace(offered, face);
          if (!chosen) throw new Error("no face");
          let name = files.get(chosen.url);
          if (!name) {
            const id = `f${next++}`;
            name = fetch(chosen.url)
              .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
              .then((bytes) => {
                pdf.addFileToVFS(`${id}.ttf`, base64(bytes));
                pdf.addFont(`${id}.ttf`, id, "normal");
                return id;
              });
            files.set(chosen.url, name);
          }
          fontFor.set(faceKey(face), { family: await name, weight: "normal", style: "normal" });
        }
      } catch {
        missing.add(family);
        for (const face of wanted) fontFor.set(faceKey(face), standard("helvetica", face));
      }
    }),
  );
  return { fontFor, missing };
}

/** Points text at the embedded fonts: one PDF font per face, so weight and style live in it. */
function setFonts(svg: SVGSVGElement, fontFor: ReadonlyMap<string, PdfFont>): void {
  for (const text of svg.querySelectorAll("text")) {
    const family =
      (text.getAttribute("font-family") ?? "").split(",")[0]?.trim().replace(/^'|'$/g, "") ?? "";
    const face: Face = {
      family,
      weight: Number(text.getAttribute("font-weight") ?? 400),
      italic: text.getAttribute("font-style") === "italic",
    };
    const font = fontFor.get(faceKey(face)) ?? standard("helvetica", face);
    text.setAttribute("font-family", font.family);
    text.setAttribute("font-weight", font.weight);
    text.setAttribute("font-style", font.style);
  }
}

export interface PdfPage {
  /** The layers on the page (usually one frame). */
  readonly ids: readonly string[];
  readonly name: string;
  readonly bounds: Rect;
}

/** Pages for layers: each one its own page, in reading order. */
export function pdfPages(editor: Editor, ids: readonly string[]): PdfPage[] {
  const pages = ids.flatMap((id) => {
    const bounds = exportBounds(editor.scene, [id]);
    const node = editor.doc.get(id);
    return bounds && node
      ? [{ ids: [id], name: getProp(node.props, "name") || "Page", bounds }]
      : [];
  });
  return readingOrder(pages);
}

/** One page holding all of `ids`, cut to their bounds. */
export function pdfPageOf(editor: Editor, ids: readonly string[], name: string): PdfPage[] {
  const bounds = exportBounds(editor.scene, ids);
  return bounds ? [{ ids, name, bounds }] : [];
}

/**
 * Renders pages into a PDF. Returns it, and the font families that weren't
 * available (set in Helvetica instead).
 */
export async function renderPdf(
  editor: Editor,
  pages: readonly PdfPage[],
  title: string,
): Promise<{ blob: Blob; missingFonts: string[] }> {
  if (pages.length === 0)
    throw new ExportError("Nothing visible to export. Show the layer and try again.");
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const first = pages[0] as PdfPage;
  const orientation = (b: Rect) => (b.width > b.height ? "landscape" : "portrait");
  const size = (b: Rect): [number, number] => [Math.max(1, b.width), Math.max(1, b.height)];
  const pdf = new jsPDF({
    unit: "pt",
    format: size(first.bounds),
    orientation: orientation(first.bounds),
    compress: true,
  });
  pdf.setProperties({ title, creator: "Drawpane" });

  const ids = pages.flatMap((p) => p.ids);
  const [images, { fontFor, missing }] = await Promise.all([
    embeddedImages(editor, ids),
    embedFonts(pdf, facesIn(editor, ids)),
    // The faces text with OpenType features is shaped in, ready before drawing.
    Promise.all(shapedFacesIn(editor, ids).map((face) => shaper.load(face))),
  ]);

  // svg2pdf reads computed styles, so each page's SVG is attached while it draws.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden";
  document.body.append(host);
  try {
    for (const [index, page] of pages.entries()) {
      if (index > 0) pdf.addPage(size(page.bounds), orientation(page.bounds));
      const svg = pageSvg(editor, page, images);
      setFonts(svg, fontFor);
      host.append(svg);
      await pdf.svg(svg, { x: 0, y: 0, width: page.bounds.width, height: page.bounds.height });
      svg.remove();
      // A bookmark per page, named after its frame.
      pdf.outline.add(null, page.name, { pageNumber: index + 1 });
    }
  } finally {
    host.remove();
  }
  return { blob: pdf.output("blob"), missingFonts: [...missing].sort() };
}

function pageSvg(
  editor: Editor,
  page: PdfPage,
  images: (ref: string) => SvgImageSource | null,
): SVGSVGElement {
  // Text with OpenType features goes in as its glyphs: a PDF's text can't take features.
  const markup = exportSvg(editor.scene, editor.measurer, page.ids, page.bounds, {
    images,
    outlineFeatures: true,
  });
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  return document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
}
