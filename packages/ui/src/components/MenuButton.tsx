import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { assignRef } from "../lib/refs";
import { IconButton, type IconButtonProps } from "./IconButton";
import { Menu, type MenuCloseReason, type MenuItem } from "./Menu";

const MARGIN = 8;
/** Between the button and its menu. */
const GAP = 4;

export type DropdownAlign = "start" | "end";

/**
 * Where a dropdown of `size` opens from a button: below it, or above when
 * there's more room there, lined up with the button's start or end edge, and
 * kept inside the window.
 */
export function placeDropdown(
  anchor: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  align: DropdownAlign = "end",
): { left: number; top: number; side: "bottom" | "top" } {
  const roomBelow = viewport.height - MARGIN - (anchor.bottom + GAP);
  const roomAbove = anchor.top - GAP - MARGIN;
  const side = size.height <= roomBelow || roomBelow >= roomAbove ? "bottom" : "top";
  const top = side === "bottom" ? anchor.bottom + GAP : anchor.top - GAP - size.height;
  const left = align === "end" ? anchor.right - size.width : anchor.left;
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - size.width);
  const maxTop = Math.max(MARGIN, viewport.height - MARGIN - size.height);
  return {
    left: Math.round(Math.min(Math.max(MARGIN, left), maxLeft)),
    top: Math.round(Math.min(Math.max(MARGIN, top), maxTop)),
    side,
  };
}

export type DropdownCloseReason = MenuCloseReason | "outside";

export interface DropdownMenuProps {
  /** The button it opens from: it lines up with it, follows it, and gets focus back. */
  anchor: HTMLElement;
  items: readonly MenuItem[];
  /** Accessible name. */
  label: string;
  align?: DropdownAlign;
  /** Escape, Tab, a selection, or a pointer down outside it and its button. */
  onClose: (reason: DropdownCloseReason) => void;
  className?: string;
}

/**
 * A menu that drops from a button. It renders in a portal, so no scrolling
 * list or pane clips it and nothing beside it covers it; opens below the
 * button or above it, whichever has room; and follows the button as things
 * scroll. Escape and Tab give focus back to the button; choosing an item
 * leaves focus to whatever the item opens.
 */
export function DropdownMenu({
  anchor,
  items,
  label,
  align = "end",
  onClose,
  className,
}: DropdownMenuProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: string } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const reposition = useCallback(() => {
    const menu = el.current;
    if (!menu) return;
    if (!anchor.isConnected) {
      close.current("outside");
      return;
    }
    const next = placeDropdown(
      anchor.getBoundingClientRect(),
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      align,
    );
    setPlace((p) =>
      p && p.left === next.left && p.top === next.top && p.side === next.side ? p : next,
    );
  }, [anchor, align]);

  useLayoutEffect(reposition, [reposition]);

  useEffect(() => {
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reposition);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (el.current?.contains(target) || anchor.contains(target)) return;
      close.current("outside");
    };
    // Its own size changes too (items change, a font loads).
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    if (el.current) resized?.observe(el.current);
    // Capture: scrolling any list the button sits in moves it.
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      cancelAnimationFrame(frame);
      resized?.disconnect();
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, reposition]);

  return createPortal(
    <div
      ref={el}
      className={cx("dp-dropdown", className)}
      data-side={place?.side}
      // Hidden until measured, so it never flashes in the wrong place.
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <Menu
        label={label}
        items={items}
        autoFocus
        onClose={(reason) => {
          if (reason !== "select") anchor.focus({ preventScroll: true });
          close.current(reason);
        }}
      />
    </div>,
    document.body,
  );
}

export interface MenuButtonProps
  extends Omit<IconButtonProps, "icon" | "onClick" | "aria-haspopup" | "aria-expanded"> {
  items: readonly MenuItem[];
  /** Default "more". */
  icon?: IconName;
  /** The menu's accessible name; defaults to the button's label. */
  menuLabel?: string;
  /** Line the menu up with the button's start or end (default) edge. */
  align?: DropdownAlign;
  /** For hosts that keep something visible while the menu is open. */
  onOpenChange?: (open: boolean) => void;
}

/** An icon button that opens a dropdown menu: the "⋯" on cards, comments and list rows. */
export function MenuButton({
  items,
  icon = "more",
  label,
  menuLabel,
  align = "end",
  onOpenChange,
  ref,
  ...rest
}: MenuButtonProps) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <IconButton
        {...rest}
        ref={(node) => {
          setButton(node);
          assignRef(ref, node);
        }}
        icon={icon}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => change(!open)}
      />
      {open && button ? (
        <DropdownMenu
          anchor={button}
          items={items}
          label={menuLabel ?? label}
          align={align}
          onClose={() => change(false)}
        />
      ) : null}
    </>
  );
}
