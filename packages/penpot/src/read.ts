/**
 * Reads a .penpot export (binfile v3) into plain records: the manifest, and
 * for each file its record, pages with their shapes, components and the
 * storage objects (images) it references. No conversion happens here; see
 * `convert.ts`.
 *
 * Layout of the zip:
 *   manifest.json
 *   files/<file>.json                     the file record (library colours, typographies…)
 *   files/<file>/pages/<page>.json        a page record
 *   files/<file>/pages/<page>/<shape>.json one shape each, the root frame included
 *   files/<file>/components/<id>.json     component records
 *   files/<file>/media/<id>.json          image records (→ a storage object)
 *   files/<file>/colors/<id>.json         library colours
 *   files/<file>/typographies/<id>.json   library text styles
 *   files/<file>/tokens.json              design tokens
 *   objects/<id>.json + objects/<id>.<ext> storage objects (images), metadata and bytes
 *   files/<file>/thumbnails/…             ignored
 */
import { ImportError } from "./errors";
import { readZip, type ZipEntry } from "./zip";

/** A Penpot record as it is on disk: camelCase keys, JSON values. */
export type PenpotRecord = Record<string, unknown> & { readonly id: string };

export interface PenpotPage {
  readonly record: PenpotRecord;
  /** Every shape on the page by id, the root frame (all zeros) included. */
  readonly shapes: ReadonlyMap<string, PenpotRecord>;
}

export interface PenpotFile {
  readonly id: string;
  readonly name: string;
  readonly record: PenpotRecord;
  readonly pages: readonly PenpotPage[];
  readonly components: ReadonlyMap<string, PenpotRecord>;
  /** Image records by media id: `mediaId` names the storage object with the bytes. */
  readonly media: ReadonlyMap<string, PenpotRecord>;
  readonly colors: ReadonlyMap<string, PenpotRecord>;
  readonly typographies: ReadonlyMap<string, PenpotRecord>;
  /** The file has design tokens (not imported yet). */
  readonly hasTokens: boolean;
}

export interface PenpotObject {
  readonly id: string;
  readonly record: PenpotRecord;
  /** The object's bytes (an image), read on demand. */
  readonly entry: ZipEntry | null;
}

export interface PenpotExport {
  readonly manifest: PenpotRecord;
  readonly files: readonly PenpotFile[];
  readonly objects: ReadonlyMap<string, PenpotObject>;
}

const decoder = new TextDecoder();
const json = async (entry: ZipEntry): Promise<PenpotRecord> => {
  try {
    return JSON.parse(decoder.decode(await entry.read())) as PenpotRecord;
  } catch {
    throw new ImportError("corrupt", `"${entry.name}" in the export isn't readable.`);
  }
};

export async function readPenpot(bytes: Uint8Array): Promise<PenpotExport> {
  // Old exports (binfile v1/v2) are binary, not zips: say so plainly.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new ImportError(
      "unsupported",
      "This .penpot is in an older format. Open it in a recent Penpot and export it again.",
    );
  const entries = readZip(bytes);
  const manifestEntry = entries.get("manifest.json");
  if (!manifestEntry)
    throw new ImportError("not-penpot", "This zip isn't a Penpot export (it has no manifest).");
  const manifest = await json(manifestEntry);
  if (manifest.type !== "penpot/export-files")
    throw new ImportError("not-penpot", "This zip isn't a Penpot export.");

  const listed = Array.isArray(manifest.files) ? (manifest.files as PenpotRecord[]) : [];
  const files: PenpotFile[] = [];
  for (const info of listed) {
    const fileEntry = entries.get(`files/${info.id}.json`);
    if (!fileEntry) continue;
    const record = await json(fileEntry);
    const prefix = `files/${info.id}/`;
    const pageRecords: PenpotRecord[] = [];
    const shapes = new Map<string, Map<string, PenpotRecord>>();
    const components = new Map<string, PenpotRecord>();
    const media = new Map<string, PenpotRecord>();
    const colors = new Map<string, PenpotRecord>();
    const typographies = new Map<string, PenpotRecord>();
    const libraries = { components, media, colors, typographies } as const;
    for (const [name, entry] of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const parts = name.slice(prefix.length, -".json".length).split("/");
      if (parts[0] === "pages" && parts.length === 2) pageRecords.push(await json(entry));
      else if (parts[0] === "pages" && parts.length === 3) {
        const page = parts[1] as string;
        const list = shapes.get(page) ?? new Map<string, PenpotRecord>();
        const shape = await json(entry);
        list.set(shape.id, shape);
        shapes.set(page, list);
      } else if (parts.length === 2 && parts[0] && parts[0] in libraries) {
        const record = await json(entry);
        libraries[parts[0] as keyof typeof libraries].set(record.id, record);
      }
    }
    pageRecords.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    files.push({
      id: info.id,
      name: typeof info.name === "string" ? info.name : String(record.name ?? "Untitled"),
      record,
      pages: pageRecords.map((page) => ({
        record: page,
        shapes: shapes.get(page.id) ?? new Map(),
      })),
      components,
      media,
      colors,
      typographies,
      hasTokens: entries.has(`${prefix}tokens.json`),
    });
  }
  if (files.length === 0) throw new ImportError("not-penpot", "This export has no files in it.");

  const objects = new Map<string, PenpotObject>();
  for (const [name, entry] of entries) {
    const match = /^objects\/([^/]+)\.json$/.exec(name);
    if (!match) continue;
    const id = match[1] as string;
    const record = await json(entry);
    const data = [...entries.values()].find(
      (e) => e.name.startsWith(`objects/${id}.`) && !e.name.endsWith(".json"),
    );
    objects.set(id, { id, record: { ...record, id }, entry: data ?? null });
  }
  return { manifest, files, objects };
}
