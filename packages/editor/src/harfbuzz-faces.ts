/**
 * HarfBuzz faces shared by font file (decision 0033, item 4.2). Making a
 * face copies its whole file into HarfBuzz's memory, which is capped and
 * never shrinks. A variable family serves every weight from one file, so a
 * face per weight held the same file hundreds of times over (800 weights of
 * Inter took 172 MiB). One face per file, read by every font made from it,
 * holds it once. The measurer and the shaper both read from here.
 *
 * Files are told apart by identity: the host's font loaders keep one
 * `ArrayBuffer` per file and hand out the same one each time.
 *
 * A face is counted: each `acquireFace` is a hold on it, and when the last
 * hold is released the face and its copy of the file are freed at once, not
 * whenever JavaScript's collector gets to them (it knows nothing of
 * HarfBuzz's cap). The measurer releases what a load that ran out of memory
 * made, so faces loaded before keep the room they had to measure in.
 */
type HarfBuzz = typeof import("harfbuzzjs");
type HbFace = InstanceType<HarfBuzz["Face"]>;
type HbBlob = InstanceType<HarfBuzz["Blob"]>;

export interface SharedFace {
  readonly face: HbFace;
  /** The characters it has, read the first time they're asked for. */
  readonly unicodes: ReadonlySet<number>;
}

interface Held extends SharedFace {
  readonly blob: HbBlob;
  holds: number;
}

const shared = new WeakMap<object, WeakMap<ArrayBuffer, Held>>();

/**
 * The face for a font file in this HarfBuzz, made the first time it's asked
 * for, and held until a `releaseFace` for each `acquireFace`.
 */
export function acquireFace(hb: HarfBuzz, bytes: ArrayBuffer): SharedFace {
  let faces = shared.get(hb);
  if (!faces) {
    faces = new WeakMap();
    shared.set(hb, faces);
  }
  let entry = faces.get(bytes);
  if (!entry) {
    const blob = new hb.Blob(bytes);
    let face: HbFace;
    try {
      face = new hb.Face(blob);
    } catch (error) {
      blob.destroy();
      throw error;
    }
    let unicodes: ReadonlySet<number> | null = null;
    entry = {
      face,
      blob,
      holds: 0,
      get unicodes() {
        unicodes ??= new Set(face.collectUnicodes());
        return unicodes;
      },
    };
    faces.set(bytes, entry);
  }
  entry.holds++;
  return entry;
}

/**
 * Lets go of a hold from `acquireFace`. The last one frees the face and its
 * file: destroy the fonts made from it first.
 */
export function releaseFace(hb: HarfBuzz, bytes: ArrayBuffer): void {
  const faces = shared.get(hb);
  const entry = faces?.get(bytes);
  if (!faces || !entry || --entry.holds > 0) return;
  faces.delete(bytes);
  // The face first: the blob's data is freed with the blob, and the face reads from it.
  entry.face.destroy();
  entry.blob.destroy();
}

/** What HarfBuzz throws when its capped memory has no room (`patches/harfbuzzjs`). */
export function isHarfBuzzOutOfMemory(error: unknown): boolean {
  return error instanceof Error && error.name === "HarfBuzzOutOfMemory";
}
