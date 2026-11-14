import {
  type Editor,
  type ExplainAction,
  type ExplainAxis,
  type ExplainTerm,
  explainSize,
} from "@drawpane/editor";
import { Button, Icon, IconButton, KIND_ICONS } from "@drawpane/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDocVersion, useEditor, useEditorState } from "./hooks";
import { kindOf } from "./layer-tree";
import { type Box, type LensSide, lensObstacles, placeLens } from "./lens-placement";

/** Clear of the top bar and the zoom bar, like the Lens. */
const TOP = 64;
const BOTTOM = 56;
const MARGIN = 8;
const ESTIMATE = { width: 300, height: 220 };
/** Beside the selection first: under it is where the size pill and the next layer are. */
const ORDER: readonly LensSide[] = ["right", "left", "below", "above", "inside"];

const n = (v: number) => String(Math.round(v * 100) / 100);

/** A term's share of the size, signed when it's taken away. */
function shown(term: ExplainTerm): string {
  if (term.kind === "hidden") return "0";
  return term.value < 0 ? `−${n(-term.value)}` : n(term.value);
}

/**
 * Explain: why the selected layer is the size it is, beside it on the
 * canvas. The question, the rule that decides it, each part of the sum
 * (colour-coded like X-ray: padding yellow, gaps pink, layers purple) and the
 * sum itself, then the fixes that make sense: set it by hand, hug, or select
 * the layers that make it up. Opened from the size pill, ⌥E or the command
 * bar; Esc or a new selection closes it.
 */
export function ExplainCard() {
  const editor = useEditor();
  useDocVersion();
  const explain = useEditorState((s) => s.explain);
  const camera = useEditorState((s) => s.camera);
  const viewport = useEditorState((s) => s.viewport);
  const gesture = useEditorState((s) => s.gesture);
  const canEdit = useEditorState((s) => s.role !== "viewer");
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(ESTIMATE);
  const [bounds, setBounds] = useState({ left: 0, right: Number.POSITIVE_INFINITY });
  const previous = useRef<LensSide | null>(null);

  // Esc closes it before anything else hears the key (it would clear the selection).
  useEffect(() => {
    if (!explain) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      editor.state.set({ explain: null });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, explain]);
  useEffect(() => {
    if (!explain) previous.current = null;
  }, [explain]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      Math.abs(el.offsetWidth - size.width) > 0.5 ||
      Math.abs(el.offsetHeight - size.height) > 0.5
    )
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    const host = (el.offsetParent ?? document.body).getBoundingClientRect();
    const leftPane = document.querySelector(".pane--left")?.getBoundingClientRect();
    const rightPane = document.querySelector(".pane--right")?.getBoundingClientRect();
    const left = leftPane ? leftPane.right - host.left : 0;
    const right = rightPane ? rightPane.left - host.left : Number.POSITIVE_INFINITY;
    if (left !== bounds.left || right !== bounds.right) setBounds({ left, right });
  });

  if (!explain || gesture) return null;
  const explanation = explainSize(editor.doc, explain.id, explain.axis);
  const world = editor.scene.bounds(explain.id);
  if (!explanation || !world) return null;

  const toScreen = (r: Box): Box => {
    const a = camera.toScreen({ x: r.x, y: r.y });
    const b = camera.toScreen({ x: r.x + r.width, y: r.y + r.height });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const right = Math.min(bounds.right, viewport.width);
  const placement = placeLens({
    target: toScreen(world),
    size,
    area: {
      x: bounds.left + MARGIN,
      y: TOP,
      width: right - MARGIN - (bounds.left + MARGIN),
      height: viewport.height - BOTTOM - TOP,
    },
    obstacles: lensObstacles(editor.doc, editor.scene, explain.id).map(toScreen),
    previous: previous.current,
    order: ORDER,
  });
  if (!placement) return null;
  previous.current = placement.side;

  const other: ExplainAxis = explain.axis === "width" ? "height" : "width";
  const otherExplanation = explainSize(editor.doc, explain.id, other);
  const actions = explanation.actions.filter((a) => canEdit || a.kind === "select");
  const close = () => editor.state.set({ explain: null });
  const titleId = `explain-${explain.id}`;

  return (
    <div
      ref={ref}
      className="explain-anchor"
      data-side={placement.side}
      style={{ left: placement.x, top: placement.y }}
    >
      <section className="explain" role="dialog" aria-labelledby={titleId}>
        <header className="explain__head">
          <div className="explain__titles">
            <h2 id={titleId} className="explain__question">
              {explanation.question}
            </h2>
            <p className="explain__answer">{explanation.answer}</p>
          </div>
          <IconButton icon="close" label="Close explanation" shortcut="Esc" onClick={close} />
        </header>

        {explanation.terms.length > 0 ? (
          <ol className="explain__terms" aria-label={`How the ${explain.axis} adds up`}>
            {explanation.terms.map((term) => (
              <li key={term.label}>
                <Term editor={editor} term={term} />
              </li>
            ))}
          </ol>
        ) : null}

        {explanation.formula ? (
          <p className="explain__sum">
            <span className="explain__formula">{explanation.formula}</span>
            <b className="explain__total">= {n(explanation.size)}</b>
          </p>
        ) : null}

        {otherExplanation ? (
          <button
            type="button"
            className="explain__other"
            onClick={() => editor.state.set({ explain: { id: explain.id, axis: other } })}
            title={`Explain the ${other}`}
          >
            <span>{otherExplanation.answer}</span>
            <Icon name="chevron-right" size={12} />
          </button>
        ) : null}

        {actions.length > 0 ? (
          <footer className="explain__actions">
            {actions.map((action, i) => (
              <ActionButton
                key={action.label}
                editor={editor}
                id={explain.id}
                axis={explain.axis}
                action={action}
                primary={i === 0}
              />
            ))}
          </footer>
        ) : null}
      </section>
    </div>
  );
}

/** One part of the sum. Parts made of layers select them, and point them out on hover. */
function Term({ editor, term }: { editor: Editor; term: ExplainTerm }) {
  const content = (
    <>
      <span className="explain__dot" data-kind={term.kind} aria-hidden="true" />
      <span className="explain__label">{term.label}</span>
      <span className="explain__value">{shown(term)}</span>
    </>
  );
  const ids = term.ids;
  if (!ids || ids.length === 0) return <div className="explain__term">{content}</div>;
  return (
    <button
      type="button"
      className="explain__term explain__term--layers"
      title={ids.length > 1 ? `Select these ${ids.length} layers` : "Select this layer"}
      onPointerEnter={() => editor.state.set({ hover: ids[0] as string })}
      onPointerLeave={() => editor.state.set({ hover: null })}
      onClick={() => {
        editor.state.set({ hover: null });
        editor.select([...ids]);
      }}
    >
      {content}
    </button>
  );
}

function ActionButton({
  editor,
  id,
  axis,
  action,
  primary,
}: {
  editor: Editor;
  id: string;
  axis: ExplainAxis;
  action: ExplainAction;
  primary: boolean;
}) {
  const sizing = axis === "width" ? "sizingH" : "sizingV";
  if (action.kind === "select") {
    const first = editor.doc.get(action.ids[0] as string);
    return (
      <Button
        size="sm"
        variant="ghost"
        {...(first ? { icon: KIND_ICONS[kindOf(first)] } : {})}
        onClick={() => editor.select([...action.ids])}
      >
        {action.label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant={primary ? "secondary" : "ghost"}
      onClick={() =>
        editor.setProp([id], sizing, action.kind === "fix" ? "fixed" : "hug", action.label)
      }
    >
      {action.label}
    </Button>
  );
}
