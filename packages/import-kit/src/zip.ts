/**
 * A small zip reader: the central directory, stored and deflated entries
 * (inflated with the platform's DecompressionStream), and zip64 sizes.
 * Entries inflate only when read, so an export's thumbnails cost nothing.
 * Penpot exports and Figma's `.fig` files are both zips.
 */

export interface ZipEntry {
  readonly name: string;
  /** Uncompressed size in bytes. */
  readonly size: number;
  read(): Promise<Uint8Array>;
}

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Inflated entries larger than this are refused (a zip bomb, or not an export). */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** The errors a zip reader throws, in the words of the format it reads. */
export interface ZipErrors {
  /** Not a zip, or a damaged one. */
  corrupt(): Error;
  /** An entry compressed some way other than stored or deflated. */
  unsupported(name: string): Error;
  /** An entry that would inflate past MAX_ENTRY_BYTES. */
  tooLarge(name: string): Error;
}

const PLAIN: ZipErrors = {
  corrupt: () => new Error("This file isn't a readable zip."),
  unsupported: (name) => new Error(`"${name}" uses a compression this importer can't read.`),
  tooLarge: (name) => new Error(`"${name}" is too large.`),
};

/** True when the bytes start like a zip (a local file header). */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
  );
}

export function readZip(bytes: Uint8Array, errors: ZipErrors = PLAIN): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const corrupt = errors.corrupt;
  if (bytes.length < 22) throw corrupt();

  // The end-of-central-directory record, searched for from the end (it may carry a comment).
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  let count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  // Zip64: the real count and offset live in the zip64 record the locator points at.
  if (
    (count === 0xffff || offset === 0xffffffff) &&
    eocd >= 20 &&
    u32(eocd - 20) === ZIP64_LOCATOR
  ) {
    const record = u64(eocd - 20 + 8);
    if (u32(record) !== ZIP64_EOCD) throw corrupt();
    count = u64(record + 32);
    offset = u64(record + 48);
  }

  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(at) !== CENTRAL) throw corrupt();
    const method = u16(at + 10);
    let compressed = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let local = u32(at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // Zip64 extra field: whichever of the sizes and offset overflowed, in order.
    for (let x = at + 46 + nameLength; x < at + 46 + nameLength + extraLength; ) {
      const tag = u16(x);
      const length = u16(x + 2);
      if (tag === 0x0001) {
        let field = x + 4;
        if (size === 0xffffffff) {
          size = u64(field);
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = u64(field);
          field += 8;
        }
        if (local === 0xffffffff) local = u64(field);
      }
      x += 4 + length;
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const entrySize = size;
    const entryCompressed = compressed;
    const entryLocal = local;
    entries.set(name, {
      name,
      size: entrySize,
      read: async () => {
        if (u32(entryLocal) !== LOCAL) throw corrupt();
        const start = entryLocal + 30 + u16(entryLocal + 26) + u16(entryLocal + 28);
        const data = bytes.subarray(start, start + entryCompressed);
        if (method === 0) return data;
        if (method !== 8) throw errors.unsupported(name);
        if (entrySize > MAX_ENTRY_BYTES) throw errors.tooLarge(name);
        return inflateRaw(data);
      },
    });
  }
  return entries;
}

/** Raw deflate data, inflated by the platform. */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
