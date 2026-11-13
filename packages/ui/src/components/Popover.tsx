import {
  type ComponentPropsWithRef,
  createContext,
  type ReactNode,
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

interface Registry {
  /** Registers a nested popover's element; returns the unregister function. */
  add(el: HTMLElement): () => void;
}

const PopoverContext = createContext<Registry | null>(null);
const MARGIN = 8;

/** Where a box of `size` goes beside `anchor` on `side`, kept inside the viewport. */
export function placePopover(
  anchor: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: PopoverSide,
  offset: number,
): { left: number; top: number; side: PopoverSide } {
  const fits = (s: PopoverSide) =>
    s === "left"
      ? anchor.left - offset - size.width >= MARGIN
      : s === "right"
        ? anchor.right + offset + size.width <= viewport.width - MARGIN
        : s === "top"
          ? anchor.top - offset - size.height >= MARGIN
          : anchor.bottom + offset + size.height <= viewport.height - MARGIN;
  const opposite: Record<PopoverSide, PopoverSide> = {
    left: "right",
    right: "left",
    top: "bottom",
    bottom: "top",
  };
  const chosen = fits(side) || !fits(opposite[side]) ? side : opposite[side];
  let left: number;
  let top: number;
  if (chosen === "left" || chosen === "right") {
    left = chosen === "left" ? anchor.left - offset - size.width : anchor.right + offset;
    // Align tops, so the popover reads as coming from the row that opened it.
    top = anchor.top - MARGIN;
  } else {
    top = chosen === "top" ? anchor.top - offset - size.height : anchor.bottom + offset;
    left = anchor.left;
  }
  const clampX = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const clampY = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  return {
    left: Math.round(Math.min(Math.max(MARGIN, left), clampX)),
    top: Math.round(Math.min(Math.max(MARGIN, top), clampY)),
    side: chosen,
  };
}

/**
 * A non-modal dialog anchored to a control: pickers and small editors. It
 * renders in a portal so panes never clip it, follows its anchor as layout
 * changes, closes on Escape or a pointer down outside, and returns focus to
 * the anchor. Popovers opened from inside another stay part of it, so using a
 * nested color picker never closes the effect editor that opened it.
 */
export function Popover({
  anchor,
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

  const position = useCallback(() => {
    const node = el.current;
    if (!node) return;
    const next = placePopover(
      anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      side,
      offset,
    );
    setPlace((p) =>
      p && p.left === next.left && p.top === next.top && p.side === next.side ? p : next,
    );
  }, [anchor, side, offset]);

  useLayoutEffect(() => {
    position();
    const node = el.current;
    const observer = new ResizeObserver(position);
    if (node) observer.observe(node);
    observer.observe(anchor);
    window.addEventListener("resize", position);
    // Panes scroll: follow the anchor (capture catches scrolls of any ancestor).
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, position]);

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
          visibility: place ? undefined : "hidden",
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
