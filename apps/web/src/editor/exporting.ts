/**
 * Exporting the selection: rendered in this tab with the canvas's own
 * renderer, then downloaded. Settings are remembered per browser.
 */
import {
  CanvasRenderer,
  type Editor,
  EXPORT_MIME,
  ExportError,
  type ExportFormat,
  exportBounds,
  exportFileName,
  exportRaster,
  exportSvg,
} from "@drawpane/editor";
import { imagesFor } from "./media";

export interface ExportSettings {
  readonly scale: 1 | 2 | 3;
  readonly format: ExportFormat;
}

const KEY = "drawpane.export";
const FORMATS: readonly ExportFormat[] = ["png", "jpeg", "webp", "svg"];
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
  if (format === "svg") {
    const bounds = exportBounds(editor.scene, ids);
    if (!bounds) throw new ExportError("Nothing visible to export. Show the layer and try again.");
    return new Blob([exportSvg(editor.scene, editor.measurer, ids, bounds)], {
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
