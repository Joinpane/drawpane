/**
 * Reordering a list of a layer's items in the inspector (fills, strokes,
 * effects, layout grids), as in Figma: drag a row and the others make room;
 * let go and the list takes the new order, as one step to undo. Alt+↑ and
 * Alt+↓ move the focused row, so it's done without a pointer too.
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

/** `list` with the item at `from` moved to `to` (the others keep their order). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/** Where the item at `index` is after the one at `from` moved to `to`. */
export function remapIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < index && index <= to) return index - 1;
  if (to <= index && index < from) return index + 1;
  return index;
}

/** How far a press must travel before it's a drag, not a click. */
const THRESHOLD = 4;

/** What keeps its own pointer and arrows: typing, selecting text, scrubbing a number. */
const FIELDS = "input, textarea, select, [contenteditable], .dp-field__label, .dp-field__unit";

const focusables = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0,
  );

interface Drag {
  readonly pointerId: number;
  /** The row's place in the list as shown (top first). */
  readonly from: number;
  readonly startY: number;
  /** Rows' boxes when the drag started, as shown. */
  readonly tops: readonly number[];
  readonly heights: readonly number[];
}

/**
 * A list of rows that can be dragged into a new order. `order` gives the
 * items' indices as the list shows them, top first (a paint list shows the
 * topmost paint first); `onMove` gets indices in the items themselves.
 */
export function useReorder({
  order,
  onMove,
  disabled = false,
}: {
  order: readonly number[];
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
}) {
  const rows = useRef(new Map<number, HTMLElement>());
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const pending = useRef<{ pointerId: number; from: number; startY: number } | null>(null);
  const active = useRef<Drag | null>(null);
  const latest = useRef({ order, onMove });
  latest.current = { order, onMove };

  // How far the dragged row has gone: with the pointer, but not out of the list.
  const travel = (d: Drag, y: number) => {
    const last = d.tops.length - 1;
    const top = d.tops[d.from] as number;
    const above = (d.tops[0] as number) - top;
    const below =
      (d.tops[last] as number) + (d.heights[last] as number) - top - (d.heights[d.from] as number);
    return Math.min(below, Math.max(above, y - d.startY));
  };

  // Where the dragged row would land, `dy` from where it was: past the middle of
  // each row it has crossed. From the pointer's travel, not the row's, which
  // stops at the list's ends.
  const targetOf = (d: Drag, dy: number) => {
    const middle = (d.tops[d.from] as number) + (d.heights[d.from] as number) / 2 + dy;
    let to = d.from;
    for (let i = d.from + 1; i < d.tops.length; i++)
      if (middle > (d.tops[i] as number) + (d.heights[i] as number) / 2) to = i;
    for (let i = d.from - 1; i >= 0; i--)
      if (middle < (d.tops[i] as number) + (d.heights[i] as number) / 2) to = i;
    return to;
  };

  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const p = pending.current;
      if (p && p.pointerId === e.pointerId && !active.current) {
        if (Math.abs(e.clientY - p.startY) < THRESHOLD) return;
        // A drag now: measure the rows as they stand.
        const boxes = latest.current.order.map((_, i) =>
          rows.current.get(i)?.getBoundingClientRect(),
        );
        if (boxes.some((b) => !b)) return;
        active.current = {
          pointerId: p.pointerId,
          from: p.from,
          startY: p.startY,
          tops: boxes.map((b) => (b as DOMRect).top),
          heights: boxes.map((b) => (b as DOMRect).height),
        };
        document.documentElement.classList.add("dp-reordering");
        // Its cursor, and no hover on what it passes over.
        try {
          rows.current.get(p.from)?.setPointerCapture(p.pointerId);
        } catch {
          // Gone already: the window still hears the pointer.
        }
        window.getSelection()?.removeAllRanges();
      }
      const d = active.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault();
      setDrag({ from: d.from, to: targetOf(d, e.clientY - d.startY), dy: travel(d, e.clientY) });
    };
    const end = (e: globalThis.PointerEvent) => {
      if (pending.current?.pointerId === e.pointerId) pending.current = null;
      const d = active.current;
      if (!d || d.pointerId !== e.pointerId) return;
      active.current = null;
      document.documentElement.classList.remove("dp-reordering");
      const to = targetOf(d, e.clientY - d.startY);
      setDrag(null);
      // The press was a drag: its click (on the row's button) isn't a click.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (e.type === "pointerup" && to !== d.from) {
        const { order: o, onMove: commit } = latest.current;
        commit(o[d.from] as number, o[to] as number);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("dp-reordering");
    };
  }, []);

  /** Props for the row shown at `position` (top first). */
  const rowProps = (position: number) => {
    let style: CSSProperties | undefined;
    if (drag) {
      const d = active.current;
      const gap =
        d && d.tops.length > 1
          ? (d.tops[1] as number) - (d.tops[0] as number) - (d.heights[0] as number)
          : 0;
      const room = d ? (d.heights[drag.from] as number) + gap : 0;
      if (position === drag.from) style = { transform: `translateY(${drag.dy}px)` };
      else if (drag.from < position && position <= drag.to)
        style = { transform: `translateY(${-room}px)` };
      else if (drag.to <= position && position < drag.from)
        style = { transform: `translateY(${room}px)` };
    }
    return {
      ref: (el: HTMLElement | null) => {
        if (el) rows.current.set(position, el);
        else rows.current.delete(position);
      },
      style,
      "data-reorderable": !disabled && order.length > 1 ? "" : undefined,
      "data-reorder": drag ? (position === drag.from ? "dragging" : "shifting") : undefined,
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (disabled || e.button !== 0 || order.length < 2) return;
        // Fields keep their own pointer: selecting text, scrubbing a number.
        if ((e.target as Element).closest(FIELDS)) return;
        pending.current = { pointerId: e.pointerId, from: position, startY: e.clientY };
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (disabled || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        // In a field, Alt+arrows step its value by a tenth.
        if ((e.target as Element).closest(FIELDS)) return;
        const to = position + (e.key === "ArrowUp" ? -1 : 1);
        if (to < 0 || to >= order.length) return;
        e.preventDefault();
        // Keep the keyboard on the same control, in the row's new place.
        const row = rows.current.get(position);
        const at = row ? focusables(row).indexOf(e.target as HTMLElement) : -1;
        onMove(order[position] as number, order[to] as number);
        requestAnimationFrame(() => {
          const moved = rows.current.get(to);
          if (moved) focusables(moved)[Math.max(0, at)]?.focus();
        });
      },
    };
  };

  return { rowProps, reordering: drag !== null };
}

/** What a reorderable row spreads onto its element. */
export type ReorderRowProps = ReturnType<ReturnType<typeof useReorder>["rowProps"]>;
