/**
 * What kind of file the bytes are, before anything heavy reads them: a
 * `.fig` is either a zip (what Figma saves today: `canvas.fig`, a thumbnail,
 * `meta.json` and the images) or, from older versions, the bare `fig-kiwi`
 * container. Its first eight bytes say which product saved it: `fig-kiwi`
 * for Figma Design, `fig-jam.` for FigJam and `fig-deck` for Slides.
 */
import { isZip, readZip, type ZipEntry, type ZipErrors } from "@drawpane/import-kit";
import { ImportError, SAVE_LOCAL_COPY } from "./errors";

export interface Container {
  readonly zip: boolean;
  /** The kiwi container's format version (4 in the oldest files seen, 101 and up today). */
  readonly version: number;
}

const notFig = () => new ImportError("not-fig", `This isn't a Figma .fig file. ${SAVE_LOCAL_COPY}`);
const corrupt = () =>
  new ImportError(
    "corrupt",
    "This .fig file is damaged or incomplete. Save a local copy from Figma again.",
  );

const ZIP_ERRORS: ZipErrors = {
  corrupt,
  unsupported: () => corrupt(),
  tooLarge: () => new ImportError("too-large", "This .fig file is too large to import here."),
};

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** The entry holding the document: `canvas.fig`, `canvas` in older files, else the largest other entry. */
function canvasEntry(entries: ReadonlyMap<string, ZipEntry>): ZipEntry | undefined {
  const named = entries.get("canvas.fig") ?? entries.get("canvas");
  if (named) return named;
  let largest: ZipEntry | undefined;
  for (const entry of entries.values())
    if (!/\.(png|jpe?g|json)$/i.test(entry.name) && !entry.name.startsWith("images/"))
      if (!largest || entry.size > largest.size) largest = entry;
  return largest;
}

/** Throws a plain-language ImportError unless the bytes are a Figma design file. */
export async function sniffFig(bytes: Uint8Array): Promise<Container> {
  let zip = false;
  let head = bytes;
  if (isZip(bytes)) {
    zip = true;
    const entries = readZip(bytes, ZIP_ERRORS);
    if (entries.has("manifest.json") && !entries.has("canvas.fig"))
      throw new ImportError(
        "not-fig",
        "This looks like a Penpot export. Choose Penpot above to import it.",
      );
    const canvas = canvasEntry(entries);
    if (!canvas) throw notFig();
    // Figma stores the canvas uncompressed, so this is a view, not a copy.
    head = await canvas.read();
  }
  if (head.length < 12) throw zip ? corrupt() : notFig();
  const magic = ascii(head, 0, 8);
  if (magic === "fig-jam.")
    throw new ImportError(
      "not-design",
      "This is a FigJam board. Only Figma design files can be imported.",
    );
  if (magic === "fig-deck")
    throw new ImportError(
      "not-design",
      "This is a Figma Slides deck. Only Figma design files can be imported.",
    );
  if (magic !== "fig-kiwi") throw zip ? corrupt() : notFig();
  const version = new DataView(head.buffer, head.byteOffset + 8, 4).getUint32(0, true);
  return { zip, version };
}

export { corrupt as corruptError };
