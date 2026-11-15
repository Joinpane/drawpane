import {
  type ComponentPropsWithRef,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { assignRef } from "../lib/refs";

export type PopoverSide = "left" | "right" | "bottom" | "top";

export interface PopoverProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  /** The element the popover opens beside; focus returns to it on close. */
  anchor: HTMLElement;
  /** Accessible name of the dialog. */
  label: string;
  /**
   * What it opens beside, when not the anchor itself: a button at a panel's
   * edge can open beside the whole panel, as Figma's type settings do. The
   * anchor still takes focus back and Escape. A popover opened from inside
   * another opens beside that one by default, so it never covers it.
   */
  beside?: HTMLElement | undefined;
  /** Preferred side; flips to the opposite side when there's no room. Default "left". */
  side?: PopoverSide;
  /** Gap between anchor and popover, px. Default 8. */
  offset?: number;
  /** Escape, a pointer down outside, or focus leaving to somewhere else. */
  onClose: () => void;
  /** Focus the first field on open. Default true. */
  autoFocus?: boolean;
  children: ReactNode;
}

/** A box in viewport pixels. */
export interface PopoverRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where popovers opened inside it may go, read when one is placed. The
 * inspector keeps its popovers over the canvas and off the selection; the
 * Selection Lens keeps its own between the panes.
 */
export interface PopoverRoom {
  /** Where they may go; the viewport when absent. */
  readonly bounds?: () => PopoverRect | null;
  /** What they keep clear of whenever some placement allows: the work being edited. */
  readonly avoid?: () => PopoverRect | null;
  /**
   * Calls back when `avoid` becomes something else (another layer is
   * selected), so open ones move; returns the unsubscribe function. Not as
   * it's edited, so a popover never moves out from under the pointer.
   */
  readonly subscribe?: (onChange: () => void) => () => void;
  /** Called as one opens; returns what to call as it closes. */
  readonly onOpen?: () => () => void;
}

/** Sets the room for every popover opened inside, nested ones included. */
export const PopoverRoomContext = createContext<PopoverRoom>({});

interface Registry {
  /** Registers a nested popover's element; returns the unregister function. */
  add(el: HTMLElement): () => void;
}

const PopoverContext = createContext<Registry | null>(null);
const MARGIN = 8;

const OPPOSITE: Record<PopoverSide, PopoverSide> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};
/** The other axis, tried when neither the side nor its opposite works. */
const ACROSS: Record<PopoverSide, readonly [PopoverSide, PopoverSide]> = {
  left: ["bottom", "top"],
  right: ["bottom", "top"],
  top: ["left", "right"],
  bottom: ["left", "right"],
};

const overlaps = (a: PopoverRect, b: PopoverRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Where a box of `size` goes beside `anchor` on `side`, kept inside the
 * viewport (or `room.bounds`): on `side`, else the opposite side, else the
 * other axis. With `room.avoid`, it first looks, in that order, for a side
 * that doesn't cover that box, then for one where sliding along the anchor's
 * edge clears it, then for one beside the anchor and that box together; when
 * none does, it places as without it.
 */
export function placePopover(
  anchor: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: PopoverSide,
  offset: number,
  room: { bounds?: PopoverRect | null | undefined; avoid?: PopoverRect | null | undefined } = {},
): { left: number; top: number; side: PopoverSide } {
  const bounds = room.bounds ?? { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const minX = bounds.left + MARGIN;
  const minY = bounds.top + MARGIN;
  const maxX = Math.max(minX, bounds.right - MARGIN - size.width);
  const maxY = Math.max(minY, bounds.bottom - MARGIN - size.height);
  const fits = (s: PopoverSide, r: PopoverRect = anchor) =>
    s === "left"
      ? r.left - offset - size.width >= minX
      : s === "right"
        ? r.right + offset + size.width <= bounds.right - MARGIN
        : s === "top"
          ? r.top - offset - size.height >= minY
          : r.bottom + offset + size.height <= bounds.bottom - MARGIN;
  const clampX = (x: number) => Math.min(Math.max(minX, x), maxX);
  const clampY = (y: number) => Math.min(Math.max(minY, y), maxY);
  const at = (s: PopoverSide, r: PopoverRect = anchor) =>
    s === "left" || s === "right"
      ? {
          left: clampX(s === "left" ? r.left - offset - size.width : r.right + offset),
          // Align tops, so the popover reads as coming from the row that opened it.
          top: clampY(anchor.top - MARGIN),
        }
      : {
          left: clampX(anchor.left),
          top: clampY(s === "top" ? r.top - offset - size.height : r.bottom + offset),
        };
  const box = (p: { left: number; top: number }): PopoverRect => ({
    ...p,
    right: p.left + size.width,
    bottom: p.top + size.height,
  });
  const done = (p: { left: number; top: number }, s: PopoverSide) => ({
    left: Math.round(p.left),
    top: Math.round(p.top),
    side: s,
  });

  const sides = [side, OPPOSITE[side], ...ACROSS[side]];
  const order = sides.filter((s) => fits(s));
  const avoid = room.avoid;
  if (avoid) {
    // Right beside the anchor on any side, before sliding along one.
    for (const s of order) {
      const p = at(s);
      if (!overlaps(box(p), avoid)) return done(p, s);
    }
    for (const s of order) {
      // To just before or after what it avoids, along the anchor's edge, whichever is nearer.
      const p = at(s);
      const across = s === "left" || s === "right" ? "top" : "left";
      const length = across === "top" ? size.height : size.width;
      const [lo, hi] = across === "top" ? [minY, maxY] : [minX, maxX];
      const before = (across === "top" ? avoid.top : avoid.left) - offset - length;
      const after = (across === "top" ? avoid.bottom : avoid.right) + offset;
      const slid = [before, after]
        .filter((v) => v >= lo - 0.5 && v <= hi + 0.5)
        .sort((a, b) => Math.abs(a - p[across]) - Math.abs(b - p[across]))[0];
      if (slid !== undefined) return done({ ...p, [across]: slid }, s);
    }
    // Out past it: beside the anchor and what it avoids together.
    const both = {
      left: Math.min(anchor.left, avoid.left),
      top: Math.min(anchor.top, avoid.top),
      right: Math.max(anchor.right, avoid.right),
      bottom: Math.max(anchor.bottom, avoid.bottom),
    };
    for (const s of sides) {
      if (!fits(s, both)) continue;
      const p = at(s, both);
      if (!overlaps(box(p), avoid)) return done(p, s);
    }
  }
  const chosen = fits(side)
    ? side
    : fits(OPPOSITE[side])
      ? OPPOSITE[side]
      : (ACROSS[side].find((s) => fits(s)) ?? side);
  return done(at(chosen), chosen);
}

/**
 * Keeps an element rendered elsewhere (a dropdown in its own portal) part of
 * the popover it was opened from: pressing in it doesn't close the popover.
 */
export function useInPopover(ref: RefObject<HTMLElement | null>): void {
  const parent = useContext(PopoverContext);
  useEffect(() => {
    const node = ref.current;
    if (!parent || !node) return;
    return parent.add(node);
  }, [parent, ref]);
}

/**
 * A non-modal dialog anchored to a control: pickers and small editors. It
 * renders in a portal so panes never clip it, follows its anchor as layout
 * changes, closes on Escape (in it, or on its anchor) or a pointer down
 * outside, and returns focus to the anchor. Popovers opened from inside another stay part of it, so using a
 * nested color picker never closes the effect editor that opened it, and
 * open beside it rather than over it. `PopoverRoomContext` says where they may go.
 */
export function Popover({
  anchor,
  beside,
  label,
  side = "left",
  offset = MARGIN,
  onClose,
  autoFocus = true,
  className,
  style,
  children,
  ref,
  ...rest
}: PopoverProps) {
  const parent = useContext(PopoverContext);
  const room = useContext(PopoverRoomContext);
  const el = useRef<HTMLDivElement | null>(null);
  const nested = useRef(new Set<HTMLElement>());
  const [place, setPlace] = useState<{ left: number; top: number; side: PopoverSide } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const registry = useMemo<Registry>(
    () => ({
      add(child) {
        nested.current.add(child);
        const fromParent = parent?.add(child);
        return () => {
          nested.current.delete(child);
          fromParent?.();
        };
      },
    }),
    [parent],
  );

  // Belong to the popover that opened this one.
  useLayoutEffect(() => {
    if (!el.current || !parent) return;
    return parent.add(el.current);
  }, [parent]);

  useEffect(() => room.onOpen?.(), [room]);

  // Opened from inside another popover: beside that one, so it stays readable.
  const nextTo = beside ?? anchor.closest<HTMLElement>(".dp-popover") ?? undefined;

  const position = useCallback(() => {
    const node = el.current;
    if (!node) return;
    const next = placePopover(
      (nextTo ?? anchor).getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      side,
      offset,
      { bounds: room.bounds?.(), avoid: room.avoid?.() },
    );
    setPlace((p) =>
      p && p.left === next.left && p.top === next.top && p.side === next.side ? p : next,
    );
  }, [anchor, nextTo, side, offset, room]);

  useLayoutEffect(() => {
    position();
    const node = el.current;
    const observer = new ResizeObserver(position);
    if (node) observer.observe(node);
    observer.observe(anchor);
    if (nextTo) observer.observe(nextTo);
    window.addEventListener("resize", position);
    // Panes scroll: follow the anchor (capture catches scrolls of any ancestor).
    window.addEventListener("scroll", position, true);
    const unsubscribe = room.subscribe?.(position);
    return () => {
      unsubscribe?.();
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, nextTo, position, room]);

  useEffect(() => {
    const inside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      if (el.current?.contains(target) || anchor.contains(target)) return true;
      for (const child of nested.current) if (child.contains(target)) return true;
      return false;
    };
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchor]);

  // Opened without taking focus (autoFocus off), the anchor keeps it: Escape there closes this
  // too, and goes no further, so the canvas doesn't also take it (to deselect).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    anchor.addEventListener("keydown", onKey);
    return () => anchor.removeEventListener("keydown", onKey);
  }, [anchor]);

  // Focus in on open; back to the anchor on close if focus was inside.
  useEffect(() => {
    const node = el.current;
    if (autoFocus && node) {
      const first = node.querySelector<HTMLElement>(
        "[data-autofocus], input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      (first ?? node).focus({ preventScroll: true });
    }
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) {
        anchor.focus({ preventScroll: true });
      }
    };
  }, [anchor, autoFocus]);

  return createPortal(
    <PopoverContext.Provider value={registry}>
      <div
        {...rest}
        ref={(node) => {
          el.current = node;
          assignRef(ref, node);
        }}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className={cx("dp-popover", className)}
        data-side={place?.side ?? side}
        style={{
          ...style,
          left: place?.left ?? -9999,
          top: place?.top ?? -9999,
          // Measured before it's placed: invisible but focusable (unlike visibility: hidden).
          opacity: place ? undefined : 0,
        }}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            // The canvas listens for Escape (deselect): this one is ours.
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            close.current();
          }
        }}
      >
        {children}
      </div>
    </PopoverContext.Provider>,
    document.body,
  );
}
