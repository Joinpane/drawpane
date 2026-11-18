/**
 * Reads a .fig file into the REST-shaped file the Figma converter takes,
 * with its images and notes on anything that couldn't come across.
 *
 * Opening a file decodes it and prepares its records: style links
 * (styles.ts) and variable bindings Open Pencil can't follow
 * (variables.ts). It also estimates each page's size (estimate.ts), in
 * seconds even for the largest kits, so a file too large for one Drawpane
 * file is known before anything is built and its pages can be chosen.
 *
 * Reading then builds the chosen pages with Open Pencil, which fills in
 * instances from their components. A large file is built a few pages at a
 * time, as many as fit a memory budget by their estimates, each pass
 * adapted and its graph let go before the next, so memory stays near one
 * pass's worth and progress shows as it goes. (Each pass costs Open Pencil
 * another index of the whole file, so passes are as few as fit.)
 *
 * Heavy: run it in a Worker. Nothing here touches the DOM.
 */
import type { Figma } from "@drawpane/figma";
import { MAX_IMPORT_NODES } from "@drawpane/model";
import {
  type DocumentAssemblyOptions,
  materializeDocument,
  parseFigBuffer,
} from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";
import { RestFileBuilder } from "./adapt";
import { corruptError, sniffFig } from "./container";
import { ImportError } from "./errors";
import { estimateLayers } from "./estimate";
import { RestIds, recordLayers } from "./ids";
import { collectImages, type FigImage } from "./images";
import { FigNotes } from "./notes";
import { guidString, indexRecords, type RawRecord } from "./raw";
import { indexChildren } from "./slots";
import { prepareStyles } from "./styles";
import { applySwappedLooks } from "./swaps";
import { prepareVariables } from "./variables";
import { prepareVariantOptions, type VariantResolver, variantResolver } from "./variants";

/** Larger files are refused before reading: decoding one needs several times its size in memory. */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;
/** Saved records past which a file would take minutes and gigabytes to read in a tab. */
export const MAX_RECORDS = 250_000;
/** Layers once instances are filled in: what one import can save (the server's limit). */
export const MAX_LAYERS = MAX_IMPORT_NODES;
/**
 * Files with fewer records than this are built in one pass: each pass
 * costs Open Pencil another index of the whole file, which for a small file
 * is quicker than holding back.
 */
export const ONE_PASS_RECORDS = 20_000;
/**
 * The most layers (by estimate) one pass builds in a larger file. A pass's
 * graph holds every layer it builds, at some kilobytes each, so this keeps
 * a pass near a gigabyte. A page larger than this is a pass of its own.
 */
export const PASS_LAYERS = 40_000;

export type ReadProgress =
  | { readonly stage: "reading" }
  | { readonly stage: "pages"; readonly done: number; readonly total: number }
  | { readonly stage: "mapping" };

export interface OpenOptions {
  /** The file's own name, used when the file doesn't carry one. */
  readonly fileName?: string;
  readonly onProgress?: (progress: ReadProgress) => void;
}

export interface BuildOptions {
  /** The pages to read, by id (`FigPage.id`); all of them when left out. */
  readonly pageIds?: Iterable<string>;
  readonly onProgress?: (progress: ReadProgress) => void;
  /** Build a page at a time whatever the file's size (tests compare both ways). */
  readonly pageAtATime?: boolean;
}

export interface ReadOptions extends OpenOptions, BuildOptions {}

/** A page of the file, in Figma's order. */
export interface FigPage {
  readonly id: string;
  readonly name: string;
  /** About how many layers it comes to once instances are filled in (see estimate.ts). */
  readonly layers: number;
}

/** A decoded .fig file, its pages known and ready to build. */
export interface OpenedFig {
  /** The file's name in Figma, else the name it was saved under. */
  readonly name: string;
  readonly pages: readonly FigPage[];
  /** About how many layers the whole file comes to once instances are filled in. */
  readonly layers: number;
  /** The container's format version, for reports. */
  readonly version: number;
  /** Builds the chosen pages (all by default) into the REST-shaped file. */
  read(options?: BuildOptions): Promise<FigFile>;
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

function tooLarge(what: string, advice: string): ImportError {
  return new ImportError("too-large", `This file is too large to import here (${what}). ${advice}`);
}
const SPLIT_IN_FIGMA = "In Figma, split it into smaller files and save a local copy of each.";

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

/**
 * The passes that build the chosen pages: null for the whole file at once,
 * else lists of page ids, in Figma's order, each as many pages as fit
 * PASS_LAYERS by their estimates.
 */
export function planPasses(
  pages: readonly FigPage[],
  chosen: ReadonlySet<string>,
  records: number,
  pageAtATime = false,
): (string[] | null)[] {
  const picked = pages.filter((p) => chosen.has(p.id));
  if (pageAtATime) return picked.map((p) => [p.id]);
  if (records <= ONE_PASS_RECORDS)
    return [picked.length === pages.length ? null : picked.map((p) => p.id)];
  const passes: string[][] = [];
  let pass: string[] = [];
  let size = 0;
  for (const page of picked) {
    if (pass.length > 0 && size + page.layers > PASS_LAYERS) {
      passes.push(pass);
      pass = [];
      size = 0;
    }
    pass.push(page.id);
    size += page.layers;
  }
  if (pass.length > 0) passes.push(pass);
  return passes;
}

/** Decodes a .fig file and gets its pages ready to build; throws an ImportError on a file it can't read. */
export async function openFig(bytes: Uint8Array, options: OpenOptions = {}): Promise<OpenedFig> {
  const progress = options.onProgress ?? (() => {});
  if (bytes.length > MAX_FILE_BYTES)
    throw tooLarge(`${mb(bytes.length)}; ${mb(MAX_FILE_BYTES)} at most`, SPLIT_IN_FIGMA);
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
  } catch (error) {
    throw corruptError(error);
  }
  const records = parsed.nodeChanges.filter((r) => r.phase !== "REMOVED");
  if (records.length > MAX_RECORDS)
    throw tooLarge(
      `${count(records.length)} saved layers; ${count(MAX_RECORDS)} at most`,
      SPLIT_IN_FIGMA,
    );
  prepareStyles(records);
  prepareVariables(records);
  prepareVariantOptions(records);

  const pageList = pageRecords(records);
  const estimates = estimateLayers(records, pageList);
  const pages: FigPage[] = pageList.map((p) => {
    const id = guidString(p.guid as { sessionID: number; localID: number });
    return { id, name: p.name ?? "", layers: estimates.get(id) ?? 0 };
  });
  const meta = parseMeta(parsed.metaJSON);
  const name =
    meta.name || (options.fileName ?? "").replace(/\.fig$/i, "").trim() || "Imported from Figma";

  return {
    name,
    pages,
    layers: pages.reduce((sum, p) => sum + p.layers, 0),
    version: container.version,
    read: (build = {}) =>
      buildPages(parsed, records, pages, build, {
        name,
        exportedAt: meta.exportedAt,
        version: container.version,
      }),
  };
}

/** Reads a whole .fig file (or the pages `options.pageIds` names). */
export async function readFig(bytes: Uint8Array, options: ReadOptions = {}): Promise<FigFile> {
  const fig = await openFig(bytes, options);
  return fig.read(options);
}

async function buildPages(
  parsed: ReturnType<typeof parseFigBuffer>,
  records: NodeChange[],
  pages: readonly FigPage[],
  options: BuildOptions,
  file: { name: string; exportedAt: string | undefined; version: number },
): Promise<FigFile> {
  const progress = options.onProgress ?? (() => {});
  const chosen = new Set(options.pageIds ?? pages.map((p) => p.id));
  const whole = chosen.size === pages.length && pages.every((p) => chosen.has(p.id));
  const raw = indexRecords(records as unknown as RawRecord[]);
  const saved = { records: raw, children: indexChildren(raw.values()) };

  const notes = new FigNotes();
  const missing = new Set<string>();
  const assembly: DocumentAssemblyOptions & { resolveVariant: VariantResolver } = {
    // Figma saves the sizes, places and shapes it worked out for the layers of each copy
    // (`derivedSymbolData`): an icon placeholder shrunk to 16 resizes its icons uniformly
    // whatever their constraints, overridden text keeps the width its own characters take,
    // slot content sits inside its instance's padding. Without them Open Pencil works those out
    // from the main's layers and constraints alone, which gets them wrong; with them, it applies
    // what Figma saved, as Figma shows it.
    derivedBounds: true,
    // Figma keeps overrides whose layer is gone and ignores them; so does the import.
    onUnresolvedProperty: () => {},
    onUnresolvedAssignment: () => {},
    onMissingSlotContent: () => {},
    onMissingComponent: (d) => missing.add(d.ownerId),
    // A link to a library's style or variable the file didn't save a copy of: Figma shows the
    // layer's own saved values then, and so does the import.
    onUnresolvedBinding: () => {},
    // Variables don't come across (layers carry their values), so neither do ones Open Pencil
    // can't read, such as a variable computed from an expression.
    onUnsupportedResource: () => {},
    // A nested instance whose variant property is bound to a variable shows the variant its
    // value names in the modes where the copy is placed (variants.ts; a patched hook).
    resolveVariant: variantResolver(raw),
  };

  const passes = planPasses(pages, chosen, records.length, options.pageAtATime);
  const total = whole ? pages.length : chosen.size;
  /** Pages of the file left out, whose components come in as detached copies. */
  const omitted = new Set(pages.filter((p) => !chosen.has(p.id)).map((p) => p.id));
  const builder = new RestFileBuilder();
  /** Glyph outlines, each kept once across the passes. */
  const outlines = new Map<string, string>();
  let built = 0;
  for (const pass of passes) {
    progress({ stage: "pages", done: built, total });
    await breathe();
    let state: ReturnType<typeof materializeDocument>;
    try {
      state = materializeDocument(records, parsed.blobs, {
        ...assembly,
        ...(pass ? { pageIds: new Set(pass) } : {}),
      });
    } catch (error) {
      throw corruptError(error);
    }
    const layers = recordLayers(state);
    const ids = new RestIds(state.graph, layers, saved);
    applySwappedLooks(state.graph, ids, raw, layers);
    const ctx = { graph: state.graph, ids, records: raw, notes, outlines };
    for (const page of state.graph.getPages(false)) {
      const guid = ids.sourceGuid(page);
      // A pass's graph also holds the pages of components its pages use.
      if (pass && (!guid || !pass.includes(guid))) continue;
      builder.addPage(page, ctx);
      built++;
    }
    builder.addLibrary(ctx, omitted);
    if (builder.layers > MAX_LAYERS)
      throw new ImportError(
        "too-many-layers",
        `${whole ? "This file comes" : "These pages come"} to more than ${count(MAX_LAYERS)} layers once their components are filled in, more than one Drawpane file holds. Choose ${whole ? "some of its pages" : "fewer pages"} to import.`,
      );
  }
  progress({ stage: "pages", done: total, total });
  if (missing.size > 0) notes.add("component-missing", missing.size);

  progress({ stage: "mapping" });
  await breathe();
  const rest = builder.build(file.name, file.exportedAt);
  const images = await collectImages(
    imageRefs(rest.document, new Set()),
    parsed.images,
    parsed.blobs,
  );
  return {
    file: rest,
    images,
    notes,
    pages: (rest.document.children ?? []).length,
    layers: builder.layers,
    version: file.version,
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
