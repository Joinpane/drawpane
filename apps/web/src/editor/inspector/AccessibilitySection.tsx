/**
 * Accessibility at selection (PRD). A layer the prototype taps, on a phone
 * or tablet board, that's smaller than a comfortable tap target says so,
 * with a fix that grows it. A board shows its reading order: how a screen
 * reader and keyboard focus move through it, which can be reordered, shown
 * on the canvas, and copied for a handoff. See the editor's accessibility.ts
 * and reading-order.ts.
 */
import { type Editor, readingOrderOf, readingOrderText, tapTargetIssue } from "@drawpane/editor";
import { getProp, type NodeRecord } from "@drawpane/model";
import { Button, Icon, IconButton, PropertySection, Switch } from "@drawpane/ui";
import { useRef } from "react";
import { useCopy } from "../../app/CopyField";
import { useDeferredDocVersion, useEditor, useEditorState } from "../hooks";

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function AccessibilitySection({ nodes }: { nodes: readonly NodeRecord[] }) {
  const editor = useEditor();
  useDeferredDocVersion();
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (!only) return null;
  const issue = tapTargetIssue(editor, only.id);
  const board = only.type === "frame" && only.parent === editor.s.pageId;
  if (!issue && !board) return null;
  return (
    <PropertySection title="Accessibility">
      {issue ? (
        <>
          <div className="a11y-note" role="note">
            <Icon name="warning" size={12} />
            <span>
              Tapped, but {n(issue.width)} × {n(issue.height)}. On touch screens, make tap targets
              at least {issue.min} × {issue.min}.
            </span>
          </div>
          {issue.growable && editor.canEdit ? (
            <Button size="sm" onClick={() => editor.growTapTarget(only.id)}>
              Grow to {issue.min} × {issue.min}
            </Button>
          ) : null}
        </>
      ) : null}
      {board ? <ReadingOrder editor={editor} board={only} /> : null}
    </PropertySection>
  );
}

function ReadingOrder({ editor, board }: { editor: Editor; board: NodeRecord }) {
  const shown = useEditorState((s) => s.showReadingOrder);
  const [copied, copy] = useCopy<"order">();
  const order = readingOrderOf(editor, board.id);
  const name = getProp(board.props, "name") || "Board";
  const count = order.items.length;
  const list = useRef<HTMLOListElement>(null);
  /**
   * Moves a stop and keeps keyboard focus with it: on the same button, or on the other
   * one when it reached an end (a disabled button would drop focus onto the page).
   */
  const move = (id: string, delta: number) => {
    const focused = list.current?.contains(document.activeElement) ?? false;
    editor.moveInReadingOrder(board.id, id, delta);
    if (!focused) return;
    requestAnimationFrame(() => {
      const row = list.current?.querySelector(`[data-reading-id="${CSS.escape(id)}"]`);
      const same = row?.querySelector<HTMLButtonElement>(
        `button[data-move="${delta < 0 ? "earlier" : "later"}"]:not(:disabled)`,
      );
      (same ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
  };
  return (
    <div className="reading-order">
      <div className="reading-order__head">
        <span className="reading-order__title">Reading order</span>
        <span className="reading-order__source">
          {count === 0 ? "" : order.custom ? "Set by hand" : "From the layout"}
        </span>
      </div>
      {count === 0 ? (
        <p className="reading-order__empty">
          Nothing to read yet: text, and layers the prototype taps, appear here.
        </p>
      ) : (
        <ol ref={list} className="reading-order__list" aria-label={`Reading order of ${name}`}>
          {order.items.map((item, i) => (
            <li
              key={item.id}
              data-reading-id={item.id}
              className="reading-order__item"
              onPointerEnter={() => editor.state.set({ hover: item.id })}
              onPointerLeave={() => editor.state.set({ hover: null })}
            >
              <span className="reading-order__n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="reading-order__name" title={item.name}>
                {item.name}
              </span>
              <span className="reading-order__role">{item.role}</span>
              {editor.canEdit ? (
                <span className="reading-order__moves">
                  <IconButton
                    icon="arrow-up"
                    size="sm"
                    label={`Move ${item.name} earlier`}
                    data-move="earlier"
                    disabled={i === 0}
                    onClick={() => move(item.id, -1)}
                  />
                  <IconButton
                    icon="arrow-down"
                    size="sm"
                    label={`Move ${item.name} later`}
                    data-move="later"
                    disabled={i === count - 1}
                    onClick={() => move(item.id, 1)}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <Switch
        label="Show on canvas"
        checked={shown}
        onChange={(on) => editor.state.set({ showReadingOrder: on })}
      />
      {count > 0 ? (
        <div className="reading-order__actions">
          <Button size="sm" onClick={() => void copy(readingOrderText(order, name), "order")}>
            {copied ? "Copied" : "Copy as list"}
          </Button>
          {order.custom && editor.canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor.setReadingOrder(board.id, null)}
            >
              Use layout order
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
