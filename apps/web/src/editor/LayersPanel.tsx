/**
 * The layers panel: the page's layer tree with search and filters, drag to
 * reorder (⌥ to duplicate), hide and lock on each row, and rename in place.
 * Long trees stay fast: only the rows in view are drawn.
 */
import { type Editor, modeTag } from "@drawpane/editor";
import { getProp, keyBetween, type NodeRecord, type Op } from "@drawpane/model";
import { Button, Icon, IconButton, LayerRow, type PresenceSlot } from "@drawpane/ui";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isMac } from "../app/format";
import { shortcutFor } from "./actions";
import { useCanEdit, useDeferredDocVersion, useEditor, useEditorState } from "./hooks";
import {
  aimDrop,
  containersWithin,
  type DropTarget,
  dropPlacement,
  INDENT,
  INDENT_START,
  indexRows,
  kindOf,
  LAYER_FILTERS,
  type LayerFilter,
  type ListedRows,
  layerName,
  layerRows,
  patchRows,
  pinnedRows,
  type Row,
  type RowIndex,
  revealLeft,
  rowPositions,
  rowWidthFor,
} from "./layer-tree";
import { openMenu, uiFor, useUi } from "./ui-state";

const ROW_HEIGHT = 28;
/**
 * The rows drawn move a block at a time: scrolling within a block draws
 * nothing new, so most scroll frames render nothing at all.
 */
const BLOCK = 8;

/** At most half the tree's height is pinned ancestors, so there's always room to see what's in them. */
const maxPinsFor = (height: number) => Math.max(1, Math.floor(height / ROW_HEIGHT / 2));

/** What the scroll position decides for the tree, kept only when it changes. */
interface View {
  /** The block of rows at the top of the view (see BLOCK). */
  readonly block: number;
  readonly height: number;
  readonly width: number;
}

interface DragState {
  readonly id: string;
  /** Where it drops, and the row showing it (see `dropTarget`). */
  readonly target: DropTarget | null;
  /** ⌥ held: the drop duplicates instead of moving. */
  readonly copy: boolean;
}

export function LayersPanel() {
  const editor = useEditor();
  const version = useDeferredDocVersion();
  const pageId = useEditorState((s) => s.pageId);
  const selection = useEditorState((s) => s.selection);
  const peers = useEditorState((s) => s.peers);
  const canEdit = useCanEdit();
  const workspaceMode = useUi(editor, (ui) => ui.workspaceMode);
  const explicitRename = workspaceMode === "tablet";
  const renaming = useUi(editor, (ui) => ui.renaming);
  const renamingNode = explicitRename && canEdit && renaming ? editor.doc.get(renaming) : undefined;
  const renamingLayer = renamingNode && renamingNode.type !== "page" ? renamingNode : undefined;
  const renameInput = useRef<HTMLInputElement>(null);
  const findRequest = useUi(editor, (ui) => ui.findLayers);
  const collapseRequest = useUi(editor, (ui) => ui.collapseLayers);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LayerFilter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ block: 0, height: 400, width: 264 });

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
  // The rows last walked, and what for: an edit that changes only layers' own records patches
  // their rows instead of walking the whole page again (see `patchRows`).
  const walked = useRef<{
    listed: ListedRows;
    pageId: string;
    collapsed: ReadonlySet<string>;
    found: string[];
    /** Changes whenever the list's shape does (not when a row only got a new record). */
    shape: number;
  } | null>(null);
  const { rows, found, shape } = useMemo(() => {
    if (!pageId) return { rows: [] as readonly Row[], found: [] as string[], shape: -1 };
    const last = walked.current;
    if (!active && last && last.pageId === pageId && last.collapsed === collapsed) {
      const patched = patchRows(editor.doc, last.listed);
      if (patched) {
        last.listed = { ...last.listed, rows: patched, version };
        return { rows: patched, found: last.found, shape: last.shape };
      }
    }
    const result = layerRows(
      editor.doc,
      pageId,
      active ? { collapsed, query, filter } : { collapsed },
    );
    walked.current = active
      ? null
      : {
          listed: { rows: result.rows, version, at: rowPositions(result.rows) },
          pageId,
          collapsed,
          found: result.found,
          shape: (last?.shape ?? 0) + 1,
        };
    return { ...result, shape: active ? -2 - version : (walked.current?.shape ?? 0) };
  }, [editor, pageId, version, collapsed, active, query, filter]);

  // Where each row sits in the tree depends on the list's shape alone.
  const rowIndex = useMemo(() => indexRows(rows), [shape]);

  // As wide as the deepest open row needs: a deep tree scrolls sideways. All
  // the open rows, not just the drawn ones, so the width holds while scrolling down.
  const treeWidth = useMemo(() => {
    let deepest = 0;
    for (const row of rows) if (row.depth > deepest) deepest = row.depth;
    return rowWidthFor(deepest);
  }, [shape]);

  const presenceBy = useMemo(() => {
    const map = new Map<string, { slot: PresenceSlot; name: string }>();
    for (const peer of peers.values()) {
      if (peer.presence?.pageId !== pageId) continue;
      for (const id of peer.presence.selection)
        map.set(id, { slot: (((peer.color - 1) % 8) + 1) as PresenceSlot, name: peer.name });
    }
    return map;
  }, [peers, pageId]);

  // A row the keyboard moved to takes focus as soon as it's on screen (the list is virtual).
  const focusRow = useRef<string | null>(null);
  // After each draw of the rows: the selection moved, or the list scrolled to it.
  useEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    focusRow.current = null;
  }, [selection, view]);

  // Keep the focused or newly selected row scrolled into view: down to it, and
  // across to its name in a deep tree (once per selection, so scrolling sideways
  // by hand isn't undone by the next edit).
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = selection[0];
    const el = scroller.current;
    // Selecting it again later (after something else, or nothing) reveals it again.
    if (revealed.current !== (id ?? null)) revealed.current = null;
    if (!id || !el) return;
    const index = rows.findIndex((r) => r.node.id === id);
    const row = rows[index];
    if (!row) return;
    const top = index * ROW_HEIGHT;
    // Under the pinned ancestors counts as out of view: it goes just below them.
    const pins = pinnedRows(rowIndex, el.scrollTop, ROW_HEIGHT, maxPinsFor(el.clientHeight));
    const covered = pins.rows.length * ROW_HEIGHT + pins.offset;
    if (top < el.scrollTop + covered)
      el.scrollTop = top - Math.min(row.depth, maxPinsFor(el.clientHeight)) * ROW_HEIGHT;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    if (revealed.current === id) return;
    revealed.current = id;
    const left = revealLeft(row.depth, el.scrollLeft, el.clientWidth);
    if (left !== null) el.scrollLeft = left;
  }, [selection, rows, rowIndex]);

  // The scroll position, read on every scroll event and resize, renders the
  // tree only when it brings another block of rows into view. Scrolling
  // sideways moves the drawn rows all at once, with no render (the toggles
  // stick by CSS). The pinned rows keep their own state (see PinnedRows),
  // updated from the same listener so both render together, once.
  const placePins = useRef(() => {});
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      placePins.current();
      const block = Math.floor(el.scrollTop / ROW_HEIGHT / BLOCK);
      const height = el.clientHeight;
      const width = el.clientWidth;
      setView((prev) =>
        prev.block === block && prev.height === height && prev.width === width
          ? prev
          : { block, height, width },
      );
    };
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
        // Focus follows the selection (and screen readers with it), once its row is drawn.
        focusRow.current = next.node.id;
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
  const aim = (index: number, y: number, left: number, e: React.DragEvent) => {
    const row = rows[index];
    if (!drag || !row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    // The pointer's level: where it is across the row, against the rows' indents.
    // `left` is the row's (or list's) left on screen, so it already moves with
    // the tree when that's scrolled sideways.
    const depth = (e.clientX - left - INDENT_START - INDENT / 2) / INDENT;
    const parentOf = (id: string) => {
      const parent = editor.doc.get(id)?.parent;
      return parent && parent !== pageId ? parent : null;
    };
    const target = aimDrop({
      doc: editor.doc,
      rows,
      index,
      y,
      depth: active ? row.depth : depth,
      moving: selection.includes(drag.id) ? selection : [drag.id],
      parentOf,
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
  const onDragOver = (index: number, e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    aim(index, (e.clientY - rect.top) / rect.height, rect.left, e);
  };
  // The empty space under the list is below its last row.
  const onDragOverEnd = (e: React.DragEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (e.defaultPrevented || !drag || !list || rows.length === 0) return;
    const rect = list.getBoundingClientRect();
    if (e.clientY < rect.bottom) return;
    aim(rows.length - 1, 1, rect.left, e);
  };

  const onDrop = () => {
    if (!drag?.target) return setDrag(null);
    const target = editor.doc.get(drag.target.id);
    const dragged = selection.includes(drag.id) ? selection : [drag.id];
    const { copy } = drag;
    setDrag(null);
    if (!target) return;
    // A layer never drops inside itself.
    if (!dropPlacement(editor.doc, drag.target, dragged)) return;
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
    const place = dropPlacement(editor.doc, drag.target, moving);
    if (!place) {
      editor.endGesture();
      return;
    }
    const { parent, below, above } = place;
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

  // The block in view, a block above and two below: whichever way it scrolls next, those rows are drawn.
  const start = Math.max(0, (view.block - 1) * BLOCK);
  const end = Math.min(rows.length, (view.block + 2) * BLOCK + Math.ceil(view.height / ROW_HEIGHT));
  const tabStop = focusId ?? selection[0] ?? rows[0]?.node.id;

  /** How a row looks and what its toggles, icon and menu do: the same in the tree and pinned above it. */
  const look = (row: Row) => {
    const { node } = row;
    const presence = presenceBy.get(node.id);
    const visible = getProp(node.props, "visible");
    const locked = getProp(node.props, "locked");
    return {
      name: layerName(node),
      ...(row.note ? { note: row.note } : {}),
      ...modeBadge(editor, node),
      ...(active && query.trim() ? { highlight: query } : {}),
      context: row.context === true,
      kind: kindOf(node),
      depth: row.depth,
      selected: selection.includes(node.id),
      hidden: !visible,
      hiddenByParent: row.hiddenByParent === true,
      locked,
      hasChildren: row.hasChildren,
      // Search results always show what's inside them.
      expanded: active || !collapsed.has(node.id),
      ...(presence
        ? { presence: presence.slot, presenceLabel: `Selected by ${presence.name}` }
        : {}),
      ...(canEdit
        ? {
            onToggleHidden: () =>
              editor.setProp(
                [node.id],
                "visible",
                visible ? false : null,
                visible ? "Hide" : "Show",
              ),
            onToggleLocked: () =>
              editor.setProp([node.id], "locked", locked ? null : true, locked ? "Unlock" : "Lock"),
          }
        : {}),
      // Double-clicking the icon zooms to the layer, as in Figma (Shift+2, gliding).
      onIconDoubleClick: () => {
        setFocusId(node.id);
        editor.select([node.id]);
        editor.zoomToLayers([node.id], { animate: true });
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        // Right-clicking outside the selection selects that row first.
        if (!selection.includes(node.id)) editor.select([node.id]);
        openMenu(editor, { kind: "layers", x: e.clientX, y: e.clientY });
      },
      onMouseEnter: () => editor.state.set({ hover: node.id }),
      onMouseLeave: () => editor.state.set({ hover: null }),
    };
  };

  return (
    <div className="layers">
      <div className="pane__head pane__head--layers">
        <span className="pane__label">Layers</span>
        <span className="pane__actions">
          <IconButton
            icon="search"
            label="Find layers"
            shortcut={shortcutFor("layer.find")}
            pressed={searching}
            onClick={() => {
              if (searching) closeSearch();
              else uiFor(editor).set({ findLayers: uiFor(editor).get().findLayers + 1 });
            }}
          />
          <IconButton
            icon="collapse-all"
            label="Collapse all layers"
            shortcut={shortcutFor("layer.collapseAll")}
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
      {renamingLayer ? (
        <section className="tablet-rename" aria-label="Rename layer">
          <input
            ref={renameInput}
            key={renamingLayer.id}
            className="tablet-rename__input"
            aria-label="Layer name"
            defaultValue={getProp(renamingLayer.props, "name")}
            // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit action
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                const next = e.currentTarget.value.trim();
                if (next) editor.rename(renamingLayer.id, next);
                uiFor(editor).set({ renaming: null });
              }
              if (e.key === "Escape") uiFor(editor).set({ renaming: null });
            }}
          />
          <div className="tablet-rename__actions">
            <Button
              size="sm"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => uiFor(editor).set({ renaming: null })}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                const next = renameInput.current?.value.trim() ?? "";
                if (next) editor.rename(renamingLayer.id, next);
                uiFor(editor).set({ renaming: null });
              }}
            >
              Done
            </Button>
          </div>
        </section>
      ) : null}
      <div
        ref={scroller}
        className={[
          "layers__scroll",
          treeWidth > view.width ? "is-wide" : "",
          drag ? "is-dragging" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onDragOver={onDragOverEnd}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          onDrop();
        }}
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
          <>
            <PinnedRows
              scroller={scroller}
              place={placePins}
              rows={rows}
              index={rowIndex}
              width={treeWidth}
            >
              {(row, index, slot) => {
                const { node } = row;
                // Shown where the row would be if it were scrolled to: just under its own pinned ancestors.
                const scrollTo = () => {
                  const el = scroller.current;
                  if (el) el.scrollTop = (index - slot) * ROW_HEIGHT;
                };
                return (
                  <LayerRow
                    {...look(row)}
                    tabIndex={-1}
                    data-pinned-id={node.id}
                    {...(active
                      ? {}
                      : {
                          onToggleExpanded: (deep: boolean) => {
                            // Folding it keeps it in place, as the top row under its ancestors.
                            scrollTo();
                            toggle(node.id, deep);
                          },
                        })}
                    onClick={(e) => {
                      select(node.id, e);
                      scrollTo();
                    }}
                  />
                );
              }}
            </PinnedRows>
            <div
              ref={listRef}
              className="layers__list"
              style={{ height: rows.length * ROW_HEIGHT, width: treeWidth }}
            >
              {rows.slice(start, end).map((row, i) => {
                const { node } = row;
                const drop = drag?.target?.row === node.id ? drag.target : null;
                return (
                  <LayerRow
                    key={node.id}
                    {...look(row)}
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
                    tabIndex={node.id === tabStop ? 0 : -1}
                    data-layer-id={node.id}
                    {...(active
                      ? {}
                      : { onToggleExpanded: (deep: boolean) => toggle(node.id, deep) })}
                    {...(canEdit
                      ? {
                          onRename: (name: string) => editor.rename(node.id, name),
                          renaming: !explicitRename && renaming === node.id,
                          onRenamingChange: (on: boolean) =>
                            uiFor(editor).set({ renaming: on ? node.id : null }),
                          draggable: true,
                          onDragStart: (e: React.DragEvent) => {
                            e.dataTransfer.effectAllowed = "copyMove";
                            setDrag({ id: node.id, target: null, copy: e.altKey });
                          },
                          onDragOver: (e: React.DragEvent<HTMLDivElement>) =>
                            onDragOver(start + i, e),
                          onDrop: (e: React.DragEvent) => {
                            // The list below hears drops on its empty space; this one's handled.
                            e.stopPropagation();
                            e.preventDefault();
                            onDrop();
                          },
                          onDragEnd: () => setDrag(null),
                        }
                      : {})}
                    onClick={(e) => select(node.id, e)}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
      {drag?.target ? <DragStatus editor={editor} drag={drag} selection={selection} /> : null}
    </div>
  );
}

/**
 * The ancestors of the rows at the top of the tree, pinned there while you
 * scroll inside them (see `pinnedRows`). They keep their own state, which the
 * tree's scroll listener updates through `place`: a scroll that pins other
 * rows renders just these, one that only moves the innermost (sliding it up
 * as the end of what it holds passes) renders nothing. They're copies of rows
 * the tree has, so hidden from assistive tech.
 */
function PinnedRows({
  scroller,
  place,
  rows,
  index,
  width,
  children,
}: {
  scroller: React.RefObject<HTMLDivElement | null>;
  place: React.RefObject<() => void>;
  rows: readonly Row[];
  index: RowIndex;
  width: number;
  children: (row: Row, index: number, slot: number) => React.ReactNode;
}) {
  const [pinned, setPinned] = useState<{ rows: readonly number[]; of: RowIndex | null }>({
    rows: [],
    of: null,
  });
  const host = useRef<HTMLDivElement>(null);
  place.current = () => {
    const el = scroller.current;
    if (!el) return;
    const pins = pinnedRows(index, el.scrollTop, ROW_HEIGHT, maxPinsFor(el.clientHeight));
    setPinned((prev) =>
      prev.of === index &&
      prev.rows.length === pins.rows.length &&
      prev.rows.every((r, i) => r === pins.rows[i])
        ? prev
        : { rows: pins.rows, of: index },
    );
    // Only the innermost slides; one that was innermost before is back in place.
    const pinEls = host.current?.children ?? [];
    for (let i = 0; i < pinEls.length; i++) {
      const style = (pinEls[i] as HTMLElement).style;
      const to = i === pinEls.length - 1 && pins.offset < 0 ? `0 ${pins.offset}px` : "";
      if (style.translate !== to) style.translate = to;
    }
  };
  // Other rows (a fold, an edit, a search) pin other ancestors; and after each
  // render the innermost is placed again.
  useLayoutEffect(() => place.current());
  // Positions in `rows`: only good for the rows they were found in.
  const shown = pinned.of === index ? pinned.rows : [];
  if (shown.length === 0) return null;
  return (
    <div ref={host} className="layers__pinned" aria-hidden="true" style={{ width }}>
      {shown.map((at, slot) => {
        const row = rows[at];
        if (!row) return null;
        return (
          <div
            key={row.node.id}
            className="layers__pin"
            style={{ top: slot * ROW_HEIGHT, zIndex: shown.length - slot }}
          >
            {children(row, at, slot)}
          </div>
        );
      })}
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
      {drag.copy ? null : (
        <span className="layers__status-hint">{isMac() ? "⌥" : "Alt"} to copy</span>
      )}
    </div>
  );
}

/** The variable mode a frame sets itself ("Dark"), as a tag after its name. */
function modeBadge(editor: Editor, node: NodeRecord): { badge?: string; badgeLabel?: string } {
  const tag = modeTag(editor.doc, node);
  return tag ? { badge: tag.text, badgeLabel: `Variable mode: ${tag.label}` } : {};
}
