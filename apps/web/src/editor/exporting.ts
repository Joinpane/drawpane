/**
 * Exporting the selection: rendered in this tab with the canvas's own
 * renderer, then downloaded. Settings are remembered per browser.
 */
import {
  CanvasRenderer,
  cssRule,
  type Editor,
  EXPORT_MIME,
  ExportError,
  type ExportFormat,
  exportBounds,
  exportFileName,
  exportRaster,
  exportSvg,
} from "@drawpane/editor";
import { embeddedImages } from "./export-assets";
import { imagesFor } from "./media";
import { type PdfPage, pdfPageOf, pdfPages, renderPdf } from "./pdf";

export interface ExportSettings {
  readonly scale: 1 | 2 | 3;
  readonly format: ExportFormat;
}

const KEY = "drawpane.export";
const FORMATS: readonly ExportFormat[] = ["png", "jpeg", "webp", "svg", "pdf"];
let settings: ExportSettings = load();
const listeners = new Set<() => void>();

function load(): ExportSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ExportSettings> | null;
    const scale = raw?.scale === 2 || raw?.scale === 3 ? raw.scale : 1;
    const format = FORMATS.includes(raw?.format as ExportFormat)
      ? (raw?.format as ExportFormat)
      : "png";
    return { scale, format };
  } catch {
    return { scale: 1, format: "png" };
  }
}

export const exportSettings = {
  get: (): ExportSettings => settings,
  set(next: Partial<ExportSettings>): void {
    settings = { ...settings, ...next };
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Private mode or blocked storage: keep it for this session only.
    }
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The selection without layers whose parent is also selected. */
export function exportTargets(editor: Editor): string[] {
  const ids = editor.s.selection.filter((id) => editor.doc.has(id));
  const set = new Set(ids);
  return ids.filter((id) => !editor.doc.ancestors(id).some((a) => set.has(a.id)));
}

/** What the file is called: the layer's name, or the first one's and a count. */
export function exportName(editor: Editor, ids: readonly string[]): string {
  const first = ids[0] ? editor.doc.get(ids[0]) : undefined;
  const name = first?.props.name || "Export";
  return ids.length > 1 ? `${name} and ${ids.length - 1} more` : name;
}

/** Renders layers in the given format, transparent where nothing is drawn (white for JPEG). */
export async function renderExport(
  editor: Editor,
  ids: readonly string[],
  { format, scale }: ExportSettings,
): Promise<Blob> {
  if (format === "pdf") {
    return (await renderPdf(editor, pdfPages(editor, ids), exportName(editor, ids))).blob;
  }
  if (format === "svg") {
    const bounds = exportBounds(editor.scene, ids);
    if (!bounds) throw new ExportError("Nothing visible to export. Show the layer and try again.");
    // Images go inside as data: URLs, so the file stands on its own.
    const images = await embeddedImages(editor, ids);
    return new Blob([exportSvg(editor.scene, editor.measurer, ids, bounds, { images })], {
      type: EXPORT_MIME.svg,
    });
  }
  const renderer = new CanvasRenderer(editor.scene, editor.measurer, {
    images: imagesFor(editor),
  });
  return exportRaster(renderer, editor.scene, ids, { format, scale });
}

/** Saves a blob through the browser's download, then lets the object URL go. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ⇧⌘E and the Export button: exports the selection with the remembered settings. */
export async function exportSelection(
  editor: Editor,
  options: ExportSettings = exportSettings.get(),
): Promise<void> {
  const ids = exportTargets(editor);
  if (ids.length === 0) {
    editor.notify("Select a layer to export.");
    return;
  }
  const name = exportFileName(exportName(editor, ids), options.format, options.scale);
  try {
    if (options.format === "pdf") {
      await savePdf(editor, pdfPages(editor, ids), exportName(editor, ids));
      return;
    }
    download(await renderExport(editor, ids, options), name);
    editor.notify(`Exported ${name}.`);
  } catch (error) {
    editor.notify(
      error instanceof ExportError
        ? error.message
        : "Couldn't export. Try a smaller scale, or another format.",
    );
  }
}

/** Renders pages into a PDF and saves it, saying which fonts were swapped. */
async function savePdf(editor: Editor, pages: readonly PdfPage[], title: string): Promise<void> {
  if (pages.length > 1) editor.notify(`Preparing ${pages.length} pages…`);
  const name = exportFileName(title, "pdf");
  const { blob, missingFonts } = await renderPdf(editor, pages, title);
  download(blob, name);
  editor.notify(
    missingFonts.length > 0
      ? `Exported ${name}. ${listOf(missingFonts)} ${missingFonts.length === 1 ? "isn't" : "aren't"} available, so ${missingFonts.length === 1 ? "it's" : "they're"} set in Helvetica.`
      : `Exported ${name}.`,
  );
}

const listOf = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * Exports every top-level frame on the page as one PDF, a page per frame in
 * reading order, like a deck. With no frames, the page's layers make one page.
 */
export async function exportPageAsPdf(editor: Editor): Promise<void> {
  const pageId = editor.s.pageId;
  const page = pageId ? editor.doc.get(pageId) : undefined;
  if (!pageId || !page) return;
  const top = editor.doc
    .childIds(pageId)
    .filter((id) => editor.doc.get(id)?.props.visible !== false);
  const frames = top.filter((id) => editor.doc.get(id)?.type === "frame");
  if (top.length === 0) {
    editor.notify("Nothing on this page to export yet.");
    return;
  }
  try {
    const name = page.props.name || "Page";
    await savePdf(
      editor,
      frames.length > 0 ? pdfPages(editor, frames) : pdfPageOf(editor, top, name),
      name,
    );
  } catch (error) {
    editor.notify(
      error instanceof ExportError ? error.message : "Couldn't export the PDF. Try again.",
    );
  }
}

export type CopyFormat = "png" | "svg" | "css";

const COPY_LABEL: Record<CopyFormat, string> = { png: "PNG", svg: "SVG", css: "CSS" };

/**
 * "Copy as": the selection as a PNG image (2×, for crisp pastes into docs and
 * chat), as SVG markup, or the first layer's CSS, on the system clipboard.
 */
export async function copySelectionAs(editor: Editor, format: CopyFormat): Promise<void> {
  const ids = exportTargets(editor);
  if (ids.length === 0) {
    editor.notify("Select a layer to copy.");
    return;
  }
  try {
    if (format === "css") {
      const node = editor.doc.get(ids[0] as string);
      if (!node) return;
      await navigator.clipboard.writeText(cssRule(editor.doc, node));
    } else if (format === "svg") {
      const blob = await renderExport(editor, ids, { format: "svg", scale: 1 });
      await navigator.clipboard.writeText(await blob.text());
    } else {
      // Safari needs the ClipboardItem built synchronously from a promise.
      const png = renderExport(editor, ids, { format: "png", scale: 2 });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    }
    editor.notify(`Copied ${exportName(editor, ids)} as ${COPY_LABEL[format]}.`);
  } catch (error) {
    editor.notify(
      error instanceof ExportError
        ? error.message
        : `Couldn't copy as ${COPY_LABEL[format]}. Your browser may have blocked the clipboard.`,
    );
  }
}
