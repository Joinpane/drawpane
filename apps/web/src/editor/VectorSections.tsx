import { BOOLEAN_LABELS, BOOLEAN_OPS, type Editor } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";
import { Button, PropertySection } from "@drawpane/ui";
import { shortcutFor } from "./actions";
import "./vector.css";

/** "Combine shapes": union, subtract, intersect and exclude, for two or more shapes. */
export function CombineSection({ editor }: { editor: Editor }) {
  if (!editor.canBoolean()) return null;
  return (
    <PropertySection title="Combine shapes">
      <fieldset className="dp-seg vector-combine" aria-label="Combine shapes">
        {BOOLEAN_OPS.map((op) => {
          const shortcut = shortcutFor(`vector.${op}`);
          return (
            <button
              key={op}
              type="button"
              className="dp-seg__option"
              title={shortcut ? `${BOOLEAN_LABELS[op]} (${shortcut})` : BOOLEAN_LABELS[op]}
              onClick={() => void editor.booleanOp(op)}
            >
              {BOOLEAN_LABELS[op]}
            </button>
          );
        })}
      </fieldset>
      <p className="inspector__label">The result is one path with the bottom layer's look.</p>
    </PropertySection>
  );
}

/** "Path": edit a path's points, or flatten shapes into paths. */
export function PathSection({ editor, nodes }: { editor: Editor; nodes: readonly NodeRecord[] }) {
  const single = nodes.length === 1 ? nodes[0] : undefined;
  const flattenable = nodes.some(
    (n) =>
      n.type === "rect" ||
      n.type === "ellipse" ||
      n.type === "polygon" ||
      n.type === "star" ||
      n.type === "line" ||
      (n.type === "frame" && editor.doc.childIds(n.id).length === 0),
  );
  if (single?.type !== "path" && !flattenable) return null;
  const flattenKey = shortcutFor("vector.flatten");
  return (
    <PropertySection title="Path">
      <div className="vector-path-actions">
        {single?.type === "path" ? (
          <Button size="sm" onClick={() => editor.enterVectorEdit(single.id)}>
            Edit path
          </Button>
        ) : null}
        {flattenable ? (
          <Button
            size="sm"
            onClick={() => editor.flatten()}
            {...(flattenKey ? { shortcut: flattenKey } : {})}
          >
            Flatten
          </Button>
        ) : null}
      </div>
    </PropertySection>
  );
}
