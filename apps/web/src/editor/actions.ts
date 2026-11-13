/**
 * Every editor action in one registry. Shortcuts, the command bar and menus
 * all run from here, so each action has one name, one shortcut and one
 * implementation.
 */
import { type Editor, instanceRootOf, isInstanceRoot, type ToolId } from "@drawpane/editor";
import { isMac } from "../app/format";

export interface Shortcut {
  /** `KeyboardEvent.key`, lowercased. */
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface ActionContext {
  readonly editor: Editor;
  readonly openCommandBar: () => void;
  readonly toggleLeftPane: () => void;
  readonly toggleRightPane: () => void;
  readonly copy: () => void;
  readonly cut: () => void;
  readonly paste: () => void;
}

export interface Action {
  readonly id: string;
  readonly label: string;
  readonly group: "Tools" | "Edit" | "Arrange" | "Layer" | "View" | "File";
  readonly icon?: string;
  readonly shortcut?: Shortcut;
  readonly keywords?: string;
  /** Hidden from the command bar and disabled when false. */
  readonly enabled?: (editor: Editor) => boolean;
  readonly run: (ctx: ActionContext) => void;
}

const hasSelection = (e: Editor) => e.s.selection.length > 0;
const canEditSelection = (e: Editor) => e.canEdit && e.s.selection.length > 0;
const canEdit = (e: Editor) => e.canEdit;

function tool(id: ToolId, label: string, key: string, icon: string): Action {
  return {
    id: `tool.${id}`,
    label,
    group: "Tools",
    icon,
    shortcut: { key },
    ...(id === "select" || id === "hand" ? {} : { enabled: canEdit }),
    run: ({ editor }) => editor.setTool(id),
  };
}

export const ACTIONS: readonly Action[] = [
  tool("select", "Move", "v", "pointer"),
  tool("frame", "Frame", "f", "board"),
  tool("rect", "Rectangle", "r", "rectangle"),
  tool("ellipse", "Ellipse", "o", "ellipse"),
  tool("line", "Line", "l", "minus"),
  tool("text", "Text", "t", "text"),
  tool("hand", "Hand", "h", "hand"),

  {
    id: "edit.undo",
    label: "Undo",
    group: "Edit",
    icon: "history",
    shortcut: { key: "z", mod: true },
    enabled: (e) => e.s.canUndo,
    run: ({ editor }) => editor.undo(),
  },
  {
    id: "edit.redo",
    label: "Redo",
    group: "Edit",
    shortcut: { key: "z", mod: true, shift: true },
    enabled: (e) => e.s.canRedo,
    run: ({ editor }) => editor.redo(),
  },
  {
    id: "edit.copy",
    label: "Copy",
    group: "Edit",
    shortcut: { key: "c", mod: true },
    enabled: hasSelection,
    run: ({ copy }) => copy(),
  },
  {
    id: "edit.cut",
    label: "Cut",
    group: "Edit",
    shortcut: { key: "x", mod: true },
    enabled: canEditSelection,
    run: ({ cut }) => cut(),
  },
  {
    id: "edit.paste",
    label: "Paste",
    group: "Edit",
    shortcut: { key: "v", mod: true },
    enabled: canEdit,
    run: ({ paste }) => paste(),
  },
  {
    id: "edit.duplicate",
    label: "Duplicate",
    group: "Edit",
    shortcut: { key: "d", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.duplicate(),
  },
  {
    id: "edit.delete",
    label: "Delete",
    group: "Edit",
    shortcut: { key: "backspace" },
    keywords: "remove",
    enabled: canEditSelection,
    run: ({ editor }) => editor.deleteSelection(),
  },
  {
    id: "edit.selectAll",
    label: "Select all",
    group: "Edit",
    shortcut: { key: "a", mod: true },
    run: ({ editor }) => editor.selectAll(),
  },
  {
    id: "edit.deselect",
    label: "Deselect",
    group: "Edit",
    shortcut: { key: "escape" },
    enabled: hasSelection,
    run: ({ editor }) => editor.select([]),
  },

  {
    id: "layer.group",
    label: "Group selection",
    group: "Layer",
    icon: "group",
    shortcut: { key: "g", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.group(),
  },
  {
    id: "layer.ungroup",
    label: "Ungroup",
    group: "Layer",
    shortcut: { key: "g", mod: true, shift: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.ungroup(),
  },
  {
    id: "layer.frame",
    label: "Frame selection",
    group: "Layer",
    icon: "board",
    shortcut: { key: "g", mod: true, alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.frameSelection(false),
  },
  {
    id: "layer.autoLayout",
    label: "Add auto layout",
    group: "Layer",
    icon: "layout-row",
    shortcut: { key: "a", shift: true },
    keywords: "flex stack",
    enabled: canEditSelection,
    run: ({ editor }) => editor.frameSelection(true),
  },
  {
    id: "layer.hide",
    label: "Show or hide",
    group: "Layer",
    icon: "eye-off",
    shortcut: { key: "h", mod: true, shift: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.toggleVisible(),
  },
  {
    id: "layer.lock",
    label: "Lock or unlock",
    group: "Layer",
    icon: "lock",
    shortcut: { key: "l", mod: true, shift: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.toggleLocked(),
  },

  {
    id: "component.create",
    label: "Create component",
    group: "Layer",
    icon: "component",
    shortcut: { key: "k", mod: true, alt: true },
    keywords: "symbol main",
    enabled: canEditSelection,
    run: ({ editor }) => editor.createComponent(),
  },
  {
    id: "component.detach",
    label: "Detach instance",
    group: "Layer",
    icon: "instance",
    shortcut: { key: "b", mod: true, alt: true },
    enabled: (e) => e.canEdit && e.s.selection.some((id) => isInstanceRoot(e.doc.get(id))),
    run: ({ editor }) => editor.detachInstances(),
  },
  {
    id: "component.reset",
    label: "Reset instance",
    group: "Layer",
    icon: "history",
    keywords: "revert overrides",
    enabled: (e) =>
      e.canEdit && e.s.selection.some((id) => instanceRootOf(e.doc, id) !== undefined),
    run: ({ editor }) => editor.resetInstances(),
  },
  {
    id: "component.main",
    label: "Go to main component",
    group: "Layer",
    icon: "component",
    enabled: (e) =>
      e.s.selection.length === 1 && instanceRootOf(e.doc, e.s.selection[0] as string) !== undefined,
    run: ({ editor }) => editor.goToMainComponent(),
  },
  {
    id: "arrange.forward",
    label: "Bring forward",
    group: "Arrange",
    shortcut: { key: "]", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("forward"),
  },
  {
    id: "arrange.backward",
    label: "Send backward",
    group: "Arrange",
    shortcut: { key: "[", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("backward"),
  },
  {
    id: "arrange.front",
    label: "Bring to front",
    group: "Arrange",
    shortcut: { key: "]" },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("front"),
  },
  {
    id: "arrange.back",
    label: "Send to back",
    group: "Arrange",
    shortcut: { key: "[" },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("back"),
  },
  {
    id: "arrange.alignLeft",
    label: "Align left",
    group: "Arrange",
    shortcut: { key: "a", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("left"),
  },
  {
    id: "arrange.alignCenter",
    label: "Align horizontal centers",
    group: "Arrange",
    shortcut: { key: "h", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("center"),
  },
  {
    id: "arrange.alignRight",
    label: "Align right",
    group: "Arrange",
    shortcut: { key: "d", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("right"),
  },
  {
    id: "arrange.alignTop",
    label: "Align top",
    group: "Arrange",
    shortcut: { key: "w", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("top"),
  },
  {
    id: "arrange.alignMiddle",
    label: "Align vertical centers",
    group: "Arrange",
    shortcut: { key: "v", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("middle"),
  },
  {
    id: "arrange.alignBottom",
    label: "Align bottom",
    group: "Arrange",
    shortcut: { key: "s", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("bottom"),
  },

  {
    id: "view.command",
    label: "Search or set a value",
    group: "View",
    icon: "search",
    shortcut: { key: "k", mod: true },
    run: ({ openCommandBar }) => openCommandBar(),
  },
  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    icon: "plus",
    shortcut: { key: "=", mod: true },
    run: ({ editor }) => editor.zoomBy(1.5),
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    icon: "minus",
    shortcut: { key: "-", mod: true },
    run: ({ editor }) => editor.zoomBy(1 / 1.5),
  },
  {
    id: "view.zoom100",
    label: "Zoom to 100%",
    group: "View",
    shortcut: { key: "0", shift: true },
    run: ({ editor }) => editor.zoomTo(1),
  },
  {
    id: "view.zoomFit",
    label: "Zoom to fit",
    group: "View",
    shortcut: { key: "1", shift: true },
    run: ({ editor }) => editor.zoomToFit(),
  },
  {
    id: "view.zoomSelection",
    label: "Zoom to selection",
    group: "View",
    shortcut: { key: "2", shift: true },
    enabled: hasSelection,
    run: ({ editor }) => editor.zoomToSelection(),
  },
  {
    id: "view.focus",
    label: "Focus mode: hide others' cursors",
    group: "View",
    icon: "eye-off",
    shortcut: { key: "f", shift: true },
    run: ({ editor }) => editor.state.set({ focusMode: !editor.s.focusMode }),
  },
  {
    id: "view.leftPane",
    label: "Show or hide layers",
    group: "View",
    icon: "layers",
    shortcut: { key: "\\", mod: true },
    run: ({ toggleLeftPane }) => toggleLeftPane(),
  },
  {
    id: "view.rightPane",
    label: "Show or hide inspector",
    group: "View",
    icon: "inspector",
    shortcut: { key: "i", mod: true, alt: true },
    run: ({ toggleRightPane }) => toggleRightPane(),
  },
  {
    id: "file.addPage",
    label: "Add page",
    group: "File",
    icon: "plus",
    enabled: canEdit,
    run: ({ editor }) => editor.addPage(),
  },
];

export function matches(shortcut: Shortcut, e: KeyboardEvent): boolean {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  let key = e.key.toLowerCase();
  if (key === "delete") key = "backspace";
  if (key === "+") key = "=";
  // Shift changes some keys (Shift+1 is "!"): fall back to the physical digit.
  if (shortcut.shift && /^digit\d$/i.test(e.code)) key = e.code.slice(5);
  return (
    key === shortcut.key &&
    mod === !!shortcut.mod &&
    e.shiftKey === !!shortcut.shift &&
    e.altKey === !!shortcut.alt
  );
}

export function formatShortcut(s: Shortcut): string {
  const mac = isMac();
  const keyLabel: Record<string, string> = { backspace: "⌫", escape: "Esc", "=": "+", "\\": "\\" };
  const key = keyLabel[s.key] ?? s.key.toUpperCase();
  if (mac) return `${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.mod ? "⌘" : ""}${key}`;
  return [s.mod ? "Ctrl" : "", s.alt ? "Alt" : "", s.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}
