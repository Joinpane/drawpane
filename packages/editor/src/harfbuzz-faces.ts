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
 */
type HarfBuzz = typeof import("harfbuzzjs");
type HbFace = InstanceType<HarfBuzz["Face"]>;

export interface SharedFace {
  readonly face: HbFace;
  /** The characters it has, read the first time they're asked for. */
  readonly unicodes: ReadonlySet<number>;
}

const shared = new WeakMap<object, WeakMap<ArrayBuffer, SharedFace>>();

/** The face for a font file in this HarfBuzz, made the first time it's asked for. */
export function sharedFace(hb: HarfBuzz, bytes: ArrayBuffer): SharedFace {
  let faces = shared.get(hb);
  if (!faces) {
    faces = new WeakMap();
    shared.set(hb, faces);
  }
  let entry = faces.get(bytes);
  if (!entry) {
    const face = new hb.Face(new hb.Blob(bytes));
    let unicodes: ReadonlySet<number> | null = null;
    entry = {
      face,
      get unicodes() {
        unicodes ??= new Set(face.collectUnicodes());
        return unicodes;
      },
    };
    faces.set(bytes, entry);
  }
  return entry;
}

/** What HarfBuzz throws when its capped memory has no room (`patches/harfbuzzjs`). */
export function isHarfBuzzOutOfMemory(error: unknown): boolean {
  return error instanceof Error && error.name === "HarfBuzzOutOfMemory";
}
