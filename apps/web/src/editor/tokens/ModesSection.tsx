import { listCollections } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { PropertySection } from "@drawpane/ui";
import { useEditor } from "../hooks";

/**
 * Which mode of each collection applies inside a frame or page. Children
 * inherit; "Inherit" follows the nearest parent that sets one.
 */
export function ModesSection({ node }: { node: NodeRecord }) {
  const editor = useEditor();
  const collections = listCollections(editor.doc).filter(
    (c) => getProp(c.props, "modes").length > 1,
  );
  if (collections.length === 0) return null;
  const set = getProp(node.props, "variableModes");
  return (
    <PropertySection title="Modes">
      {collections.map((collection) => (
        <label key={collection.id} className="mode-row">
          <span className="mode-row__name">
            {getProp(collection.props, "name") || "Collection"}
          </span>
          <select
            className="inspector__select"
            value={set[collection.id] ?? ""}
            onChange={(e) => editor.setVariableMode(node.id, collection.id, e.target.value || null)}
          >
            <option value="">{node.type === "page" ? "Default" : "Inherit"}</option>
            {getProp(collection.props, "modes").map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </PropertySection>
  );
}
