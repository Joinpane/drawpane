/**
 * A .fig file's images, by the ref its paints use: the hex SHA-1 of the
 * image file. Zipped files keep them as `images/<sha1>`; older raw files
 * keep them among the message's blobs, where hashing finds them again.
 * Neither says what format an image is, so that's read from its first bytes.
 */

export interface FigImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** The image format from its signature, or null when it isn't one a browser shows. */
export function imageMime(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

async function sha1(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The images `refs` names, from the zip's entries and, failing those, from
 * blobs that are images. Refs found in neither are left out.
 */
export async function collectImages(
  refs: Iterable<string>,
  entries: Iterable<readonly [string, Uint8Array]>,
  blobs: readonly Uint8Array[],
): Promise<Map<string, FigImage>> {
  const wanted = new Set(refs);
  const out = new Map<string, FigImage>();
  const take = (ref: string, bytes: Uint8Array) => {
    if (!wanted.has(ref) || out.has(ref)) return;
    out.set(ref, { bytes, mime: imageMime(bytes) ?? "application/octet-stream" });
  };
  for (const [ref, bytes] of entries) take(ref.toLowerCase(), bytes);
  if (out.size < wanted.size)
    for (const blob of blobs) {
      if (!imageMime(blob)) continue;
      take(await sha1(blob), blob);
      if (out.size === wanted.size) break;
    }
  return out;
}
