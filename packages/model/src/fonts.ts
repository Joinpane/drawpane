/**
 * Reading uploaded font files: what format they are, and the facts a team
 * font needs (family, style, weight, italic, a variable weight range, and
 * what the license says), straight from the font's own tables.
 *
 * Formats are recognised by their first bytes, never by file name or
 * Content-Type. TrueType and OpenType tables are read as they are; WOFF
 * tables are zlib-compressed and WOFF2 tables share one Brotli stream, so
 * the caller supplies those decompressors (the Worker has both).
 */

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

/** The largest font file a team can upload. */
export const FONT_MAX_BYTES = 15 * 1024 * 1024;

export const FONT_MIME: Readonly<Record<FontFormat, string>> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** How @font-face names each format in `src: url() format()`. */
export const FONT_CSS_FORMAT: Readonly<Record<FontFormat, string>> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

/** The format a file's first bytes declare, or null when it isn't a font. */
export function sniffFont(bytes: Uint8Array): FontFormat | null {
  if (bytes.byteLength < 12) return null;
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "\x00\x01\x00\x00" || tag === "true") return "ttf";
  return null;
}

export interface FontMeta {
  readonly format: FontFormat;
  /** The typographic family ("Acme Sans"), which is what text names. */
  readonly family: string;
  /** The face within it ("Bold Italic"). */
  readonly style: string;
  /** The weight class (100–900); for a variable font, its lightest weight. */
  readonly weight: number;
  /** A variable font's heaviest weight; null for a static face. */
  readonly weightMax: number | null;
  readonly italic: boolean;
  /** An open license the font names ("OFL", "Apache"), or null when it names another or none. */
  readonly license: string | null;
  /** The font marks itself "restricted license embedding": web use may need a separate license. */
  readonly restricted: boolean;
}

/** A face a team uploaded, as the API lists it. */
export interface TeamFontFace {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly weight: number;
  readonly weightMax: number | null;
  readonly italic: boolean;
  readonly format: FontFormat;
  /** Content hash of the file; its URL is /api/teams/<team>/fonts/file/<sha>. */
  readonly sha: string;
  readonly bytes: number;
  readonly license: string | null;
  readonly restricted: boolean;
  /** Who uploaded it (their name), when they're still around. */
  readonly uploadedBy: string | null;
  readonly createdAt: number;
}

export interface Decompressors {
  /** zlib (RFC 1950) data, as WOFF tables are stored. */
  inflate(data: Uint8Array): Promise<Uint8Array>;
  /** A Brotli stream, as WOFF2 stores its tables. */
  brotli(data: Uint8Array): Promise<Uint8Array>;
}

export class FontError extends Error {
  override name = "FontError";
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

/** The tables a team font is read from. */
const WANTED = new Set(["name", "OS/2", "head", "fvar"]);

/** WOFF2's table tags by index (the spec's "known table tags"). */
const WOFF2_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
] as const;

function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength)
    throw new FontError("The font file is cut short or damaged.");
  return bytes.subarray(offset, offset + length);
}

/** The tables of a TrueType or OpenType file. */
function sfntTables(bytes: Uint8Array): Map<string, Uint8Array> {
  const v = view(bytes);
  const count = v.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = tagAt(bytes, at);
    if (WANTED.has(tag)) tables.set(tag, slice(bytes, v.getUint32(at + 8), v.getUint32(at + 12)));
  }
  return tables;
}

async function woffTables(bytes: Uint8Array, d: Decompressors): Promise<Map<string, Uint8Array>> {
  const v = view(bytes);
  const count = v.getUint16(12);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const tag = tagAt(bytes, at);
    if (!WANTED.has(tag)) continue;
    const data = slice(bytes, v.getUint32(at + 4), v.getUint32(at + 8));
    const original = v.getUint32(at + 12);
    tables.set(tag, data.byteLength < original ? await d.inflate(data) : data);
  }
  return tables;
}

/** A WOFF2 UIntBase128: up to five bytes of seven bits, high bit meaning "more". */
function base128(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    if (byte === undefined || (i === 0 && byte === 0x80))
      throw new FontError("The font file is cut short or damaged.");
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new FontError("The font file is cut short or damaged.");
}

async function woff2Tables(bytes: Uint8Array, d: Decompressors): Promise<Map<string, Uint8Array>> {
  const v = view(bytes);
  if (tagAt(bytes, 4) === "ttcf") throw new FontError("Font collections aren't supported yet.");
  const count = v.getUint16(12);
  const compressedSize = v.getUint32(20);
  let at = 48;
  const entries: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < count; i++) {
    const flags = bytes[at++] ?? 0;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      tag = tagAt(bytes, at);
      at += 4;
    } else {
      tag = WOFF2_TAGS[index] ?? "????";
    }
    const version = flags >> 6;
    let original: number;
    [original, at] = base128(bytes, at);
    // glyf and loca are transformed unless marked 3; every other table only when marked.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    let length = original;
    if (transformed) [length, at] = base128(bytes, at);
    entries.push({ tag, length });
  }
  const stream = await d.brotli(slice(bytes, at, compressedSize));
  const tables = new Map<string, Uint8Array>();
  let offset = 0;
  for (const { tag, length } of entries) {
    if (WANTED.has(tag)) tables.set(tag, slice(stream, offset, length));
    offset += length;
  }
  return tables;
}

/** A name table string by ID, preferring Windows US English, then any Unicode, then Mac. */
function nameOf(table: Uint8Array, id: number): string | null {
  const v = view(table);
  const count = v.getUint16(2);
  const storage = v.getUint16(4);
  let best: { rank: number; text: string } | null = null;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.byteLength || v.getUint16(at + 6) !== id) continue;
    const platform = v.getUint16(at);
    const language = v.getUint16(at + 4);
    const length = v.getUint16(at + 8);
    const offset = storage + v.getUint16(at + 10);
    if (offset + length > table.byteLength) continue;
    const raw = table.subarray(offset, offset + length);
    let text: string;
    let rank: number;
    if (platform === 3 || platform === 0) {
      text = "";
      for (let k = 0; k + 1 < raw.length; k += 2)
        text += String.fromCharCode((raw[k] ?? 0) * 256 + (raw[k + 1] ?? 0));
      rank = platform === 3 && language === 0x409 ? 0 : platform === 3 ? 1 : 2;
    } else if (platform === 1) {
      text = String.fromCharCode(...raw);
      rank = 3;
    } else continue;
    if (!best || rank < best.rank) best = { rank, text };
  }
  return best ? clean(best.text) : null;
}

/** A name safe to show and to put in CSS: no control characters, single spaces, at most 128 characters. */
function clean(text: string): string {
  const printable = [...text].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return printable.join("").replace(/\s+/g, " ").trim().slice(0, 128);
}

const OPEN_LICENSES: ReadonlyArray<[RegExp, string]> = [
  [/open font license|\bOFL\b/i, "OFL"],
  [/apache license/i, "Apache"],
  [/ubuntu font licen[cs]e/i, "Ubuntu"],
  [/\bMIT\b/, "MIT"],
];

/** Everything a team font needs, from its tables. */
export function fontMetaFromTables(
  format: FontFormat,
  tables: ReadonlyMap<string, Uint8Array>,
): FontMeta {
  const name = tables.get("name");
  if (!name) throw new FontError("That font has no name table, so it can't be named.");
  const family = nameOf(name, 16) ?? nameOf(name, 1);
  if (!family) throw new FontError("That font doesn't say which family it belongs to.");
  const style = nameOf(name, 17) ?? nameOf(name, 2) ?? "Regular";

  let weight = 400;
  let italic = /italic|oblique/i.test(style);
  let restricted = false;
  const os2 = tables.get("OS/2");
  if (os2 && os2.byteLength >= 10) {
    const v = view(os2);
    const weightClass = v.getUint16(4);
    if (weightClass >= 1 && weightClass <= 1000) weight = weightClass;
    // fsType: bits 0–3 hold the embedding level; 2 is "restricted license embedding".
    restricted = (v.getUint16(8) & 0x000f) === 0x0002;
    if (os2.byteLength >= 64) italic ||= (v.getUint16(62) & 0x0201) !== 0;
  } else {
    const head = tables.get("head");
    if (head && head.byteLength >= 46) italic ||= (view(head).getUint16(44) & 0x0002) !== 0;
  }

  let weightMax: number | null = null;
  const fvar = tables.get("fvar");
  if (fvar && fvar.byteLength >= 16) {
    const v = view(fvar);
    const axes = v.getUint16(4);
    const count = v.getUint16(8);
    const size = v.getUint16(10);
    for (let i = 0; i < count; i++) {
      const at = axes + i * size;
      if (at + 16 > fvar.byteLength) break;
      if (tagAt(fvar, at) !== "wght") continue;
      const min = Math.round(v.getInt32(at + 4) / 65536);
      const max = Math.round(v.getInt32(at + 12) / 65536);
      if (min >= 1 && max <= 1000 && max > min) {
        weight = min;
        weightMax = max;
      }
    }
  }

  const licenseText = `${nameOf(name, 13) ?? ""} ${nameOf(name, 14) ?? ""}`;
  const license = OPEN_LICENSES.find(([re]) => re.test(licenseText))?.[1] ?? null;
  return { format, family, style, weight, weightMax, italic, license, restricted };
}

/** Reads a font file's facts. Throws FontError with a sentence a person can act on. */
export async function readFontMeta(bytes: Uint8Array, d: Decompressors): Promise<FontMeta> {
  const format = sniffFont(bytes);
  if (!format) throw new FontError("That isn't a font file. Upload .ttf, .otf, .woff or .woff2.");
  if (bytes.byteLength > FONT_MAX_BYTES) throw new FontError("Font files can be up to 15 MB.");
  try {
    const tables =
      format === "woff2"
        ? await woff2Tables(bytes, d)
        : format === "woff"
          ? await woffTables(bytes, d)
          : sfntTables(bytes);
    return fontMetaFromTables(format, tables);
  } catch (error) {
    if (error instanceof FontError) throw error;
    throw new FontError("The font file is cut short or damaged.");
  }
}
