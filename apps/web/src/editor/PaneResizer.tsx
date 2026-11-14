/**
 * The grip on a side panel's inner edge: drag it to make the panel wider or
 * narrower, double-click it for the default width. It's a focusable
 * separator too: ← and → change the width (⇧ for bigger steps), Home and End
 * go to the narrowest and widest, Enter to the default.
 */
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { clampPane, PANE, type PaneSide, setPanelLayout } from "./panel-layout";

const STEP = 8;
const BIG_STEP = 32;

export function PaneResizer({
  side,
  label,
  width: shown,
  viewportWidth,
  other,
}: {
  side: PaneSide;
  /** What the panel is, for "Resize the layers panel". */
  label: string;
  /** The panel's width as shown. */
  width: number;
  viewportWidth: number;
  /** The other panel's width while it's open, 0 when it isn't: the canvas keeps room between them. */
  other: number;
}) {
  const drag = useRef<{
    x: number;
    width: number;
    frame: number;
    next: number;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => clampPane(w, viewportWidth, other);
  // The right panel grows leftwards: dragging left makes it wider.
  const sign = side === "left" ? 1 : -1;

  const set = (next: number, remember = true) =>
    setPanelLayout({ [side]: clamp(next) }, { remember });

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width: shown, frame: 0, next: shown, moved: false };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.next = d.width + (e.clientX - d.x) * sign;
    d.moved ||= e.clientX !== d.x;
    // At most once a frame: everything beside the panel follows it.
    if (!d.frame)
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        set(d.next, false);
      });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
    // A press without a drag changes nothing: the saved width stays (it may be wider than
    // this window shows).
    if (d.moved) set(d.next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const by = { ArrowLeft: -step * sign, ArrowRight: step * sign }[e.key];
    if (by !== undefined) set(shown + by);
    else if (e.key === "Home") set(PANE.min);
    else if (e.key === "End") set(PANE.max);
    else if (e.key === "Enter") set(PANE.default);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't take focus or be dragged; this is the ARIA window splitter pattern.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label}`}
      aria-valuemin={PANE.min}
      aria-valuemax={clamp(PANE.max)}
      aria-valuenow={shown}
      aria-valuetext={`${shown} pixels wide`}
      tabIndex={0}
      title="Drag to resize · double-click for the default width"
      className={`pane-resizer pane-resizer--${side}`}
      data-dragging={dragging || undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => set(PANE.default)}
      onKeyDown={onKey}
    />
  );
}
