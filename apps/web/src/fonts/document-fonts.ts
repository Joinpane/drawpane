/**
 * Loads the fonts a document uses, as it opens and as people edit: every
 * text layer's family, weight and style, including styled runs within it. Only new faces cost anything, so
 * typing in an already-loaded font does nothing here.
 */
import { type Doc, textFaces } from "@drawpane/editor";
import { fonts } from "./fonts";

export function watchDocumentFonts(doc: Doc): () => void {
  const seen = new Set<string>();
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
        load(family, weight, italic, key);
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
  const offFonts = fonts.subscribe(() => {
    for (const [key, face] of unresolved) {
      if (fonts.get(face.family)) load(face.family, face.weight, face.italic, key);
    }
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
