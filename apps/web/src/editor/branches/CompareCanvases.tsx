/**
 * Main and the branch on screen together while reviewing (decision 0012):
 * side by side, under a swipe, or overlaid, with what changed outlined and
 * numbered as the review lists it. The branch side is the live editor, so it
 * stays editable; main's side is read-only.
 */
import type { Editor, Interaction } from "@drawpane/editor";
import { SegmentedControl, Switch } from "@drawpane/ui";
import { type CSSProperties, useRef, useSyncExternalStore } from "react";
import { Canvas } from "../Canvas";
import { EditorContext, useEditorStateOutside } from "../hooks";
import type { CompareMode, CompareState, CompareView } from "./compare";
import type { ReviewRow } from "./review";
import "./branches.css";
import { PASS_GESTURES } from "../canvas-gestures";

function useCompare<T>(compare: CompareView, select: (s: CompareState) => T): T {
  return useSyncExternalStore(compare.state.subscribe, () => select(compare.state.get()));
}

export function CompareCanvases({
  compare,
  live,
  liveInteraction,
  rows,
  active,
  labels,
  onPick,
}: {
  compare: CompareView;
  /** The branch's live editor and its interaction. */
  live: Editor;
  liveInteraction: Interaction;
  rows: readonly ReviewRow[];
  /** The change picked in the list, if any. */
  active: string | null;
  labels: { readonly main: string; readonly branch: string };
  onPick: (row: ReviewRow) => void;
}) {
  const mode = useCompare(compare, (s) => s.mode);
  const highlight = useCompare(compare, (s) => s.highlight);
  const swipe = useCompare(compare, (s) => s.swipe);
  const branchPage = useEditorStateOutside(live, (s) => s.pageId);
  // Read again whenever main's view changes (loading main sets its state too).
  const mainHasPage = useEditorStateOutside(compare.main, () =>
    branchPage ? compare.main.doc.has(branchPage) : true,
  );
  return (
    <div className="compare" data-mode={mode} style={{ "--swipe": String(swipe) } as CSSProperties}>
      <section className="compare__pane compare__pane--branch" aria-label={labels.branch}>
        <EditorContext.Provider value={live}>
          <Canvas interaction={liveInteraction} />
        </EditorContext.Provider>
        {highlight ? (
          <Marks editor={live} rows={rows} side="branch" active={active} onPick={onPick} />
        ) : null}
      </section>
      <section className="compare__pane compare__pane--main" aria-label={labels.main}>
        <EditorContext.Provider value={compare.main}>
          <Canvas interaction={compare.interaction} />
        </EditorContext.Provider>
        {highlight && mainHasPage ? (
          <Marks editor={compare.main} rows={rows} side="main" active={active} onPick={onPick} />
        ) : null}
        {mainHasPage ? null : <p className="compare__missing">This page is new on the branch.</p>}
      </section>
      {mode === "overlay" ? null : (
        <>
          <span className="compare__label compare__label--main">{labels.main}</span>
          <span className="compare__label compare__label--branch">{labels.branch}</span>
        </>
      )}
      {mode === "swipe" ? <SwipeHandle compare={compare} /> : null}
      {mode === "side" ? <span className="compare__divider" aria-hidden="true" /> : null}
    </div>
  );
}

/** The changes on one side, outlined, each with its number from the list. */
function Marks({
  editor,
  rows,
  side,
  active,
  onPick,
}: {
  editor: Editor;
  rows: readonly ReviewRow[];
  side: "main" | "branch";
  active: string | null;
  onPick: (row: ReviewRow) => void;
}) {
  // Redrawn as the view moves or the document changes.
  useEditorStateOutside(editor, (s) => s.camera);
  const pageId = useEditorStateOutside(editor, (s) => s.pageId);
  useSyncExternalStore(
    (notify) => editor.doc.subscribe(notify),
    () => editor.doc.version,
  );
  const camera = editor.s.camera;
  return (
    <div className="diff-marks">
      {rows.map((row, i) => {
        // What's added is only on the branch; what's removed only on main.
        if (side === "main" ? row.kind === "added" : row.kind === "removed") return null;
        const node = editor.doc.get(row.id);
        if (!node || node.type === "page" || editor.doc.pageOf(row.id)?.id !== pageId) return null;
        const b = editor.scene.bounds(row.id);
        if (!b) return null;
        const at = camera.toScreen({ x: b.x, y: b.y });
        return (
          <div
            key={row.key}
            className="diff-mark"
            data-kind={row.conflict ? "conflict" : row.kind}
            data-active={row.key === active || undefined}
            style={{
              left: at.x,
              top: at.y,
              width: b.width * camera.zoom,
              height: b.height * camera.zoom,
            }}
          >
            <button
              type="button"
              className="diff-mark__n"
              aria-label={`Change ${i + 1}: ${row.layer}, ${row.detail}`}
              onClick={() => onPick(row)}
            >
              {i + 1}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The line between main (left of it) and the branch, dragged across the canvas. */
function SwipeHandle({ compare }: { compare: CompareView }) {
  const handle = useRef<HTMLDivElement>(null);
  const swipe = useCompare(compare, (s) => s.swipe);
  const to = (clientX: number) => {
    const area = handle.current?.parentElement?.getBoundingClientRect();
    if (area && area.width > 0) compare.setSwipe((clientX - area.left) / area.width);
  };
  return (
    <div
      ref={handle}
      className="compare__swipe"
      role="slider"
      tabIndex={0}
      aria-label="Swipe between main and the branch"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(swipe * 100)}
      aria-valuetext={`${Math.round(swipe * 100)}% main`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        to(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) to(e.clientX);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        if (e.key === "ArrowLeft") compare.setSwipe(swipe - step);
        else if (e.key === "ArrowRight") compare.setSwipe(swipe + step);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="compare__grip" aria-hidden="true" />
    </div>
  );
}

const MODES: { value: CompareMode; label: string }[] = [
  { value: "side", label: "Side by side" },
  { value: "swipe", label: "Swipe" },
  { value: "overlay", label: "Overlay" },
];

/** How the two are shown, and whether changes are outlined. */
export function CompareBar({ compare }: { compare: CompareView }) {
  const mode = useCompare(compare, (s) => s.mode);
  const highlight = useCompare(compare, (s) => s.highlight);
  return (
    <div
      className="compare-bar pane"
      role="toolbar"
      aria-label="Compare with main"
      {...PASS_GESTURES}
    >
      <SegmentedControl
        label="Compare"
        options={MODES}
        value={mode}
        onChange={(v) => compare.setMode(v as CompareMode)}
      />
      <span className="compare-bar__divider" aria-hidden="true" />
      <Switch label="Highlight changes" checked={highlight} onChange={compare.setHighlight} />
    </div>
  );
}
