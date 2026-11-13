import { getProp, type NodeRecord } from "@drawpane/model";
import { type IconName, NumberField, SelectionLens } from "@drawpane/ui";
import { useDocVersion, useEditor, useEditorState } from "./hooks";

const KIND: Record<string, { label: string; icon: IconName }> = {
  frame: { label: "Frame", icon: "board" },
  group: { label: "Group", icon: "group" },
  rect: { label: "Rectangle", icon: "rectangle" },
  ellipse: { label: "Ellipse", icon: "ellipse" },
  line: { label: "Line", icon: "minus" },
  path: { label: "Vector", icon: "pen" },
  text: { label: "Text", icon: "text" },
};

/**
 * The Selection Lens: a compact strip anchored under the selection with the
 * four or five controls that matter for that layer type, so your eyes stay on
 * the work. The full inspector is one keypress away.
 */
export function Lens({ onOpenInspector }: { onOpenInspector: () => void }) {
  const editor = useEditor();
  useDocVersion();
  const selection = useEditorState((s) => s.selection);
  const camera = useEditorState((s) => s.camera);
  const viewport = useEditorState((s) => s.viewport);
  const gesture = useEditorState((s) => s.gesture);
  const editing = useEditorState((s) => s.editingText);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  if (selection.length !== 1 || gesture || editing || !canEdit) return null;
  const node = editor.doc.get(selection[0] as string);
  const bounds = node ? editor.scene.bounds(node.id) : null;
  if (!node || !bounds || node.type === "group") return null;

  const bottom = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
  const top = camera.toScreen({ x: bounds.x, y: bounds.y });
  // Below the selection (clear of the size pill); flip above when it would leave the screen.
  const below = bottom.y + 40 + 44 < viewport.height;
  const y = below ? bottom.y + 36 : top.y - 52;
  if (y < 0 || bottom.x < 0 || bottom.x > viewport.width) return null;

  const kind = KIND[node.type] ?? { label: "Layer", icon: "rectangle" as IconName };
  const label = node.type === "frame" && getProp(node.props, "layoutMode") !== "none" ? `${kind.label} · Auto layout` : kind.label;

  const set = (prop: Parameters<typeof editor.setProp>[1], value: unknown) => editor.setProp([node.id], prop, value, "Edit in lens");
  const num = (n: NodeRecord, prop: "width" | "height" | "gap" | "cornerRadius" | "fontSize" | "paddingLeft", text: string, aria: string) => (
    <NumberField
      key={prop}
      label={text}
      ariaLabel={aria}
      value={Math.round((getProp(n.props, prop) as number) * 100) / 100}
      onChange={(v) => set(prop, v)}
      onScrubStart={() => editor.beginGesture(aria)}
      onScrubEnd={() => editor.endGesture()}
    />
  );

  const controls =
    node.type === "text"
      ? [num(node, "fontSize", "Aa", "Font size"), num(node, "width", "W", "Width")]
      : node.type === "frame" && getProp(node.props, "layoutMode") !== "none"
        ? [num(node, "width", "W", "Width"), num(node, "height", "H", "Height"), num(node, "gap", "↔", "Gap"), num(node, "paddingLeft", "▢", "Padding")]
        : [num(node, "width", "W", "Width"), num(node, "height", "H", "Height"), ...(node.type === "frame" || node.type === "rect" ? [num(node, "cornerRadius", "◜", "Corner radius")] : [])];

  return (
    <div className="lens-anchor" style={{ left: bottom.x, top: y }}>
      <SelectionLens kind={label} kindIcon={kind.icon} onOpenInspector={onOpenInspector} inspectorShortcut="⌥⌘I">
        {controls}
      </SelectionLens>
    </div>
  );
}
