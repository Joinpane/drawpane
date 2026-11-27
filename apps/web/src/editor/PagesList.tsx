/**
 * The file's pages, above the layers: pick one, double-click to rename,
 * right-click for its menu. The line below the list moves, like Figma's: drag
 * it (or focus it and use ↑ and ↓) to show more pages or more layers. The
 * list is never taller than its pages, and the layers always keep some room.
 */
import type { Doc } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button, IconButton } from "@drawpane/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { shallowArray, useCanEdit, useDocSelector, useEditor, useEditorState } from "./hooks";
import { clampPages, PAGES, pagesRange, setPanelLayout, usePanelLayout } from "./panel-layout";
import { Splitter } from "./Splitter";
import { openMenu, uiFor, useUi } from "./ui-state";

/** How tall all the pages are, and the height the list and the layers share. */
interface Fit {
  readonly content: number;
  readonly room: number;
}

/**
 * What the list shows of each page, flat: its record (the same object until
 * the page itself changes), then how many layers it holds at the top.
 */
const pageRows = (doc: Doc): Array<NodeRecord | number> =>
  doc.pageIds().flatMap((id) => {
    const page = doc.get(id);
    return page ? [page, doc.childIds(id).length] : [];
  });

export function PagesList({
  phone = false,
  onSelectPage,
}: {
  /** Compact sheet layout on phones: full-height list, no splitter or edit controls. */
  phone?: boolean;
  onSelectPage?: () => void;
} = {}) {
  const editor = useEditor();
  // The pages and their layer counts: an edit inside a page doesn't render the list.
  const rows = useDocSelector(pageRows, shallowArray);
  const pages: Array<{ page: NodeRecord; count: number }> = [];
  for (let i = 0; i < rows.length; i += 2)
    pages.push({ page: rows[i] as NodeRecord, count: rows[i + 1] as number });
  const pageId = useEditorState((s) => s.pageId);
  const canEdit = useCanEdit();
  const workspaceMode = useUi(editor, (ui) => ui.workspaceMode);
  const explicitRename = workspaceMode === "tablet";
  const renaming = useUi(editor, (ui) => ui.renaming);
  const setRenaming = (id: string | null) => uiFor(editor).set({ renaming: id });
  const renameInput = useRef<HTMLInputElement>(null);

  const chosen = usePanelLayout().pages;
  const section = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);

  // Measured after every render (pages come and go, a rename's field is shorter than a row)
  // and whenever the panel's height changes: before paint, so the list never shows a wrong height.
  const measure = useRef(() => {});
  measure.current = () => {
    if (phone) return;
    const el = section.current;
    const ul = list.current;
    const pane = el?.parentElement;
    if (!el || !ul || !pane) return;
    const next = {
      content: ul.scrollHeight,
      // Everything in the panel from the list down is the list and the layers.
      room: pane.clientHeight - el.offsetTop - (el.offsetHeight - ul.offsetHeight),
    };
    setFit((was) => (was?.content === next.content && was.room === next.room ? was : next));
  };
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    if (phone) return;
    const pane = section.current?.parentElement;
    if (!pane) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(pane);
    return () => observer.disconnect();
  }, [phone]);

  const shown = fit ? clampPages(chosen, fit.content, fit.room) : chosen;
  const range = fit ? pagesRange(fit.content, fit.room) : { min: PAGES.min, max: shown };

  // The current page stays in view when the list gets shorter, or another page is picked.
  const before = useRef({ shown, pageId });
  useLayoutEffect(() => {
    const was = before.current;
    before.current = { shown, pageId };
    if (shown >= was.shown && pageId === was.pageId) return;
    const ul = list.current;
    const item = ul?.querySelector('[aria-current="page"]')?.closest("li");
    if (!ul || !item) return;
    const view = ul.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < view.top) ul.scrollTop -= view.top - row.top;
    else if (row.bottom > view.bottom) ul.scrollTop += row.bottom - view.bottom;
  }, [shown, pageId]);

  return (
    <div className={phone ? "pages pages--sheet" : "pages"} ref={section}>
      {phone ? null : (
        <div className="pane__head">
          <span className="pane__label">Pages</span>
          {canEdit ? (
            <IconButton icon="plus" label="Add page" onClick={() => editor.addPage()} />
          ) : null}
        </div>
      )}
      <ul
        className="pages__list"
        aria-label="Pages"
        ref={list}
        style={phone ? undefined : { maxHeight: shown }}
      >
        {pages.map(({ page, count }) => (
          <li key={page.id}>
            {renaming === page.id && canEdit ? (
              explicitRename ? (
                <div className="pages__rename-bar">
                  <input
                    ref={renameInput}
                    className="pages__rename"
                    defaultValue={getProp(page.props, "name")}
                    aria-label="Page name"
                    // biome-ignore lint/a11y/noAutofocus: renaming starts from an explicit action
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        editor.rename(page.id, e.currentTarget.value);
                        setRenaming(null);
                      }
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                  <div className="pages__rename-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        editor.rename(page.id, renameInput.current?.value ?? "");
                        setRenaming(null);
                      }}
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
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
              )
            ) : (
              <button
                type="button"
                className="pages__item"
                aria-current={page.id === pageId ? "page" : undefined}
                onClick={() => {
                  editor.setPage(page.id);
                  onSelectPage?.();
                }}
                onDoubleClick={() => canEdit && setRenaming(page.id)}
                onContextMenu={
                  phone
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        openMenu(editor, {
                          kind: "page",
                          x: e.clientX,
                          y: e.clientY,
                          pageId: page.id,
                        });
                      }
                }
              >
                <span>{getProp(page.props, "name") || "Page"}</span>
                <span className="pages__count">{count || ""}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {phone ? null : (
        <Splitter
          axis="y"
          grows={1}
          value={shown}
          min={range.min}
          max={range.max}
          reset={PAGES.default}
          onResize={(next, remember) => {
            // Kept to what this window leaves room for, but not to the pages there are now: a
            // list dragged past its last page shows just its pages, and grows with new ones.
            const height = fit ? clampPages(next, PAGES.max, fit.room) : next;
            setPanelLayout(
              { pages: Math.round(Math.min(PAGES.max, Math.max(PAGES.min, height))) },
              { remember },
            );
          }}
          label="Resize the pages list"
          valueText={`${shown} pixels tall`}
          title="Drag to resize · double-click for the default height"
          className="pages-resizer"
        />
      )}
    </div>
  );
}
