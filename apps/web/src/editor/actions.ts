/**
 * Every editor action in one registry. Shortcuts, the command bar and menus
 * all run from here, so each action has one name, one shortcut and one
 * implementation.
 */
import {
  BOOLEAN_LABELS,
  BOOLEAN_OPS,
  type BooleanOp,
  croppableImage,
  type Editor,
  instanceRootOf,
  isInstanceRoot,
  isMainComponent,
  sizeMode,
  type ToolId,
} from "@drawpane/editor";
import type { IconName } from "@drawpane/ui";
import { isMac } from "../app/format";
import { copySelectionAs, exportPageAsPdf, exportSelection } from "./exporting";
import { openTextStyles } from "./inspector/TextStyles";
import { getOverrides } from "./shortcuts-store";
import { toggleXray, uiFor } from "./ui-state";

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
  readonly toggleTokens: () => void;
  readonly toggleLeftPane: () => void;
  readonly toggleRightPane: () => void;
  readonly copy: () => void;
  readonly cut: () => void;
  readonly paste: () => void;
  readonly toggleComments: () => void;
  /** Plays the prototype from the selected screen (or the page's first flow). */
  readonly present: () => void;
  /** Opens the right pane on Design, Prototype or Inspect. */
  readonly showTab: (tab: "design" | "prototype" | "inspect") => void;
  /** Opens the History tab. */
  readonly showHistory: () => void;
  /** Asks for a name and saves the file as it is now as a version. */
  readonly saveVersion: () => void;
  /** Starts renaming the selected layer in the layers panel. */
  readonly rename: () => void;
  /** Opens the keyboard shortcuts sheet. */
  readonly showShortcuts: () => void;
  /** Opens the layers search and focuses it. */
  readonly findLayers: () => void;
  /** Asks for image files and places them in view. */
  readonly placeImage: () => void;
}

export interface Action {
  readonly id: string;
  readonly label: string;
  readonly group: "Tools" | "Edit" | "Arrange" | "Layer" | "View" | "File" | "Help";
  readonly icon?: IconName;
  /**
   * The shortcut it comes with. People can change it (Keyboard shortcuts in
   * settings), so read it through `shortcutOf`, never directly.
   */
  readonly defaultShortcut?: Shortcut;
  /** Other keys that do the same by default (bare + and − zoom too); menus show the main one. */
  readonly also?: readonly Shortcut[];
  readonly keywords?: string;
  /** Hidden from the command bar and disabled when false. */
  readonly enabled?: (editor: Editor) => boolean;
  readonly run: (ctx: ActionContext) => void;
}

const hasSelection = (e: Editor) => e.s.selection.length > 0;
/** Boolean shortcuts: ⌥⇧ plus the operation's initial (X for exclude), like Figma. */
const BOOLEAN_KEYS: Record<BooleanOp, string> = {
  union: "u",
  subtract: "s",
  intersect: "i",
  exclude: "x",
};
const canEditSelection = (e: Editor) => e.canEdit && e.s.selection.length > 0;
const canEdit = (e: Editor) => e.canEdit;

function tool(id: ToolId, label: string, key: string, icon: IconName): Action {
  return {
    id: `tool.${id}`,
    label,
    group: "Tools",
    icon,
    defaultShortcut: { key },
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
  {
    id: "tool.arrow",
    label: "Arrow",
    group: "Tools",
    icon: "arrow",
    defaultShortcut: { key: "l", shift: true },
    keywords: "line arrowhead connector",
    enabled: canEdit,
    run: ({ editor }) => editor.setTool("arrow"),
  },
  {
    id: "tool.polygon",
    label: "Polygon",
    group: "Tools",
    icon: "polygon",
    keywords: "triangle hexagon shape sides",
    enabled: canEdit,
    run: ({ editor }) => editor.setTool("polygon"),
  },
  {
    id: "tool.star",
    label: "Star",
    group: "Tools",
    icon: "star",
    keywords: "shape points rating",
    enabled: canEdit,
    run: ({ editor }) => editor.setTool("star"),
  },
  {
    id: "tool.image",
    label: "Place image…",
    group: "Tools",
    icon: "image",
    defaultShortcut: { key: "k", mod: true, shift: true },
    keywords: "photo picture upload insert",
    enabled: canEdit,
    run: ({ placeImage }) => placeImage(),
  },
  tool("pen", "Pen", "p", "pen"),
  tool("text", "Text", "t", "text"),
  tool("hand", "Hand", "h", "hand"),
  {
    // Not edit-gated: viewers can comment. Commenting is collaboration, not editing.
    id: "tool.comment",
    label: "Comment",
    group: "Tools",
    icon: "comment",
    defaultShortcut: { key: "c" },
    keywords: "feedback note pin",
    run: ({ editor }) => editor.setTool("comment"),
  },

  {
    id: "edit.undo",
    label: "Undo",
    group: "Edit",
    icon: "history",
    defaultShortcut: { key: "z", mod: true },
    enabled: (e) => e.s.canUndo,
    run: ({ editor }) => editor.undo(),
  },
  {
    id: "edit.redo",
    label: "Redo",
    group: "Edit",
    defaultShortcut: { key: "z", mod: true, shift: true },
    enabled: (e) => e.s.canRedo,
    run: ({ editor }) => editor.redo(),
  },
  {
    id: "edit.copy",
    label: "Copy",
    group: "Edit",
    icon: "copy",
    defaultShortcut: { key: "c", mod: true },
    enabled: hasSelection,
    run: ({ copy }) => copy(),
  },
  {
    id: "edit.cut",
    label: "Cut",
    group: "Edit",
    icon: "cut",
    defaultShortcut: { key: "x", mod: true },
    enabled: canEditSelection,
    run: ({ cut }) => cut(),
  },
  {
    id: "edit.paste",
    label: "Paste",
    group: "Edit",
    icon: "paste",
    defaultShortcut: { key: "v", mod: true },
    enabled: canEdit,
    run: ({ paste }) => paste(),
  },
  {
    id: "edit.duplicate",
    label: "Duplicate",
    group: "Edit",
    icon: "duplicate",
    defaultShortcut: { key: "d", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.duplicate(),
  },
  {
    id: "edit.delete",
    label: "Delete",
    group: "Edit",
    icon: "trash",
    defaultShortcut: { key: "backspace" },
    keywords: "remove",
    enabled: canEditSelection,
    run: ({ editor }) => editor.deleteSelection(),
  },
  {
    id: "edit.copyAsPng",
    label: "Copy as PNG",
    group: "Edit",
    icon: "image",
    defaultShortcut: { key: "c", mod: true, shift: true },
    keywords: "image clipboard screenshot",
    enabled: hasSelection,
    run: ({ editor }) => void copySelectionAs(editor, "png"),
  },
  {
    id: "edit.copyAsSvg",
    label: "Copy as SVG",
    group: "Edit",
    icon: "code",
    keywords: "vector markup clipboard",
    enabled: hasSelection,
    run: ({ editor }) => void copySelectionAs(editor, "svg"),
  },
  {
    id: "edit.copyAsCss",
    label: "Copy as CSS",
    group: "Edit",
    icon: "code",
    keywords: "code style clipboard",
    enabled: hasSelection,
    run: ({ editor }) => void copySelectionAs(editor, "css"),
  },
  {
    id: "edit.copyProperties",
    label: "Copy properties",
    group: "Edit",
    icon: "eyedropper",
    defaultShortcut: { key: "c", mod: true, alt: true },
    keywords: "style fill stroke effects",
    enabled: (e) => e.s.selection.length === 1,
    run: ({ editor }) => {
      if (editor.copyProperties())
        editor.notify(`Copied properties. Paste them with ${shortcutFor("edit.pasteProperties")}.`);
    },
  },
  {
    id: "edit.pasteProperties",
    label: "Paste properties",
    group: "Edit",
    icon: "paste",
    defaultShortcut: { key: "v", mod: true, alt: true },
    keywords: "style fill stroke effects apply",
    enabled: (e) => e.canEdit && e.s.selection.length > 0 && e.hasCopiedProperties,
    run: ({ editor }) => void editor.pasteProperties(),
  },
  {
    id: "edit.selectAll",
    label: "Select all",
    group: "Edit",
    icon: "select-all",
    defaultShortcut: { key: "a", mod: true },
    run: ({ editor }) => editor.selectAll(),
  },
  {
    id: "edit.deselect",
    label: "Deselect",
    group: "Edit",
    defaultShortcut: { key: "escape" },
    enabled: (e) => hasSelection(e) || e.s.editingText !== null,
    run: ({ editor }) => {
      // Editing text: Escape finishes the edit and keeps the layer selected, like Figma.
      const editing = editor.s.editingText;
      if (editing) {
        editor.endTextEdit();
        if (editor.doc.has(editing)) editor.select([editing]);
        return;
      }
      editor.select([]);
    },
  },

  {
    id: "layer.group",
    label: "Group selection",
    group: "Layer",
    icon: "group",
    defaultShortcut: { key: "g", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.group(),
  },
  {
    id: "layer.crop",
    label: "Crop image",
    group: "Layer",
    icon: "image",
    keywords: "trim cut photo picture",
    enabled: (e) =>
      e.canEdit &&
      e.s.selection.length === 1 &&
      croppableImage(e.doc.get(e.s.selection[0] as string)) !== null,
    run: ({ editor }) => {
      const id = editor.s.selection[0];
      if (id) editor.enterCrop(id);
    },
  },
  {
    id: "layer.mask",
    label: "Use as mask",
    group: "Layer",
    icon: "ellipse",
    defaultShortcut: { key: "m", mod: true, alt: true },
    keywords: "clip crop shape avatar",
    enabled: canEditSelection,
    run: ({ editor }) => editor.toggleMask(),
  },
  {
    id: "layer.ungroup",
    label: "Ungroup",
    group: "Layer",
    icon: "ungroup",
    defaultShortcut: { key: "g", mod: true, shift: true },
    // Groups, and frames with something inside (ungrouping a frame removes it).
    enabled: (e) =>
      e.canEdit &&
      e.s.selection.some((id) => {
        const n = e.doc.get(id);
        return n?.type === "group" || (n?.type === "frame" && e.doc.childIds(id).length > 0);
      }),
    run: ({ editor }) => editor.ungroup(),
  },
  {
    id: "layer.frame",
    label: "Frame selection",
    group: "Layer",
    icon: "board",
    defaultShortcut: { key: "g", mod: true, alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.frameSelection(false),
  },
  {
    id: "layer.autoLayout",
    label: "Add auto layout",
    group: "Layer",
    icon: "layout-row",
    defaultShortcut: { key: "a", shift: true },
    keywords: "flex stack",
    enabled: canEditSelection,
    run: ({ editor }) => editor.frameSelection(true),
  },
  {
    id: "layer.gridLayout",
    label: "Add grid layout",
    group: "Layer",
    icon: "layout-grid",
    defaultShortcut: { key: "a", shift: true, alt: true },
    keywords: "css grid columns rows tracks",
    enabled: canEditSelection,
    run: ({ editor }) => editor.addGridLayout(),
  },
  {
    id: "text.bold",
    label: "Bold",
    group: "Layer",
    icon: "text",
    defaultShortcut: { key: "b", mod: true },
    keywords: "weight strong text",
    enabled: hasText,
    run: ({ editor }) => editor.toggleTextStyle("bold"),
  },
  {
    id: "text.italic",
    label: "Italic",
    group: "Layer",
    icon: "italic",
    defaultShortcut: { key: "i", mod: true },
    keywords: "slant oblique text",
    enabled: hasText,
    run: ({ editor }) => editor.toggleTextStyle("italic"),
  },
  {
    id: "text.underline",
    label: "Underline",
    group: "Layer",
    icon: "text",
    defaultShortcut: { key: "u", mod: true },
    keywords: "decoration text",
    enabled: hasText,
    run: ({ editor }) => editor.toggleTextStyle("underline"),
  },
  {
    id: "text.styles",
    label: "Text styles",
    group: "Layer",
    icon: "text",
    defaultShortcut: { key: "t", mod: true, alt: true },
    keywords: "typography heading body type scale",
    enabled: hasText,
    run: ({ editor }) => openTextStyles(editor),
  },
  {
    id: "layer.find",
    label: "Find layers",
    group: "Layer",
    icon: "search",
    defaultShortcut: { key: "f", mod: true },
    keywords: "search filter layers panel",
    run: ({ findLayers }) => findLayers(),
  },
  {
    id: "layer.collapseAll",
    label: "Collapse all layers",
    group: "Layer",
    icon: "collapse-all",
    defaultShortcut: { key: "l", alt: true },
    keywords: "fold close tree",
    run: ({ editor }) => {
      const ui = uiFor(editor);
      ui.set({ collapseLayers: ui.get().collapseLayers + 1 });
    },
  },
  {
    id: "layer.rename",
    label: "Rename",
    group: "Layer",
    icon: "rename",
    defaultShortcut: { key: "r", mod: true },
    keywords: "name label",
    enabled: (e) => e.canEdit && e.s.selection.length === 1,
    run: ({ rename }) => rename(),
  },
  {
    id: "layer.hide",
    label: "Show or hide",
    group: "Layer",
    icon: "eye-off",
    defaultShortcut: { key: "h", mod: true, shift: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.toggleVisible(),
  },
  {
    id: "layer.lock",
    label: "Lock or unlock",
    group: "Layer",
    icon: "lock",
    defaultShortcut: { key: "l", mod: true, shift: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.toggleLocked(),
  },

  {
    id: "component.create",
    label: "Create component",
    group: "Layer",
    icon: "component",
    defaultShortcut: { key: "k", mod: true, alt: true },
    keywords: "symbol main",
    // Not on something that's already a main component.
    enabled: (e) =>
      canEditSelection(e) &&
      !(e.s.selection.length === 1 && isMainComponent(e.doc.get(e.s.selection[0] as string))),
    run: ({ editor }) => editor.createComponent(),
  },
  {
    id: "component.combine",
    label: "Combine as variants",
    group: "Layer",
    icon: "component",
    keywords: "component set states",
    enabled: (e) =>
      e.canEdit &&
      e.s.selection.length > 0 &&
      e.s.selection.every((id) => isMainComponent(e.doc.get(id))),
    run: ({ editor }) => editor.combineAsVariants(),
  },
  {
    id: "component.detach",
    label: "Detach instance",
    group: "Layer",
    icon: "instance",
    defaultShortcut: { key: "b", mod: true, alt: true },
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
    id: "vector.edit",
    label: "Edit path",
    group: "Layer",
    icon: "pen",
    defaultShortcut: { key: "enter" },
    keywords: "vector points anchors",
    enabled: (e) =>
      e.canEdit &&
      e.s.selection.length === 1 &&
      e.doc.get(e.s.selection[0] as string)?.type === "path",
    run: ({ editor }) => {
      const id = editor.s.selection[0];
      if (id) editor.enterVectorEdit(id);
    },
  },
  {
    id: "vector.flatten",
    label: "Flatten",
    group: "Layer",
    icon: "pen",
    defaultShortcut: { key: "e", mod: true },
    keywords: "outline convert vector path",
    enabled: canEditSelection,
    run: ({ editor }) => editor.flatten(),
  },
  ...BOOLEAN_OPS.map(
    (op): Action => ({
      id: `vector.${op}`,
      label: `${BOOLEAN_LABELS[op]} selection`,
      group: "Layer",
      icon: op,
      defaultShortcut: { key: BOOLEAN_KEYS[op], alt: true, shift: true },
      keywords: "boolean combine shapes",
      enabled: (e) => e.canBoolean(),
      run: ({ editor }) => void editor.booleanOp(op),
    }),
  ),

  {
    id: "arrange.forward",
    label: "Bring forward",
    group: "Arrange",
    icon: "arrow-up",
    defaultShortcut: { key: "]", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("forward"),
  },
  {
    id: "arrange.backward",
    label: "Send backward",
    group: "Arrange",
    icon: "arrow-down",
    defaultShortcut: { key: "[", mod: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("backward"),
  },
  {
    id: "arrange.front",
    label: "Bring to front",
    group: "Arrange",
    icon: "bring-front",
    defaultShortcut: { key: "]" },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("front"),
  },
  {
    id: "arrange.back",
    label: "Send to back",
    group: "Arrange",
    icon: "send-back",
    defaultShortcut: { key: "[" },
    enabled: canEditSelection,
    run: ({ editor }) => editor.reorder("back"),
  },
  {
    id: "arrange.alignLeft",
    label: "Align left",
    group: "Arrange",
    icon: "align-left",
    defaultShortcut: { key: "a", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("left"),
  },
  {
    id: "arrange.alignCenter",
    label: "Align horizontal centers",
    group: "Arrange",
    icon: "align-center",
    defaultShortcut: { key: "h", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("center"),
  },
  {
    id: "arrange.alignRight",
    label: "Align right",
    group: "Arrange",
    icon: "align-right",
    defaultShortcut: { key: "d", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("right"),
  },
  {
    id: "arrange.alignTop",
    label: "Align top",
    group: "Arrange",
    icon: "align-top",
    defaultShortcut: { key: "w", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("top"),
  },
  {
    id: "arrange.alignMiddle",
    label: "Align vertical centers",
    group: "Arrange",
    icon: "align-middle",
    defaultShortcut: { key: "v", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("middle"),
  },
  {
    id: "arrange.alignBottom",
    label: "Align bottom",
    group: "Arrange",
    icon: "align-bottom",
    defaultShortcut: { key: "s", alt: true },
    enabled: canEditSelection,
    run: ({ editor }) => editor.align("bottom"),
  },

  {
    id: "arrange.distributeHorizontal",
    label: "Distribute horizontal spacing",
    group: "Arrange",
    icon: "distribute-horizontal",
    defaultShortcut: { key: "h", alt: true, shift: true },
    keywords: "space evenly spread",
    enabled: (e) => e.canEdit && e.s.selection.length > 2,
    run: ({ editor }) => editor.distribute("horizontal"),
  },
  {
    id: "arrange.distributeVertical",
    label: "Distribute vertical spacing",
    group: "Arrange",
    icon: "distribute-vertical",
    defaultShortcut: { key: "v", alt: true, shift: true },
    keywords: "space evenly spread",
    enabled: (e) => e.canEdit && e.s.selection.length > 2,
    run: ({ editor }) => editor.distribute("vertical"),
  },
  {
    id: "arrange.tidyUp",
    label: "Tidy up",
    group: "Arrange",
    icon: "tidy",
    defaultShortcut: { key: "t", alt: true, shift: true },
    keywords: "grid arrange spacing even clean",
    enabled: (e) => e.canEdit && e.s.selection.length > 1,
    run: ({ editor }) => editor.tidyUp(),
  },
  {
    id: "arrange.flipHorizontal",
    label: "Flip horizontal",
    group: "Arrange",
    icon: "flip-horizontal",
    defaultShortcut: { key: "h", shift: true },
    keywords: "mirror",
    enabled: canEditSelection,
    run: ({ editor }) => editor.flip("horizontal"),
  },
  {
    id: "arrange.flipVertical",
    label: "Flip vertical",
    group: "Arrange",
    icon: "flip-vertical",
    defaultShortcut: { key: "v", shift: true },
    keywords: "mirror",
    enabled: canEditSelection,
    run: ({ editor }) => editor.flip("vertical"),
  },
  {
    id: "layer.fitToContent",
    label: "Resize to fit",
    group: "Layer",
    icon: "fit",
    defaultShortcut: { key: "r", alt: true, shift: true, mod: true },
    keywords: "frame shrink wrap content hug",
    enabled: (e) =>
      e.canEdit &&
      e.s.selection.some((id) => {
        const n = e.doc.get(id);
        return n?.type === "frame" && e.doc.childIds(id).length > 0;
      }),
    run: ({ editor }) => editor.fitToContent(),
  },

  {
    id: "view.present",
    label: "Play prototype",
    group: "View",
    icon: "play",
    defaultShortcut: { key: "enter", mod: true, alt: true },
    keywords: "present prototype preview play flow",
    run: ({ present }) => present(),
  },
  {
    id: "view.prototype",
    label: "Prototype tab",
    group: "View",
    icon: "flow",
    defaultShortcut: { key: "p", alt: true },
    keywords: "interactions connections flows",
    run: ({ showTab }) => showTab("prototype"),
  },
  {
    id: "view.tokens",
    label: "Tokens and variables",
    group: "View",
    icon: "token",
    defaultShortcut: { key: "t", alt: true },
    keywords: "variables design tokens modes",
    run: ({ toggleTokens }) => toggleTokens(),
  },
  {
    id: "view.command",
    label: "Search or set a value",
    group: "View",
    icon: "search",
    defaultShortcut: { key: "k", mod: true },
    run: ({ openCommandBar }) => openCommandBar(),
  },
  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    icon: "plus",
    defaultShortcut: { key: "=", mod: true },
    // + on its own, typed with Shift or on the number pad, like Figma.
    also: [{ key: "=" }, { key: "=", shift: true }],
    run: ({ editor }) => editor.zoomBy(1.5),
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    icon: "minus",
    defaultShortcut: { key: "-", mod: true },
    also: [{ key: "-" }],
    run: ({ editor }) => editor.zoomBy(1 / 1.5),
  },
  {
    id: "view.zoom100",
    label: "Zoom to 100%",
    group: "View",
    icon: "actual-size",
    defaultShortcut: { key: "0", shift: true },
    run: ({ editor }) => editor.zoomTo(1),
  },
  {
    id: "view.zoomFit",
    label: "Zoom to fit",
    group: "View",
    icon: "fit",
    defaultShortcut: { key: "1", shift: true },
    run: ({ editor }) => editor.zoomToFit(),
  },
  {
    id: "view.zoomSelection",
    label: "Zoom to selection",
    group: "View",
    icon: "search",
    defaultShortcut: { key: "2", shift: true },
    enabled: hasSelection,
    run: ({ editor }) => editor.zoomToSelection(),
  },
  {
    id: "view.focus",
    label: "Focus mode: hide others' cursors",
    group: "View",
    icon: "eye-off",
    defaultShortcut: { key: "f", shift: true },
    run: ({ editor }) => editor.state.set({ focusMode: !editor.s.focusMode }),
  },
  {
    id: "view.rulers",
    label: "Rulers",
    group: "View",
    icon: "ruler",
    defaultShortcut: { key: "r", shift: true },
    keywords: "ruler guides measure",
    run: ({ editor }) => editor.state.set({ rulers: !editor.s.rulers }),
  },
  {
    id: "view.layoutGrids",
    label: "Layout grids",
    group: "View",
    icon: "layout-grid",
    defaultShortcut: { key: "g", shift: true },
    keywords: "columns rows grid",
    run: ({ editor }) => editor.state.set({ layoutGrids: !editor.s.layoutGrids }),
  },
  {
    id: "view.pixelSnap",
    label: "Snap to pixel grid",
    group: "View",
    icon: "pixel-grid",
    defaultShortcut: { key: "'", mod: true, shift: true },
    keywords: "pixel grid round whole integer snapping",
    run: ({ editor }) => editor.state.set({ pixelSnap: !editor.s.pixelSnap }),
  },
  {
    id: "view.lens",
    label: "Selection Lens",
    group: "View",
    icon: "inspector",
    keywords: "lens quick controls toolbar floating show hide",
    run: ({ editor }) => {
      const ui = uiFor(editor);
      ui.set({ lens: !ui.get().lens });
    },
  },
  {
    id: "view.minimap",
    label: "Minimap",
    group: "View",
    icon: "minimap",
    defaultShortcut: { key: "m", alt: true },
    keywords: "overview map navigator where people",
    run: ({ editor }) => {
      const ui = uiFor(editor);
      ui.set({ minimap: !ui.get().minimap });
    },
  },
  {
    id: "view.xray",
    label: "Layout X-ray",
    group: "View",
    icon: "xray",
    keywords: "padding gap spacing auto layout show overlay alt",
    run: ({ editor }) => toggleXray(editor),
  },
  {
    id: "layout.explain",
    label: "Explain size",
    group: "Layer",
    icon: "help",
    defaultShortcut: { key: "e", alt: true },
    keywords: "why width height hug fill fixed auto layout size calculate",
    enabled: (e) => {
      const node = e.s.selection.length === 1 ? e.doc.get(e.s.selection[0] as string) : null;
      return !!node && node.type !== "page";
    },
    run: ({ editor }) => {
      const id = editor.s.selection[0] as string;
      if (editor.s.explain?.id === id) {
        editor.state.set({ explain: null });
        return;
      }
      // The axis that's decided by something (hug or fill) says more than one set by hand.
      const axis =
        sizeMode(editor.doc, id, "height") === "fixed" &&
        sizeMode(editor.doc, id, "width") !== "fixed"
          ? "width"
          : "height";
      editor.state.set({ explain: { id, axis } });
    },
  },
  {
    id: "view.clearGuides",
    label: "Remove all guides",
    group: "View",
    icon: "close",
    keywords: "ruler guides delete clear",
    enabled: (e) => e.canEdit && e.guideCount() > 0,
    run: ({ editor }) => void editor.clearGuides(),
  },
  {
    id: "view.comments",
    label: "Show or hide comments",
    group: "View",
    icon: "comment",
    defaultShortcut: { key: "c", shift: true },
    run: ({ toggleComments }) => toggleComments(),
  },
  {
    id: "view.leftPane",
    label: "Show or hide layers",
    group: "View",
    icon: "layers",
    defaultShortcut: { key: "\\", mod: true },
    run: ({ toggleLeftPane }) => toggleLeftPane(),
  },
  {
    id: "view.rightPane",
    label: "Show or hide inspector",
    group: "View",
    icon: "inspector",
    defaultShortcut: { key: "i", mod: true, alt: true },
    run: ({ toggleRightPane }) => toggleRightPane(),
  },
  {
    id: "help.shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    icon: "key",
    defaultShortcut: { key: "/", mod: true },
    keywords: "keys hotkeys help cheat sheet",
    run: ({ showShortcuts }) => showShortcuts(),
  },
  {
    id: "file.export",
    label: "Export selection",
    group: "File",
    icon: "export",
    defaultShortcut: { key: "e", mod: true, shift: true },
    keywords: "png jpeg webp svg download image",
    enabled: hasSelection,
    run: ({ editor }) => void exportSelection(editor),
  },
  {
    id: "file.exportPagePdf",
    label: "Export page as PDF",
    group: "File",
    icon: "export",
    keywords: "pdf deck print frames pages download",
    run: ({ editor }) => void exportPageAsPdf(editor),
  },
  {
    id: "file.history",
    label: "Version history",
    group: "File",
    icon: "history",
    keywords: "versions restore undo backup snapshot timeline scrubber",
    run: ({ showHistory }) => showHistory(),
  },
  {
    id: "file.saveVersion",
    label: "Save a named version…",
    group: "File",
    icon: "history",
    defaultShortcut: { key: "s", mod: true, alt: true },
    keywords: "version name milestone checkpoint history",
    enabled: canEdit,
    run: ({ saveVersion }) => saveVersion(),
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

/** Some text is selected, directly or inside a selected group or frame, and you can edit. */
function hasText(editor: Editor): boolean {
  if (!editor.canEdit) return false;
  const visit = (id: string): boolean => {
    const node = editor.doc.get(id);
    return node?.type === "text" || editor.doc.childIds(id).some(visit);
  };
  return editor.s.selection.some(visit);
}

/**
 * An action's shortcut: the person's own if they changed it (none if they
 * removed it), else the one it comes with.
 */
export function shortcutOf(action: Action): Shortcut | undefined {
  const overrides = getOverrides();
  if (Object.hasOwn(overrides, action.id)) return overrides[action.id] ?? undefined;
  return action.defaultShortcut;
}

/** An action's other keys: only while its shortcut is the default (a changed one replaces them). */
export function alsoOf(action: Action): readonly Shortcut[] {
  return Object.hasOwn(getOverrides(), action.id) ? [] : (action.also ?? []);
}

/** Whether a key press runs `action`, by its shortcut or any of its others. */
export function triggers(action: Action, e: KeyboardEvent): boolean {
  return [shortcutOf(action), ...alsoOf(action)].some((s) => s !== undefined && matches(s, e));
}

export function matches(shortcut: Shortcut, e: KeyboardEvent): boolean {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  let key = e.key.toLowerCase();
  if (key === "delete") key = "backspace";
  if (key === "+") key = "=";
  // Shift changes some keys (Shift+1 is "!"): fall back to the physical digit.
  if (shortcut.shift && /^digit\d$/i.test(e.code)) key = e.code.slice(5);
  // And Shift+' is a double quote.
  if (shortcut.shift && e.code === "Quote") key = "'";
  // Option changes letters on macOS (⌥⇧U is "¨"): fall back to the physical key.
  if (shortcut.alt && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  return (
    key === shortcut.key &&
    mod === !!shortcut.mod &&
    e.shiftKey === !!shortcut.shift &&
    e.altKey === !!shortcut.alt
  );
}

/** One key's cap on this platform: ⌫ and ↵ on a Mac, Delete and Enter elsewhere (both delete keys work). */
function keyCap(key: string, mac: boolean): string {
  const caps: Record<string, string> = mac
    ? { backspace: "⌫", escape: "Esc", enter: "↵", "=": "+" }
    : { backspace: "Delete", escape: "Esc", enter: "Enter", "=": "+" };
  return caps[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A shortcut as key caps, one per key, in the platform's order: ["⌥", "⇧", "⌘", "K"]. */
export function shortcutCaps(s: Shortcut): string[] {
  const mac = isMac();
  const key = keyCap(s.key, mac);
  if (mac) return [s.alt ? "⌥" : "", s.shift ? "⇧" : "", s.mod ? "⌘" : "", key].filter(Boolean);
  return [s.mod ? "Ctrl" : "", s.alt ? "Alt" : "", s.shift ? "Shift" : "", key].filter(Boolean);
}

/** A shortcut as text: "⌥⌘K" on a Mac, "Ctrl+Alt+K" elsewhere. */
export function formatShortcut(s: Shortcut): string {
  return shortcutCaps(s).join(isMac() ? "" : "+");
}

/** An action's shortcut as text, as the person has it: for tooltips and hints. */
export function shortcutFor(id: string): string | undefined {
  const action = ACTIONS.find((a) => a.id === id);
  const shortcut = action ? shortcutOf(action) : undefined;
  return shortcut ? formatShortcut(shortcut) : undefined;
}

/** `{ shortcut: "⌘K" }` for a menu or command item, or nothing when the action has none. */
export function shortcutProp(action: Action): { shortcut?: string } {
  const shortcut = shortcutOf(action);
  return shortcut ? { shortcut: formatShortcut(shortcut) } : {};
}

/** An action's shortcut as key caps, for a `Kbd`. */
export function capsFor(id: string): string[] {
  const action = ACTIONS.find((a) => a.id === id);
  const shortcut = action ? shortcutOf(action) : undefined;
  return shortcut ? shortcutCaps(shortcut) : [];
}
