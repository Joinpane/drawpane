/**
 * Text layers as the inspector and the Lens show their typography and fill:
 * one view of the layer per distinct look among the characters an edit would
 * change. That's the selected characters while editing, the whole layer
 * otherwise. So a layer with a bold word reads "Mixed" for its weight, just
 * as several layers with different weights do, and the fields need nothing
 * special: they read views with `common()` and write to the layer's id,
 * which the editor applies to the selected characters while editing.
 */
import { type Editor, hasRuns, rangeProps } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";

export function textViews(editor: Editor, nodes: readonly NodeRecord[]): NodeRecord[] {
  const { editingText, textSelection } = editor.s;
  return nodes.flatMap((node) => {
    if (node.type !== "text") return [node];
    const selected =
      node.id === editingText && textSelection && textSelection.start !== textSelection.end;
    if (!selected && !hasRuns(node)) return [node];
    const range = selected
      ? textSelection
      : { start: 0, end: getProp(node.props, "characters").length };
    return rangeProps(node, range.start, range.end).map((props) =>
      props === node.props ? node : { ...node, props },
    );
  });
}
