import { hasMask, maskScopes } from "@drawpane/editor";
import { getProp, keyBetween, type NodeRecord } from "@drawpane/model";
import { IconButton, type LayerKind, LayerRow, type PresenceSlot } from "@drawpane/ui";
import { type KeyboardEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { openMenu, uiFor, useUi } from "./ui-state";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

const KIND: Record<string, LayerKind> = {
  frame: "frame",
  group: "group",
  rect: "rect",
  ellipse: "ellipse",
  polygon: "polygon",
  star: "star",
  line: "line",
  path: "path",
  text: "text",
};

function kindOf(node: NodeRecord): LayerKind {
  if (node.type === "frame") {
    if (getProp(node.props, "isComponent") || getProp(node.props, "isComponentSet"))
      return "component";
    if (getProp(node.props, "instanceOf") !== null) return "instance";
  }
  // A line with an end marker reads as an arrow.
  if (
    node.type === "line" &&
    (getProp(node.props, "markerEnd") !== "none" || getProp(node.props, "markerStart") !== "none")
  )
    return "arrow";
  // A rectangle filled with an image reads as an image layer.
  if (node.type === "rect" && getProp(node.props, "fills").some((f) => f.type === "image"))
    return "image";
  return KIND[node.type] ?? "rect";
}

interface Row {
  readonly node: NodeRecord;
  readonly depth: number;
  readonly hasChildren: boolean;
  /** "mask" for masks, "clipped" for the layers a mask clips. */
  readonly note?: string;
}

export function LayersPanel() {
  const editor = useEditor();
  const version = useDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const selection = useEditorState((s) => s.selection);
  const peers = useEditorState((s) => s.peers);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const renaming = useUi(editor, (ui) => ui.renaming);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    over: string | null;
    where: "before" | "after" | "inside";
  } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });

  // Expand ancestors of the selection so selected layers are always visible.
  const selectionKey = selection.join(",");
  useLayoutEffect(() => {
    if (!selectionKey) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of selectionKey.split(",")) {
        for (const a of editor.doc.ancestors(id)) {
          if (next.delete(a.id)) changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectionKey, editor]);

  // The tree, flattened to visible rows (topmost layer first, like every design tool).
  const rows = useMemo(() => {
    void version;
    const out: Row[] = [];
    if (!pageId) return out;
    const walk = (parent: string, depth: number) => {
      const ids = editor.doc.childIds(parent);
      const scopes = hasMask(editor.doc, parent)
        ? new Map(maskScopes(editor.doc, parent).map((s) => [s.id, s]))
        : null;
      for (let i = ids.length - 1; i >= 0; i--) {
        const node = editor.doc.get(ids[i] as string);
        if (!node) continue;
        const children = editor.doc.childIds(node.id);
        const scope = scopes?.get(node.id);
        const note = scope?.isMask ? "mask" : scope?.mask ? "clipped" : undefined;
        out.push({ node, depth, hasChildren: children.length > 0, ...(note ? { note } : {}) });
        if (children.length > 0 && !collapsed.has(node.id)) walk(node.id, depth + 1);
      }
    };
    walk(pageId, 0);
    return out;
  }, [editor, pageId, version, collapsed]);

  const presenceBy = useMemo(() => {
    const map = new Map<string, { slot: PresenceSlot; name: string }>();
    for (const peer of peers.values()) {
      if (peer.presence?.pageId !== pageId) continue;
      for (const id of peer.presence.selection)
        map.set(id, { slot: (((peer.color - 1) % 8) + 1) as PresenceSlot, name: peer.name });
    }
    return map;
  }, [peers, pageId]);

  // Keep the focused or newly selected row scrolled into view.
  useLayoutEffect(() => {
    const id = selection[0];
    const el = scroller.current;
    if (!id || !el) return;
    const index = rows.findIndex((r) => r.node.id === id);
    if (index === -1) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selection, rows]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const select = (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setFocusId(id);
    if (e.metaKey || e.ctrlKey) {
      editor.select(
        selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
      );
    } else if (e.shiftKey && selection.length > 0) {
      const anchor = rows.findIndex((r) => r.node.id === selection[0]);
      const target = rows.findIndex((r) => r.node.id === id);
      const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
      editor.select(rows.slice(a, b + 1).map((r) => r.node.id));
    } else {
      editor.select([id]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = focusId ?? selection[0] ?? rows[0]?.node.id;
    const index = rows.findIndex((r) => r.node.id === current);
    const row = rows[index];
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) {
        e.preventDefault();
        select(next.node.id, { shiftKey: e.shiftKey, metaKey: false, ctrlKey: false });
      }
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight":
        if (row?.hasChildren && collapsed.has(row.node.id)) {
          e.preventDefault();
          toggle(row.node.id);
        }
        return;
      case "ArrowLeft":
        if (row?.hasChildren && !collapsed.has(row.node.id)) {
          e.preventDefault();
          toggle(row.node.id);
        } else if (row) {
          const parent = rows.find((r) => r.node.id === row.node.parent);
          if (parent) move(rows.indexOf(parent));
        }
        return;
    }
  };

  // Drag to reorder: before or after a row, or inside a frame or group.
  const onDragOver = (row: Row, e: React.DragEvent<HTMLDivElement>) => {
    if (!drag || drag.id === row.node.id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const container = row.node.type === "frame" || row.node.type === "group";
    const where = container && y > 0.3 && y < 0.7 ? "inside" : y < 0.5 ? "before" : "after";
    if (drag.over !== row.node.id || drag.where !== where)
      setDrag({ ...drag, over: row.node.id, where });
  };

  const onDrop = () => {
    if (!drag?.over) return setDrag(null);
    const target = editor.doc.get(drag.over);
    const moving = selection.includes(drag.id) ? selection : [drag.id];
    setDrag(null);
    if (!target) return;
    // Refuse to drop a layer into itself.
    if (
      moving.some(
        (id) => id === target.id || editor.doc.ancestors(target.id).some((a) => a.id === id),
      )
    )
      return;
    let parent: string;
    let below: string | null;
    let above: string | null;
    const siblingsOf = (p: string) => editor.doc.childIds(p).filter((id) => !moving.includes(id));
    if (drag.where === "inside") {
      parent = target.id;
      const kids = siblingsOf(parent);
      below = kids.at(-1) ?? null;
      above = null;
    } else {
      parent = target.parent;
      const kids = siblingsOf(parent);
      const index = kids.indexOf(target.id);
      // The panel lists topmost first, so "before" in the list means above in z-order.
      if (drag.where === "before") {
        below = target.id;
        above = kids[index + 1] ?? null;
      } else {
        below = kids[index - 1] ?? null;
        above = target.id;
      }
    }
    const keyOf = (id: string | null) => (id ? (editor.doc.get(id)?.key ?? null) : null);
    let lo = keyOf(below);
    const hi = keyOf(above);
    const ops = [];
    // Keep the moving layers' relative order (bottom first).
    const ordered = [...moving].sort((a, b) => {
      const ka = editor.doc.get(a)?.key ?? "";
      const kb = editor.doc.get(b)?.key ?? "";
      return ka < kb ? -1 : 1;
    });
    for (const id of ordered) {
      const key = keyBetween(lo, hi);
      ops.push(...editor.reparentOps(id, parent, key));
      lo = key;
    }
    editor.commit(ops, "Reorder layers");
  };

  const start = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const tabStop = focusId ?? selection[0] ?? rows[0]?.node.id;

  return (
    <div className="layers">
      <div
        ref={scroller}
        className="layers__scroll"
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          <p className="layers__empty">Layers you draw appear here.</p>
        ) : (
          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {rows.slice(start, end).map((row, i) => {
              const { node } = row;
              const presence = presenceBy.get(node.id);
              const dropClass =
                drag?.over === node.id ? `layers__row--drop-${drag.where}` : undefined;
              return (
                <LayerRow
                  key={node.id}
                  className={dropClass}
                  style={{ position: "absolute", top: (start + i) * ROW_HEIGHT, left: 0, right: 0 }}
                  name={getProp(node.props, "name") || node.type}
                  {...(row.note ? { note: row.note } : {})}
                  kind={kindOf(node)}
                  depth={row.depth}
                  selected={selection.includes(node.id)}
                  hidden={!getProp(node.props, "visible")}
                  locked={getProp(node.props, "locked")}
                  hasChildren={row.hasChildren}
                  expanded={!collapsed.has(node.id)}
                  tabIndex={node.id === tabStop ? 0 : -1}
                  {...(presence
                    ? { presence: presence.slot, presenceLabel: `Selected by ${presence.name}` }
                    : {})}
                  onToggleExpanded={() => toggle(node.id)}
                  {...(canEdit
                    ? {
                        onToggleHidden: () =>
                          editor.setProp(
                            [node.id],
                            "visible",
                            getProp(node.props, "visible") ? false : null,
                            "Hide",
                          ),
                        onToggleLocked: () =>
                          editor.setProp(
                            [node.id],
                            "locked",
                            getProp(node.props, "locked") ? null : true,
                            "Lock",
                          ),
                        onRename: (name: string) => editor.rename(node.id, name),
                        renaming: renaming === node.id,
                        onRenamingChange: (on: boolean) =>
                          uiFor(editor).set({ renaming: on ? node.id : null }),
                        draggable: true,
                        onDragStart: (e: React.DragEvent) => {
                          e.dataTransfer.effectAllowed = "move";
                          setDrag({ id: node.id, over: null, where: "before" });
                        },
                        onDragOver: (e: React.DragEvent<HTMLDivElement>) => onDragOver(row, e),
                        onDrop,
                        onDragEnd: () => setDrag(null),
                      }
                    : {})}
                  onClick={(e) => select(node.id, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // Right-clicking outside the selection selects that row first.
                    if (!selection.includes(node.id)) editor.select([node.id]);
                    openMenu(editor, { kind: "layers", x: e.clientX, y: e.clientY });
                  }}
                  onMouseEnter={() => editor.state.set({ hover: node.id })}
                  onMouseLeave={() => editor.state.set({ hover: null })}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function PagesList() {
  const editor = useEditor();
  useDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const renaming = useUi(editor, (ui) => ui.renaming);
  const setRenaming = (id: string | null) => uiFor(editor).set({ renaming: id });
  const pages = editor.doc
    .pageIds()
    .map((id) => editor.doc.get(id))
    .filter((p): p is NodeRecord => !!p);

  return (
    <div className="pages">
      <div className="pane__head">
        <span className="pane__label">Pages</span>
        {canEdit ? (
          <IconButton icon="plus" label="Add page" onClick={() => editor.addPage()} />
        ) : null}
      </div>
      <ul className="pages__list" aria-label="Pages">
        {pages.map((page) => (
          <li key={page.id}>
            {renaming === page.id ? (
              <input
                className="pages__rename"
                defaultValue={getProp(page.props, "name")}
                aria-label="Page name"
                // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit action
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  editor.rename(page.id, e.currentTarget.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="pages__item"
                aria-current={page.id === pageId ? "page" : undefined}
                onClick={() => editor.setPage(page.id)}
                onDoubleClick={() => canEdit && setRenaming(page.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(editor, { kind: "page", x: e.clientX, y: e.clientY, pageId: page.id });
                }}
              >
                <span>{getProp(page.props, "name") || "Page"}</span>
                <span className="pages__count">{editor.doc.childIds(page.id).length || ""}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
