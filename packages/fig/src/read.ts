/**
 * Reads a .fig file into the REST-shaped file the Figma converter takes,
 * with its images and notes on anything that couldn't come across.
 *
 * Open Pencil decodes the file and builds a scene graph with instances
 * filled in from their components. Before it does, style links are
 * prepared (styles.ts). A large file is built a page at a time, each page
 * adapted and its graph let go before the next, so memory stays near one
 * page's worth and progress shows as it goes.
 *
 * Heavy: run it in a Worker. Nothing here touches the DOM.
 */
import type { Figma } from "@drawpane/figma";
import {
  type DocumentAssemblyOptions,
  materializeDocument,
  parseFigBuffer,
} from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { RestFileBuilder } from "./adapt";
import { corruptError, sniffFig } from "./container";
import { ImportError } from "./errors";
import { RestIds, recordLayers } from "./ids";
import { collectImages, type FigImage } from "./images";
import { FigNotes } from "./notes";
import { guidString, indexRecords, type RawRecord } from "./raw";
import { prepareStyles } from "./styles";

/** Larger files are refused before reading: decoding one needs several times its size in memory. */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;
/** Saved records past which a file would take minutes and gigabytes to read in a tab. */
export const MAX_RECORDS = 250_000;
/** Layers once instances are filled in: what one import can save (the server's limit). */
export const MAX_LAYERS = 200_000;
/**
 * Files with more records than this are built a page at a time. Each page
 * costs Open Pencil another index of the whole file, so smaller files are
 * quicker built at once.
 */
export const PAGE_AT_A_TIME_RECORDS = 20_000;

export type ReadProgress =
  | { readonly stage: "reading" }
  | { readonly stage: "pages"; readonly done: number; readonly total: number }
  | { readonly stage: "mapping" };

export interface ReadOptions {
  /** The file's own name, used when the file doesn't carry one. */
  readonly fileName?: string;
  readonly onProgress?: (progress: ReadProgress) => void;
  /** Build a page at a time whatever the file's size (tests compare both ways). */
  readonly pageAtATime?: boolean;
}

export interface FigFile {
  readonly file: Figma.File;
  /** The images its paints use, by image ref. */
  readonly images: ReadonlyMap<string, FigImage>;
  readonly notes: FigNotes;
  readonly pages: number;
  /** Layers in the document once instances are filled in, pages not counted. */
  readonly layers: number;
  /** The container's format version, for reports. */
  readonly version: number;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const count = (n: number) => n.toLocaleString("en");

function tooLarge(what: string): ImportError {
  return new ImportError(
    "too-large",
    `This file is too large to import here (${what}). In Figma, split it into smaller files and save a local copy of each.`,
  );
}

/** Every image ref a REST file's paints use. */
function imageRefs(node: Figma.Node, out: Set<string>): Set<string> {
  const paints = (ps: readonly Figma.Paint[] | undefined) => {
    for (const p of ps ?? []) if (p.type === "IMAGE" && p.imageRef) out.add(p.imageRef);
  };
  paints(node.fills);
  paints(node.strokes);
  for (const s of Object.values(node.styleOverrideTable ?? {})) paints(s.fills);
  for (const c of node.children ?? []) imageRefs(c, out);
  return out;
}

/** Lets a Worker post its progress before the next long, synchronous step. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The document's pages in Figma's order (by saved position), without its internal page. */
function pageRecords(records: readonly NodeChange[]): NodeChange[] {
  return records
    .filter((r) => r.type === "CANVAS" && !r.internalOnly && r.phase !== "REMOVED")
    .sort((a, b) => {
      const pa = a.parentIndex?.position ?? "";
      const pb = b.parentIndex?.position ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
}

export async function readFig(bytes: Uint8Array, options: ReadOptions = {}): Promise<FigFile> {
  const progress = options.onProgress ?? (() => {});
  if (bytes.length > MAX_FILE_BYTES)
    throw tooLarge(`${mb(bytes.length)}; ${mb(MAX_FILE_BYTES)} at most`);
  const container = await sniffFig(bytes);
  progress({ stage: "reading" });
  await breathe();

  // Open Pencil reads an ArrayBuffer of its own.
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  let parsed: ReturnType<typeof parseFigBuffer>;
  try {
    parsed = parseFigBuffer(buffer);
  } catch {
    throw corruptError();
  }
  const records = parsed.nodeChanges.filter((r) => r.phase !== "REMOVED");
  if (records.length > MAX_RECORDS)
    throw tooLarge(`${count(records.length)} saved layers; ${count(MAX_RECORDS)} at most`);
  prepareStyles(records);
  const raw = indexRecords(records as unknown as RawRecord[]);

  const notes = new FigNotes();
  const missing = new Set<string>();
  const assembly: DocumentAssemblyOptions = {
    // Figma keeps overrides whose layer is gone and ignores them; so does the import.
    onUnresolvedProperty: () => {},
    onUnresolvedAssignment: () => {},
    onMissingSlotContent: () => {},
    onMissingComponent: (d) => missing.add(d.ownerId),
  };

  const pages = pageRecords(records);
  const pageAtATime = options.pageAtATime ?? records.length > PAGE_AT_A_TIME_RECORDS;
  const batches: (string[] | null)[] = pageAtATime
    ? pages.map((p) => [guidString(p.guid as { sessionID: number; localID: number })])
    : [null];
  const builder = new RestFileBuilder();
  let built = 0;
  for (const batch of batches) {
    progress({ stage: "pages", done: built, total: pages.length });
    await breathe();
    let state: ReturnType<typeof materializeDocument>;
    try {
      state = materializeDocument(records, parsed.blobs, {
        ...assembly,
        ...(batch ? { pageIds: new Set(batch) } : {}),
      });
    } catch {
      throw corruptError();
    }
    const ids = new RestIds(state.graph, recordLayers(state));
    const ctx = { graph: state.graph, ids, records: raw, notes };
    for (const page of state.graph.getPages(false)) {
      const guid = ids.sourceGuid(page);
      // A page-at-a-time graph also holds the pages of components the page uses.
      if (batch && (!guid || !batch.includes(guid))) continue;
      builder.addPage(page, ctx);
      built++;
    }
    builder.addLibrary(ctx);
    if (builder.layers > MAX_LAYERS)
      throw tooLarge(`more than ${count(MAX_LAYERS)} layers once its components are filled in`);
  }
  progress({ stage: "pages", done: pages.length, total: pages.length });
  if (missing.size > 0) notes.add("component-missing", missing.size);

  progress({ stage: "mapping" });
  await breathe();
  const meta = parseMeta(parsed.metaJSON);
  const name =
    meta.name || (options.fileName ?? "").replace(/\.fig$/i, "").trim() || "Imported from Figma";
  const file = builder.build(name, meta.exportedAt);
  const images = await collectImages(
    imageRefs(file.document, new Set()),
    parsed.images,
    parsed.blobs,
  );
  return {
    file,
    images,
    notes,
    pages: (file.document.children ?? []).length,
    layers: builder.layers,
    version: container.version,
  };
}

function parseMeta(json: string | null): { name?: string; exportedAt?: string } {
  if (!json) return {};
  try {
    const meta = JSON.parse(json) as { file_name?: unknown; exported_at?: unknown };
    return {
      ...(typeof meta.file_name === "string" ? { name: meta.file_name.trim() } : {}),
      ...(typeof meta.exported_at === "string" ? { exportedAt: meta.exported_at } : {}),
    };
  } catch {
    return {};
  }
}
