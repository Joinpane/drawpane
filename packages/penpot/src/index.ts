/**
 * Penpot import. In order: `readPenpot` the export's bytes; for each file,
 * upload `imagesOf(file)` and note each one's media hash; then
 * `convertFile(file, lookup)` gives the nodes to fill a new Drawpane file
 * with, and notes on anything that couldn't come across exactly.
 */
import type { PenpotExport, PenpotFile } from "./read";

export { type ConvertedFile, convertFile } from "./convert";
export { ImportError, type ImportErrorCode } from "./errors";
export { NOTE_TEXT, type NoteKind, Notes } from "./notes";
export {
  type PenpotExport,
  type PenpotFile,
  type PenpotObject,
  type PenpotPage,
  readPenpot,
} from "./read";
export type { MediaLookup } from "./styles";

export interface PenpotImage {
  /** The media id fills refer to. */
  readonly mediaId: string;
  readonly name: string;
  readonly mime: string;
  read(): Promise<Uint8Array>;
}

/** The images a file's fills use, each with its bytes from the export. */
export function imagesOf(exp: PenpotExport, file: PenpotFile): PenpotImage[] {
  const out: PenpotImage[] = [];
  for (const record of file.media.values()) {
    const storage =
      typeof record.mediaId === "string" ? exp.objects.get(record.mediaId) : undefined;
    const entry = storage?.entry;
    if (!entry) continue;
    out.push({
      mediaId: record.id,
      name: String(record.name ?? "image"),
      mime: String(record.mtype ?? storage.record.contentType ?? "image/png"),
      read: () => entry.read(),
    });
  }
  return out;
}

/** How many layers a file has, for progress and the summary. */
export function layerCount(file: PenpotFile): number {
  return file.pages.reduce((n, page) => n + Math.max(0, page.shapes.size - 1), 0);
}
