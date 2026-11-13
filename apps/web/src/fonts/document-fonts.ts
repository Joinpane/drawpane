/**
 * Loads the fonts a document uses, as it opens and as people edit: every
 * text layer's family, weight and style. Only new faces cost anything, so
 * typing in an already-loaded font does nothing here.
 */
import type { Doc } from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { fonts } from "./fonts";

export function watchDocumentFonts(doc: Doc): () => void {
  const seen = new Set<string>();
  let pending: Set<string> | "all" | null = null;

  const scan = (ids: Iterable<string>) => {
    for (const id of ids) {
      const node = doc.get(id);
      if (node?.type !== "text") continue;
      const family = getProp(node.props, "fontFamily");
      const weight = getProp(node.props, "fontWeight");
      const italic = getProp(node.props, "fontStyle") === "italic";
      const key = `${family}\u0000${weight}\u0000${italic}`;
      if (seen.has(key)) continue;
      seen.add(key);
      void fonts.ensure(family, [{ weight, italic }]);
    }
  };

  // Batched to one pass per task: a paste or a remote batch touches many layers at once.
  const flush = () => {
    const ids = pending;
    pending = null;
    if (ids === "all") scan([...doc.nodes()].map((n) => n.id));
    else if (ids) scan(ids);
  };

  pending = "all";
  queueMicrotask(flush);
  return doc.subscribe((change) => {
    const first = pending === null;
    if (change.reset) pending = "all";
    else if (pending !== "all") {
      pending ??= new Set();
      for (const id of change.ids) pending.add(id);
    }
    if (first) queueMicrotask(flush);
  });
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
