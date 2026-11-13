/**
 * What vector exports need besides the layers: the images their fills use,
 * as data: URLs so an exported SVG or PDF stands on its own, and the order
 * frames become pages in.
 */
import { type Editor, mediaUrl, type Rect, type SvgImageSource } from "@drawpane/editor";
import { getProp } from "@drawpane/model";

/** Every image a set of layers and their contents fill with, by content hash. */
export function imageRefs(editor: Editor, ids: readonly string[]): Set<string> {
  const refs = new Set<string>();
  const visit = (id: string) => {
    const node = editor.doc.get(id);
    if (!node || getProp(node.props, "visible") === false) return;
    for (const paint of getProp(node.props, "fills"))
      if (paint.type === "image" && paint.visible !== false) refs.add(paint.ref);
    for (const child of editor.doc.childIds(id)) visit(child);
  };
  for (const id of ids) visit(id);
  return refs;
}

/** Reads the images as data: URLs with their natural sizes. Images that fail to load are left out. */
export async function embeddedImages(
  editor: Editor,
  ids: readonly string[],
): Promise<(ref: string) => SvgImageSource | null> {
  const loaded = new Map<string, SvgImageSource>();
  await Promise.all(
    [...imageRefs(editor, ids)].map(async (ref) => {
      try {
        const response = await fetch(mediaUrl(ref), { credentials: "same-origin" });
        if (!response.ok) return;
        const blob = await response.blob();
        const [href, bitmap] = await Promise.all([dataUrl(blob), createImageBitmap(blob)]);
        loaded.set(ref, { href, width: bitmap.width, height: bitmap.height });
        bitmap.close();
      } catch {
        // A missing image leaves its fill out; the rest still exports.
      }
    }),
  );
  return (ref) => loaded.get(ref) ?? null;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Frames in reading order, the way a deck reads: rows top to bottom (a frame
 * joins a row when its middle is above the row's bottom), each left to right.
 */
export function readingOrder<T extends { bounds: Rect }>(items: readonly T[]): T[] {
  const rows: { bottom: number; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => a.bounds.y - b.bounds.y)) {
    const b = item.bounds;
    const row = rows.at(-1);
    if (row && b.y + b.height / 2 < row.bottom) {
      row.items.push(item);
      row.bottom = Math.max(row.bottom, b.y + b.height);
    } else rows.push({ bottom: b.y + b.height, items: [item] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.bounds.x - b.bounds.x));
}
