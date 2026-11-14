/**
 * The layers panel: the page's layer tree with search and filters, drag to
 * reorder (⌥ to duplicate), hide and lock on each row, and rename in place.
 * Long trees stay fast: only the rows in view are drawn.
 */
import { getProp, keyBetween, type NodeRecord, type Op } from "@drawpane/model";
import { Icon, IconButton, LayerRow, type PresenceSlot } from "@drawpane/ui";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import {
  containersWithin,
  type DropTarget,
  dropTarget,
  kindOf,
  LAYER_FILTERS,
  type LayerFilter,
  layerName,
  layerRows,
  type Row,
} from "./layer-tree";
import { openMenu, uiFor, useUi } from "./ui-state";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

interface DragState {
  readonly id: string;
  /** Where it drops, and the row showing it (see `dropTarget`). */
  readonly target: DropTarget | null;
  /** ⌥ held: the drop duplicates instead of moving. */
  readonly copy: boolean;
}

/** Each nesting level indents a row this much (the LayerRow's 12px), from its 4px start. */
const INDENT = 12;
const INDENT_START = 4;

export function LayersPanel() {
  const editor = useEditor();
  const version = useDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const selection = useEditorState((s) => s.selection);
  const peers = useEditorState((s) => s.peers);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const renaming = useUi(editor, (ui) => ui.renaming);
  const findRequest = useUi(editor, (ui) => ui.findLayers);
  const collapseRequest = useUi(editor, (ui) => ui.collapseLayers);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LayerFilter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 400 });

  // ⌘F opens the search in the same render, so the field (which focuses
  // itself, see LayerSearch) catches the very next keystroke.
  const [seenFind, setSeenFind] = useState(findRequest);
  if (findRequest !== seenFind) {
    setSeenFind(findRequest);
    setSearching(true);
  }

  const collapseAll = useCallback(() => {
    if (!pageId) return;
    setCollapsed(
      new Set(editor.doc.childIds(pageId).flatMap((id) => containersWithin(editor.doc, id))),
    );
  }, [editor, pageId]);

  // ⌥L folds everything.
  useEffect(() => {
    if (collapseRequest > 0) collapseAll();
  }, [collapseRequest, collapseAll]);

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

  const active = searching && (query.trim() !== "" || filter !== "all");
  const { rows, found } = useMemo(() => {
    void version;
    if (!pageId) return { rows: [] as Row[], found: [] as string[] };
    return layerRows(editor.doc, pageId, active ? { collapsed, query, filter } : { collapsed });
  }, [editor, pageId, version, collapsed, active, query, filter]);

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

  /** Folds or opens a container; `deep` (⌥-click) does the same to everything inside it. */
  const toggle = useCallback(
    (id: string, deep = false) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        const opening = prev.has(id);
        for (const c of deep ? containersWithin(editor.doc, id) : [id]) {
          if (opening) next.delete(c);
          else next.add(c);
        }
        return next;
      });
    },
    [editor],
  );

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

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
    setFilter("all");
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
        // From the top row, back up into the search field.
        if (index <= 0 && searching) {
          e.preventDefault();
          searchField.current?.focus();
          return;
        }
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight":
        if (!active && row?.hasChildren && collapsed.has(row.node.id)) {
          e.preventDefault();
          toggle(row.node.id, e.altKey);
        }
        return;
      case "ArrowLeft":
        if (!active && row?.hasChildren && !collapsed.has(row.node.id)) {
          e.preventDefault();
          toggle(row.node.id, e.altKey);
        } else if (row) {
          const parent = rows.find((r) => r.node.id === row.node.parent);
          if (parent) move(rows.indexOf(parent));
        }
        return;
    }
  };

  // Drag to reorder: above or below a row, inside a frame or group, or (below
  // the last row of nested groups) out to the level the pointer is at.
  const onDragOver = (index: number, e: React.DragEvent<HTMLDivElement>) => {
    const row = rows[index];
    if (!drag || !row || drag.id === row.node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    // The pointer's level: where it is across the row, against the rows' indents.
    const depth = (e.clientX - rect.left - INDENT_START - INDENT / 2) / INDENT;
    const target = dropTarget(rows, index, y, active ? row.depth : depth, (id) => {
      const parent = editor.doc.get(id)?.parent;
      return parent && parent !== pageId ? parent : null;
    });
    const same =
      drag.copy === e.altKey &&
      drag.target?.id === target?.id &&
      drag.target?.where === target?.where &&
      drag.target?.row === target?.row &&
      drag.target?.show === target?.show &&
      drag.target?.depth === target?.depth;
    if (!same) setDrag({ ...drag, target, copy: e.altKey });
  };

  const onDrop = () => {
    if (!drag?.target) return setDrag(null);
    const target = editor.doc.get(drag.target.id);
    const dragged = selection.includes(drag.id) ? selection : [drag.id];
    const { copy } = drag;
    const { where } = drag.target;
    setDrag(null);
    if (!target) return;
    // Refuse to drop a layer into itself.
    if (
      dragged.some(
        (id) => id === target.id || editor.doc.ancestors(target.id).some((a) => a.id === id),
      )
    )
      return;
    const keyOf = (id: string | null) => (id ? (editor.doc.get(id)?.key ?? null) : null);
    // Bottom first, so the layers keep their order relative to each other.
    const byKey = (ids: readonly string[]) =>
      [...ids].sort((a, b) =>
        (editor.doc.get(a)?.key ?? "") < (editor.doc.get(b)?.key ?? "") ? -1 : 1,
      );

    editor.beginGesture(copy ? "Duplicate layers" : "Reorder layers");
    let moving = byKey(dragged);
    if (copy) {
      // Copies first, right above their originals; then they move like a plain drag.
      const ops: Op[] = [];
      const copies: string[] = [];
      for (const id of moving) {
        const node = editor.doc.get(id);
        if (!node) continue;
        const siblings = editor.doc.childIds(node.parent);
        const next = siblings[siblings.indexOf(id) + 1];
        const made = editor.cloneOps(id, node.parent, keyBetween(node.key, keyOf(next ?? null)), {
          x: 0,
          y: 0,
        });
        ops.push(...made.ops);
        copies.push(made.rootId);
      }
      editor.commit(ops, "Duplicate layers");
      moving = copies.filter((id) => editor.doc.has(id));
    }
    let parent: string;
    let below: string | null;
    let above: string | null;
    const siblingsOf = (p: string) => editor.doc.childIds(p).filter((id) => !moving.includes(id));
    if (where === "inside") {
      parent = target.id;
      below = siblingsOf(parent).at(-1) ?? null;
      above = null;
    } else {
      parent = target.parent;
      const kids = siblingsOf(parent);
      const index = kids.indexOf(target.id);
      // The panel lists topmost first, so "before" in the list means above in z-order.
      if (where === "before") {
        below = target.id;
        above = kids[index + 1] ?? null;
      } else {
        below = kids[index - 1] ?? null;
        above = target.id;
      }
    }
    let lo = keyOf(below);
    const hi = keyOf(above);
    const ops: Op[] = [];
    for (const id of moving) {
      const key = keyBetween(lo, hi);
      ops.push(...editor.reparentOps(id, parent, key));
      lo = key;
    }
    editor.commit(ops, copy ? "Duplicate layers" : "Reorder layers");
    if (copy) editor.select(moving);
    editor.endGesture();
  };

  const start = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const tabStop = focusId ?? selection[0] ?? rows[0]?.node.id;

  return (
    <div className="layers">
      <div className="pane__head pane__head--layers">
        <span className="pane__label">Layers</span>
        <span className="pane__actions">
          <IconButton
            icon="search"
            label="Find layers"
            shortcut="⌘F"
            pressed={searching}
            onClick={() => {
              if (searching) closeSearch();
              else uiFor(editor).set({ findLayers: uiFor(editor).get().findLayers + 1 });
            }}
          />
          <IconButton
            icon="collapse-all"
            label="Collapse all layers"
            shortcut="⌥L"
            disabled={active}
            onClick={collapseAll}
          />
        </span>
      </div>
      {searching ? (
        <LayerSearch
          field={searchField}
          focusRequest={findRequest}
          query={query}
          filter={filter}
          found={found.length}
          active={active}
          onQuery={setQuery}
          onFilter={setFilter}
          onClose={closeSearch}
          onSelectAll={() => editor.select(found)}
          onFocusTree={() => {
            const first = found[0];
            if (!first) return;
            select(first, { shiftKey: false, metaKey: false, ctrlKey: false });
            requestAnimationFrame(() =>
              scroller.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(),
            );
          }}
        />
      ) : null}
      <div
        ref={scroller}
        className="layers__scroll"
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          active ? (
            <div className="layers__empty">
              <p>No layers match.</p>
              <button type="button" className="layers__link" onClick={closeSearch}>
                Clear search
              </button>
            </div>
          ) : (
            <p className="layers__empty">Layers you draw appear here.</p>
          )
        ) : (
          <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
            {rows.slice(start, end).map((row, i) => {
              const { node } = row;
              const presence = presenceBy.get(node.id);
              const drop = drag?.target?.row === node.id ? drag.target : null;
              return (
                <LayerRow
                  key={node.id}
                  className={drop ? `layers__row--drop-${drop.show}` : undefined}
                  style={
                    {
                      position: "absolute",
                      top: (start + i) * ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      ...(drop ? { "--drop-depth": drop.depth } : {}),
                    } as React.CSSProperties
                  }
                  name={layerName(node)}
                  {...(row.note ? { note: row.note } : {})}
                  {...(active && query.trim() ? { highlight: query } : {})}
                  context={row.context === true}
                  kind={kindOf(node)}
                  depth={row.depth}
                  selected={selection.includes(node.id)}
                  hidden={!getProp(node.props, "visible")}
                  hiddenByParent={row.hiddenByParent === true}
                  locked={getProp(node.props, "locked")}
                  hasChildren={row.hasChildren}
                  // Search results always show what's inside them.
                  expanded={active || !collapsed.has(node.id)}
                  tabIndex={node.id === tabStop ? 0 : -1}
                  {...(presence
                    ? { presence: presence.slot, presenceLabel: `Selected by ${presence.name}` }
                    : {})}
                  {...(active
                    ? {}
                    : { onToggleExpanded: (deep: boolean) => toggle(node.id, deep) })}
                  {...(canEdit
                    ? {
                        onToggleHidden: () =>
                          editor.setProp(
                            [node.id],
                            "visible",
                            getProp(node.props, "visible") ? false : null,
                            getProp(node.props, "visible") ? "Hide" : "Show",
                          ),
                        onToggleLocked: () =>
                          editor.setProp(
                            [node.id],
                            "locked",
                            getProp(node.props, "locked") ? null : true,
                            getProp(node.props, "locked") ? "Unlock" : "Lock",
                          ),
                        onRename: (name: string) => editor.rename(node.id, name),
                        renaming: renaming === node.id,
                        onRenamingChange: (on: boolean) =>
                          uiFor(editor).set({ renaming: on ? node.id : null }),
                        draggable: true,
                        onDragStart: (e: React.DragEvent) => {
                          e.dataTransfer.effectAllowed = "copyMove";
                          setDrag({ id: node.id, target: null, copy: e.altKey });
                        },
                        onDragOver: (e: React.DragEvent<HTMLDivElement>) =>
                          onDragOver(start + i, e),
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
      {drag?.target ? <DragStatus editor={editor} drag={drag} selection={selection} /> : null}
    </div>
  );
}

/** The search field, the filter chips and what they found. */
function LayerSearch({
  field,
  focusRequest,
  query,
  filter,
  found,
  active,
  onQuery,
  onFilter,
  onClose,
  onSelectAll,
  onFocusTree,
}: {
  field: React.RefObject<HTMLInputElement | null>;
  /** Changes on every ⌘F: focus the field (and select what's typed) when it does. */
  focusRequest: number;
  query: string;
  filter: LayerFilter;
  found: number;
  active: boolean;
  onQuery: (query: string) => void;
  onFilter: (filter: LayerFilter) => void;
  onClose: () => void;
  onSelectAll: () => void;
  onFocusTree: () => void;
}) {
  // Focus on opening, and again on every ⌘F while open.
  useLayoutEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusRequest, field]);
  return (
    <div className="layer-find">
      <div className="layer-find__field">
        <Icon name="search" size={12} />
        <input
          ref={field}
          type="search"
          aria-label="Find layers"
          placeholder="Find layers"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // The field owns its keys: no canvas shortcuts while typing.
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              onSelectAll();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onFocusTree();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="layer-find__clear"
            aria-label="Clear search"
            onClick={() => {
              onQuery("");
              field.current?.focus();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
      <div className="layer-find__filters" role="radiogroup" aria-label="Show only">
        {LAYER_FILTERS.map((f) => (
          // biome-ignore lint/a11y/useSemanticElements: chips styled as a radio group, like the design
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            className="layer-find__chip"
            onClick={() => {
              onFilter(f.value);
              field.current?.focus();
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {active ? (
        <div className="layer-find__summary" aria-live="polite">
          <span>{found === 1 ? "1 found" : `${found} found`}</span>
          {found > 0 ? (
            <button type="button" className="layers__link" onClick={onSelectAll}>
              Select all
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What a drop will do, said in words while you drag. */
function DragStatus({
  editor,
  drag,
  selection,
}: {
  editor: ReturnType<typeof useEditor>;
  drag: DragState;
  selection: readonly string[];
}) {
  const moving = selection.includes(drag.id) ? selection.length : 1;
  const node = editor.doc.get(drag.id);
  const target = drag.target ? editor.doc.get(drag.target.id) : undefined;
  if (!node || !target || !drag.target) return null;
  const what = moving > 1 ? `${moving} layers` : layerName(node);
  const parent = editor.doc.get(target.parent);
  const within = parent && parent.type !== "page" ? ` in ${layerName(parent)}` : "";
  const where =
    drag.target.where === "inside"
      ? `into ${layerName(target)}`
      : drag.target.where === "before"
        ? `above ${layerName(target)}${within}`
        : `below ${layerName(target)}${within}`;
  return (
    <div className="layers__status" role="status">
      <Icon name={drag.copy ? "duplicate" : "layers"} size={12} />
      <span>
        <strong>{what}</strong> · {drag.copy ? "copying" : "moving"} {where}
      </span>
      {drag.copy ? null : <span className="layers__status-hint">⌥ to copy</span>}
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
