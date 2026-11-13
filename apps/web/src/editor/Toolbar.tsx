import type { ToolId } from "@drawpane/editor";
import { IconButton, type IconName, Kbd } from "@drawpane/ui";
import { ACTIONS, formatShortcut } from "./actions";
import { useEditor, useEditorState } from "./hooks";

const TOOLS: ReadonlyArray<{ id: ToolId; icon: IconName; label: string }> = [
  { id: "select", icon: "pointer", label: "Move" },
  { id: "frame", icon: "board", label: "Frame" },
  { id: "rect", icon: "rectangle", label: "Rectangle" },
  { id: "ellipse", icon: "ellipse", label: "Ellipse" },
  { id: "line", icon: "minus", label: "Line" },
  { id: "text", icon: "text", label: "Text" },
  { id: "hand", icon: "hand", label: "Hand" },
];

/** The floating command strip: tools, then the search-or-set field that opens the command bar. */
export function Toolbar({ onSearch }: { onSearch: () => void }) {
  const editor = useEditor();
  const tool = useEditorState((s) => s.tool);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const shortcutOf = (id: string) => {
    const s = ACTIONS.find((a) => a.id === id)?.shortcut;
    return s ? formatShortcut(s) : undefined;
  };
  return (
    <div className="toolbar pane" role="toolbar" aria-label="Tools">
      {TOOLS.filter((t) => canEdit || t.id === "select" || t.id === "hand").map((t) => {
        const shortcut = shortcutOf(`tool.${t.id}`);
        return (
          <IconButton
            key={t.id}
            icon={t.icon}
            label={t.label}
            size="md"
            pressed={tool === t.id}
            {...(shortcut ? { shortcut } : {})}
            onClick={() => editor.setTool(t.id)}
          />
        );
      })}
      <span className="toolbar__sep" aria-hidden="true" />
      <button type="button" className="toolbar__search" onClick={onSearch}>
        <span>Search or set…</span>
        <Kbd keys={formatShortcut({ key: "k", mod: true }).match(/Ctrl|⌘|K|\+/g)?.filter((k) => k !== "+") ?? ["⌘", "K"]} />
      </button>
    </div>
  );
}
