/**
 * A grip between two parts of the UI that sets the size of one of them: the
 * ARIA window splitter. Drag it (one update a frame, the pointer captured so
 * it can leave the grip), double-click it for the default size, or focus it
 * and use the arrow keys along its axis (⇧ for bigger steps), Home and End
 * for the smallest and largest, Enter for the default. While a drag is going
 * the whole page keeps the resize cursor and nothing gets text-selected.
 * The caller keeps the size in range and decides what's remembered.
 */
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

const STEP = 8;
const BIG_STEP = 32;

export type SplitterAxis = "x" | "y";

const KEYS = {
  x: { less: "ArrowLeft", more: "ArrowRight" },
  y: { less: "ArrowUp", more: "ArrowDown" },
} as const;

export function Splitter({
  axis,
  grows,
  value,
  min,
  max,
  reset,
  onResize,
  label,
  valueText,
  title,
  className,
}: {
  /** The direction the grip moves in: "x" for a vertical line between side-by-side parts. */
  axis: SplitterAxis;
  /** 1 when moving the grip right or down makes the part bigger, -1 when left or up does. */
  grows: 1 | -1;
  /** The size as shown. */
  value: number;
  min: number;
  max: number;
  /** The size a double-click or Enter goes back to. */
  reset: number;
  /** A new size, not yet in range; `remember` is false while a drag is still going. */
  onResize: (size: number, remember: boolean) => void;
  /** "Resize the layers panel". */
  label: string;
  valueText: string;
  title: string;
  className: string;
}) {
  const drag = useRef<{
    at: number;
    size: number;
    frame: number;
    next: number;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const keys = KEYS[axis];
  const coord = (e: PointerEvent) => (axis === "x" ? e.clientX : e.clientY);

  // The resize cursor everywhere while dragging, even off the grip; gone if the grip goes mid-drag.
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.dataset.resizing = axis;
    return () => {
      delete root.dataset.resizing;
    };
  }, [dragging, axis]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { at: coord(e), size: value, frame: 0, next: value, moved: false };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const at = coord(e);
    d.next = d.size + (at - d.at) * grows;
    d.moved ||= at !== d.at;
    // At most once a frame: everything beside the part follows it.
    if (!d.frame)
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        onResize(d.next, false);
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
    // A press without a drag changes nothing: the saved size stays (it may be bigger than
    // this window shows).
    if (d.moved) onResize(d.next, true);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const by = { [keys.less]: -step * grows, [keys.more]: step * grows }[e.key];
    if (by !== undefined) onResize(value + by, true);
    else if (e.key === "Home") onResize(min, true);
    else if (e.key === "End") onResize(max, true);
    else if (e.key === "Enter") onResize(reset, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't take focus or be dragged; this is the ARIA window splitter pattern.
    <div
      role="separator"
      // The line's own direction: a grip that moves along x is a vertical line.
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      tabIndex={0}
      title={title}
      className={className}
      data-dragging={dragging || undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => onResize(reset, true)}
      onKeyDown={onKey}
    />
  );
}
