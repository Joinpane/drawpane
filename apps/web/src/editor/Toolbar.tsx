import type { ToolId } from "@drawpane/editor";
import { ContextMenu, Icon, IconButton, type IconName, Kbd, Tooltip } from "@drawpane/ui";
import { useRef, useState } from "react";
import { ACTIONS, type ActionContext, formatShortcut } from "./actions";
import { useEditor, useEditorState } from "./hooks";

interface Tool {
  readonly id: ToolId;
  readonly icon: IconName;
  readonly label: string;
}

const BEFORE: readonly Tool[] = [
  { id: "select", icon: "pointer", label: "Move" },
  { id: "frame", icon: "board", label: "Frame" },
];

/** Shape tools share one button that shows the last one used, with the rest in its menu. */
const SHAPES: readonly Tool[] = [
  { id: "rect", icon: "rectangle", label: "Rectangle" },
  { id: "ellipse", icon: "ellipse", label: "Ellipse" },
  { id: "line", icon: "minus", label: "Line" },
  { id: "arrow", icon: "arrow", label: "Arrow" },
  { id: "polygon", icon: "polygon", label: "Polygon" },
  { id: "star", icon: "star", label: "Star" },
];

const AFTER: readonly Tool[] = [
  { id: "pen", icon: "pen", label: "Pen" },
  { id: "text", icon: "text", label: "Text" },
  { id: "comment", icon: "comment", label: "Comment" },
  { id: "hand", icon: "hand", label: "Hand" },
];

/** Tools that don't change the file, so viewers get them too. */
const VIEWER_TOOLS: ReadonlySet<ToolId> = new Set(["select", "comment", "hand"]);

const shortcutOf = (id: string) => {
  const s = ACTIONS.find((a) => a.id === id)?.shortcut;
  return s ? formatShortcut(s) : undefined;
};

/** The floating command strip: tools, then the search-or-set field that opens the command bar. */
export function Toolbar({ onSearch, ctx }: { onSearch: () => void; ctx: ActionContext }) {
  const editor = useEditor();
  const tool = useEditorState((s) => s.tool);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const button = (t: Tool) => {
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
  };
  return (
    <div className="toolbar pane" role="toolbar" aria-label="Tools">
      {BEFORE.filter((t) => canEdit || VIEWER_TOOLS.has(t.id)).map(button)}
      {canEdit ? <ShapeTools tool={tool} ctx={ctx} /> : null}
      {AFTER.filter((t) => canEdit || VIEWER_TOOLS.has(t.id)).map(button)}
      <span className="toolbar__sep" aria-hidden="true" />
      <button type="button" className="toolbar__search" onClick={onSearch}>
        <span>Search or set…</span>
        <Kbd
          keys={
            formatShortcut({ key: "k", mod: true })
              .match(/Ctrl|⌘|K|\+/g)
              ?.filter((k) => k !== "+") ?? ["⌘", "K"]
          }
        />
      </button>
    </div>
  );
}

/** The shape button (the last shape used) and the menu of every shape, plus placing an image. */
function ShapeTools({ tool, ctx }: { tool: ToolId; ctx: ActionContext }) {
  const editor = useEditor();
  const [last, setLast] = useState<Tool>(SHAPES[0] as Tool);
  const active = SHAPES.find((s) => s.id === tool);
  // A shape picked any way (menu, key, command bar) becomes the button's shape.
  if (active && active.id !== last.id) setLast(active);
  const shown = active ?? last;
  const chevron = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shortcut = shortcutOf(`tool.${shown.id}`);
  const placeImage = ACTIONS.find((a) => a.id === "tool.image");
  return (
    <span className="toolbar__group">
      <IconButton
        icon={shown.icon}
        label={shown.label}
        size="md"
        pressed={active !== undefined}
        {...(shortcut ? { shortcut } : {})}
        onClick={() => editor.setTool(shown.id)}
      />
      <Tooltip label="More shapes" describe={false}>
        <button
          ref={chevron}
          type="button"
          className="toolbar__more"
          aria-label="More shapes"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() => {
            const r = chevron.current?.getBoundingClientRect();
            if (r) setMenu({ x: r.left - 28, y: r.bottom + 10 });
          }}
        >
          <Icon name="chevron-down" size={12} />
        </button>
      </Tooltip>
      {menu ? (
        <ContextMenu
          at={menu}
          label="Shapes"
          onClose={() => setMenu(null)}
          items={[
            ...SHAPES.map((s) => ({
              id: s.id,
              label: s.label,
              icon: s.icon,
              ...(shortcutOf(`tool.${s.id}`)
                ? { shortcut: shortcutOf(`tool.${s.id}`) as string }
                : {}),
              onSelect: () => editor.setTool(s.id),
            })),
            { separator: true as const, id: "sep" },
            {
              id: "image",
              label: "Place image…",
              icon: "image" as IconName,
              ...(placeImage?.shortcut ? { shortcut: formatShortcut(placeImage.shortcut) } : {}),
              onSelect: () => ctx.placeImage(),
            },
          ]}
        />
      ) : null}
    </span>
  );
}
