/**
 * The file's pages, above the layers: pick one, double-click to rename,
 * right-click for its menu. The line below the list moves, like Figma's: drag
 * it (or focus it and use ↑ and ↓) to show more pages or more layers. The
 * list is never taller than its pages, and the layers always keep some room.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { IconButton } from "@drawpane/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { clampPages, PAGES, pagesRange, setPanelLayout, usePanelLayout } from "./panel-layout";
import { Splitter } from "./Splitter";
import { openMenu, uiFor, useUi } from "./ui-state";

/** How tall all the pages are, and the height the list and the layers share. */
interface Fit {
  readonly content: number;
  readonly room: number;
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

  const chosen = usePanelLayout().pages;
  const section = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);

  // Measured after every render (pages come and go, a rename's field is shorter than a row)
  // and whenever the panel's height changes: before paint, so the list never shows a wrong height.
  const measure = useRef(() => {});
  measure.current = () => {
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
    const pane = section.current?.parentElement;
    if (!pane) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

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
    <div className="pages" ref={section}>
      <div className="pane__head">
        <span className="pane__label">Pages</span>
        {canEdit ? (
          <IconButton icon="plus" label="Add page" onClick={() => editor.addPage()} />
        ) : null}
      </div>
      <ul className="pages__list" aria-label="Pages" ref={list} style={{ maxHeight: shown }}>
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
    </div>
  );
}
