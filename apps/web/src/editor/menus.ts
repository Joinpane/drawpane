/**
 * Context menus, built from the action registry: every item is an action
 * with its one label, shortcut and enabled state, so menus, shortcuts and
 * the command bar never disagree. Items that can't run right now are left
 * out rather than greyed, so each menu only offers what makes sense.
 */
import { type Editor, isInstanceRoot, swapTargets } from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import type { ContextMenuAction, ContextMenuEntry, IconName } from "@drawpane/ui";
import { ACTIONS, type Action, type ActionContext, formatShortcut } from "./actions";
import { layerKind } from "./layer-kinds";
import type { MenuRequest } from "./ui-state";

const BY_ID: ReadonlyMap<string, Action> = new Map(ACTIONS.map((a) => [a.id, a]));

/** Extra things menus do that aren't registry actions (they need the pointer or a page). */
export interface MenuHost {
  readonly ctx: ActionContext;
  /** Pastes the clipboard centred on a page point. */
  readonly pasteAt: (point: { x: number; y: number }) => void;
  /** Starts renaming a page in the pages list. */
  readonly renamePage: (pageId: string) => void;
  /** Whether comment pins are showing. */
  readonly commentsShown: boolean;
}

type Item = ContextMenuAction | null;

/** A registry action as a menu item, or null when it can't run now. */
function action(host: MenuHost, id: string, label?: string, icon?: IconName): Item {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`No action "${id}"`);
  const editor = host.ctx.editor;
  if (a.enabled && !a.enabled(editor)) return null;
  return {
    id,
    label: label ?? a.label,
    ...((icon ?? a.icon) ? { icon: icon ?? a.icon } : {}),
    ...(a.shortcut ? { shortcut: formatShortcut(a.shortcut) } : {}),
    onSelect: () => a.run(host.ctx),
  };
}

/** A submenu (sections split by separators), or null when none of its items can run. */
function submenu(label: string, icon: IconName, ...groups: ReadonlyArray<readonly Item[]>): Item {
  const items = sections(...groups);
  return items.length > 0 ? { id: label, label, icon, items } : null;
}

/** An on/off item: its check mark shows in the icon column, so it carries no icon. */
function toggle(item: Item, checked: boolean): Item {
  if (!item) return null;
  const { icon: _icon, ...rest } = item;
  return { ...rest, checked };
}

/** Sections joined by separators; empty sections disappear. */
function sections(...groups: ReadonlyArray<readonly Item[]>): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  for (const group of groups) {
    const live = group.filter((i): i is ContextMenuAction => i !== null);
    if (live.length === 0) continue;
    if (out.length > 0) out.push({ separator: true, id: `sep-${out.length}` });
    out.push(...live);
  }
  return out;
}

function pasteHere(host: MenuHost, request: MenuRequest): Item {
  if (!host.ctx.editor.canEdit) return null;
  const point = request.point;
  const paste = BY_ID.get("edit.paste");
  return {
    id: "edit.pasteHere",
    label: point ? "Paste here" : "Paste",
    icon: "paste",
    ...(paste?.shortcut ? { shortcut: formatShortcut(paste.shortcut) } : {}),
    onSelect: () => (point ? host.pasteAt(point) : host.ctx.paste()),
  };
}

/** "Select layer": every layer under the pointer, so buried ones are one click away. */
function selectLayer(editor: Editor, request: MenuRequest): Item {
  if (!request.point) return null;
  const ids = editor.layersAt(request.point);
  if (ids.length < 2) return null;
  const depth = (id: string) => editor.doc.ancestors(id).filter((a) => a.type !== "page").length;
  const base = Math.min(...ids.map(depth));
  // Outermost first, like the layers panel; hits come deepest first.
  return submenu(
    "Select layer",
    "layers",
    [...ids].reverse().map((id) => {
      const node = editor.doc.get(id);
      const name = (node && getProp(node.props, "name")) || node?.type || "Layer";
      return {
        id: `select-${id}`,
        // Indent by nesting so the list reads like the layers panel.
        label: `${" ".repeat(Math.min(4, depth(id) - base))}${name}`,
        // Each layer's kind, or a check on the one that's selected now.
        icon: editor.s.selection.includes(id) ? "check" : layerKind(node?.type ?? "").icon,
        onSelect: () => editor.select([id]),
      };
    }),
  );
}

/** The menu for a right-click on the canvas or in the layers panel. */
export function selectionMenu(host: MenuHost, request: MenuRequest): ContextMenuEntry[] {
  const editor = host.ctx.editor;
  if (editor.s.selection.length === 0) return canvasMenu(host, request);
  const a = (id: string, label?: string) => action(host, id, label);
  const ids = editor.s.selection;
  const anyVisible = ids.some((id) => editor.doc.get(id)?.props.visible !== false);
  const anyUnlocked = ids.some((id) => editor.doc.get(id)?.props.locked !== true);
  return sections(
    [
      a("edit.copy"),
      a("edit.cut"),
      pasteHere(host, request),
      a("edit.duplicate"),
      submenu(
        "Copy/paste as",
        "copy",
        [a("edit.copyAsPng"), a("edit.copyAsSvg"), a("edit.copyAsCss")],
        [a("edit.copyProperties"), a("edit.pasteProperties")],
      ),
    ],
    [request.kind === "canvas" ? selectLayer(editor, request) : null],
    [a("arrange.front"), a("arrange.back")],
    [
      a("layer.group"),
      a("layer.ungroup"),
      a(
        "layer.mask",
        ids.every((id) => editor.doc.get(id)?.props.isMask === true)
          ? "Remove mask"
          : "Use as mask",
      ),
      a("layer.frame"),
      a("layer.autoLayout"),
      a("layer.gridLayout"),
      a("layer.fitToContent"),
    ],
    [
      submenu(
        "Arrange",
        "align-left",
        [
          a("arrange.alignLeft"),
          a("arrange.alignCenter"),
          a("arrange.alignRight"),
          a("arrange.alignTop"),
          a("arrange.alignMiddle"),
          a("arrange.alignBottom"),
        ],
        [a("arrange.distributeHorizontal"), a("arrange.distributeVertical"), a("arrange.tidyUp")],
        [a("arrange.flipHorizontal"), a("arrange.flipVertical")],
        [a("arrange.forward"), a("arrange.backward")],
      ),
      a("component.create"),
      a("component.combine"),
      swapMenu(host),
      a("component.main"),
      a("component.reset"),
      a("component.detach"),
    ],
    [
      a("layer.crop"),
      a("vector.edit"),
      a("vector.flatten"),
      submenu("Boolean", "union", [
        a("vector.union", "Union"),
        a("vector.subtract", "Subtract"),
        a("vector.intersect", "Intersect"),
        a("vector.exclude", "Exclude"),
      ]),
    ],
    [
      action(host, "layer.hide", anyVisible ? "Hide" : "Show", anyVisible ? "eye-off" : "eye"),
      action(host, "layer.lock", anyUnlocked ? "Lock" : "Unlock", anyUnlocked ? "lock" : "unlock"),
      a("layer.rename"),
    ],
    [a("view.zoomSelection"), a("file.export", "Export…")],
    [deleteItem(host)],
  );
}

/** "Swap with" and the components a selected instance can become. */
function swapMenu(host: MenuHost): Item {
  const editor = host.ctx.editor;
  const { selection } = editor.s;
  const only = selection.length === 1 ? (selection[0] as string) : null;
  if (!only || !editor.canEdit || !isInstanceRoot(editor.doc.get(only))) return null;
  const targets = swapTargets(editor.doc, only);
  if (targets.length === 0) return null;
  return {
    id: "component.swap",
    label: "Swap with",
    icon: "instance",
    items: targets.map((t) => ({
      id: `swap:${t.id}`,
      label: t.label,
      onSelect: () => editor.swapInstance(only, t.id),
    })),
  };
}

function deleteItem(host: MenuHost): Item {
  const item = action(host, "edit.delete");
  return item ? { ...item, danger: true } : null;
}

/** The menu for a right-click on empty canvas. */
export function canvasMenu(host: MenuHost, request: MenuRequest): ContextMenuEntry[] {
  const editor = host.ctx.editor;
  const a = (id: string, label?: string) => action(host, id, label);
  const comments = action(host, "view.comments", "Show comments");
  const focus = action(host, "view.focus", "Hide other people's cursors");
  const rulers = action(host, "view.rulers", "Show rulers");
  const grids = action(host, "view.layoutGrids", "Show layout grids");
  return sections(
    [pasteHere(host, request), a("edit.selectAll")],
    [
      toggle(rulers, editor.s.rulers),
      toggle(grids, editor.s.layoutGrids),
      toggle(comments, host.commentsShown),
      toggle(focus, editor.s.focusMode),
    ],
    [a("view.clearGuides")],
    [a("view.zoomFit"), a("view.zoom100"), a("view.zoomIn"), a("view.zoomOut")],
    [a("file.exportPagePdf")],
    [a("file.history"), a("help.shortcuts")],
  );
}

/** The menu for a right-click on a page in the pages list. */
export function pageMenu(host: MenuHost, request: MenuRequest): ContextMenuEntry[] {
  const editor = host.ctx.editor;
  const pageId = request.pageId;
  if (!pageId || !editor.doc.has(pageId)) return [];
  const canEdit = editor.canEdit;
  const last = editor.doc.pageIds().length <= 1;
  return sections(
    [
      editor.s.pageId !== pageId
        ? {
            id: "page.open",
            label: "Open",
            icon: "arrow-right",
            onSelect: () => editor.setPage(pageId),
          }
        : null,
      canEdit
        ? {
            id: "page.rename",
            label: "Rename",
            icon: "rename",
            onSelect: () => host.renamePage(pageId),
          }
        : null,
      canEdit
        ? {
            id: "page.duplicate",
            label: "Duplicate",
            icon: "duplicate",
            onSelect: () => editor.duplicatePage(pageId),
          }
        : null,
      action(host, "file.addPage", "Add page"),
    ],
    [
      canEdit && !last
        ? {
            id: "page.delete",
            label: "Delete page",
            icon: "trash",
            danger: true,
            onSelect: () => editor.deletePage(pageId),
          }
        : null,
    ],
  );
}

/** The menu for a right-click on a ruler guide. */
export function guideMenu(host: MenuHost, request: MenuRequest): ContextMenuEntry[] {
  const editor = host.ctx.editor;
  const guide = request.guide;
  if (!guide || !editor.canEdit) return [];
  return sections(
    [
      {
        id: "guide.delete",
        label: "Remove guide",
        icon: "trash",
        onSelect: () => editor.setGuide(guide.owner, guide.index, null),
      },
      action(host, "view.clearGuides"),
    ],
    [
      (() => {
        return toggle(action(host, "view.rulers", "Show rulers"), editor.s.rulers);
      })(),
    ],
  );
}

/** The menu for a request. */
export function menuFor(host: MenuHost, request: MenuRequest): ContextMenuEntry[] {
  if (request.kind === "page") return pageMenu(host, request);
  if (request.kind === "guide") return guideMenu(host, request);
  return selectionMenu(host, request);
}
