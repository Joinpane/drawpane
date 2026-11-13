import type { Editor } from "@drawpane/editor";
import { getProp, restoreOps } from "@drawpane/model";

export type LayerRestore =
  | { readonly kind: "restored"; readonly ids: readonly string[] }
  /** The layers already match the version. */
  | { readonly kind: "unchanged"; readonly ids: readonly string[] }
  /** Nothing restorable: pages, or nowhere left to put them. */
  | { readonly kind: "nothing" }
  | { readonly kind: "failed" };

/**
 * Puts layers back as they are in `preview` (a saved version), leaving the
 * rest of the live file alone. It's an ordinary edit you can undo, and it
 * runs the editor's usual follow-up work (instances, auto layout, text size).
 */
export function restoreLayers(live: Editor, preview: Editor, ids: readonly string[]): LayerRestore {
  const plan = restoreOps(live.doc, preview.doc.nodes(), {
    roots: ids,
    ...(live.s.pageId ? { fallbackParent: live.s.pageId } : {}),
  });
  if (plan.restored.length === 0) return { kind: "nothing" };
  if (plan.ops.length === 0) return { kind: "unchanged", ids: plan.restored };
  const label = plan.restored.length === 1 ? "Restore layer" : "Restore layers";
  return live.commit(plan.ops, label)
    ? { kind: "restored", ids: plan.restored }
    : { kind: "failed" };
}

/** "“Card”" or "3 layers", for messages. */
export function layersLabel(editor: Editor, ids: readonly string[]): string {
  if (ids.length !== 1) return `${ids.length} layers`;
  const node = editor.doc.get(ids[0] as string);
  return `“${node ? getProp(node.props, "name") || node.type : "Untitled"}”`;
}
