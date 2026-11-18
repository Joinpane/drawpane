/**
 * Loads the fonts a document uses, as it opens and as people edit: every
 * text layer's family, weight and style, including styled runs within it,
 * and the families font aliases draw them in (decision 0036: "SF Pro" loads
 * the team's SF Pro Text and SF Pro Display). Only new faces cost anything,
 * so typing in an already-loaded font does nothing here.
 */
import { type Doc, textFaces } from "@drawpane/editor";
import { fonts } from "./fonts";

export function watchDocumentFonts(doc: Doc): () => void {
  const seen = new Set<string>();
  /** Every face text names, to look again for stand-ins when the registry learns more. */
  const named = new Map<string, { family: string; weight: number; italic: boolean }>();
  /** Faces asked for (in the family named or a stand-in), each once. */
  const asked = new Set<string>();
  let pending: Set<string> | "all" | null = null;

  const scan = (ids: Iterable<string>) => {
    for (const id of ids) {
      const node = doc.get(id);
      if (node?.type !== "text") continue;
      // Its own face and its runs' (a bold word, a different family).
      for (const { family, weight, italic } of textFaces(node)) {
        const key = `${family}\u0000${weight}\u0000${italic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        named.set(key, { family, weight, italic });
        load(family, weight, italic, key);
        standIns(family, weight, italic);
      }
    }
  };

  // Faces nothing provided yet: retried when the registry learns more (the
  // team's fonts arriving after the document, say).
  const unresolved = new Map<string, { family: string; weight: number; italic: boolean }>();
  const load = (family: string, weight: number, italic: boolean, key: string) => {
    void fonts.ensure(family, [{ weight, italic }]).then((found) => {
      if (found) unresolved.delete(key);
      else unresolved.set(key, { family, weight, italic });
    });
  };
  /** The families aliases may draw a face in, loaded at its weight and style. */
  const standIns = (family: string, weight: number, italic: boolean) => {
    for (const name of fonts.standIns(family)) {
      const key = `${name}\u0000${weight}\u0000${italic}`;
      if (asked.has(key)) continue;
      asked.add(key);
      void fonts.ensure(name, [{ weight, italic }]);
    }
  };
  const offFonts = fonts.subscribe(() => {
    for (const [key, face] of unresolved) {
      if (fonts.get(face.family)) load(face.family, face.weight, face.italic, key);
    }
    // The team's fonts or aliases arrived: what stands in for a family may have, too.
    for (const face of named.values()) standIns(face.family, face.weight, face.italic);
  });

  // Batched to one pass per task: a paste or a remote batch touches many layers at once.
  const flush = () => {
    const ids = pending;
    pending = null;
    if (ids === "all") scan([...doc.nodes()].map((n) => n.id));
    else if (ids) scan(ids);
  };

  pending = "all";
  queueMicrotask(flush);
  const offDoc = doc.subscribe((change) => {
    const first = pending === null;
    if (change.reset) pending = "all";
    else if (pending !== "all") {
      pending ??= new Set();
      for (const id of change.ids) pending.add(id);
    }
    if (first) queueMicrotask(flush);
  });
  return () => {
    offDoc();
    offFonts();
  };
}

/**
 * The document families a batch of loaded font faces belongs to: bundled
 * variable fonts register as "<Family> Variable", and picker previews
 * (which never stand in for a document font) are left out.
 */
export function loadedFamilies(faces: Iterable<FontFace>): Set<string> {
  const out = new Set<string>();
  for (const face of faces) {
    const name = face.family.replace(/^["']|["']$/g, "");
    if (name.endsWith(" Preview")) continue;
    out.add(name.replace(/ Variable$/, ""));
  }
  return out;
}
