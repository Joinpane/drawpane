import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { Menu, type MenuActionItem, type MenuHeading, type MenuSeparator } from "./Menu";

/** A menu item that may open a submenu of its own. */
export interface ContextMenuAction extends Omit<MenuActionItem, "submenu"> {
  /** Items of a submenu that opens beside this one on hover, → or Enter. */
  items?: readonly ContextMenuEntry[];
}

export type ContextMenuEntry = ContextMenuAction | MenuSeparator | MenuHeading;

export interface ContextMenuProps {
  /** Where it opens, in viewport coordinates (the pointer for a right-click). */
  at: { readonly x: number; readonly y: number };
  items: readonly ContextMenuEntry[];
  /** Accessible name. */
  label: string;
  /** Escape, a selection, a click outside, scrolling or the window losing focus. */
  onClose: () => void;
  className?: string;
}

const MARGIN = 8;
/** How long the pointer rests on an item before its submenu opens. */
const HOVER_OPEN_MS = 120;

function isAction(entry: ContextMenuEntry | undefined): entry is ContextMenuAction {
  return entry !== undefined && !("separator" in entry) && !("heading" in entry);
}

/** Where a menu of `size` opening at `at` fits, flipping left or up at the window's edges. */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  /** For submenus: the parent item's left edge, to flip to when there's no room on the right. */
  flipX?: number,
): { left: number; top: number } {
  let left = at.x;
  if (left + size.width > viewport.width - MARGIN)
    left = flipX !== undefined ? flipX - size.width : viewport.width - MARGIN - size.width;
  let top = at.y;
  if (top + size.height > viewport.height - MARGIN)
    top = Math.max(MARGIN, viewport.height - MARGIN - size.height);
  return { left: Math.max(MARGIN, Math.round(left)), top: Math.max(MARGIN, Math.round(top)) };
}

/**
 * A right-click menu: opens at a point, keeps inside the window, and cascades
 * into submenus (hover, → or Enter opens one; ← or Escape closes it). Picking
 * an item, Escape at the top level, a click outside, a scroll or leaving the
 * window closes it all. Focus returns to where it was.
 */
export function ContextMenu({ at, items, label, onClose, className }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) close.current();
    };
    const dismiss = () => close.current();
    // Capture, so a click on the canvas closes the menu before it acts.
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", dismiss);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: swallows the browser's own menu inside ours
    <div
      ref={root}
      className={cx("dp-context-menu", className)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuLevel
        at={at}
        items={items}
        label={label}
        focus={false}
        onCloseAll={() => close.current()}
      />
    </div>,
    document.body,
  );
}

function MenuLevel({
  at,
  items,
  label,
  focus,
  onCloseAll,
  onBack,
  onHover,
  flipX,
}: {
  at: { x: number; y: number };
  items: readonly ContextMenuEntry[];
  label: string;
  /** Move focus into this level (keyboard opened it); hover leaves focus where it is. */
  focus: boolean;
  onCloseAll: () => void;
  /** Set on submenus: ← and Escape come back here. */
  onBack?: () => void;
  /** Set on submenus: the pointer entered or left this level. */
  onHover?: (inside: boolean) => void;
  flipX?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null);
  const hoverTimer = useRef(0);
  /** The pointer is over the open submenu: crossing other items on the way there keeps it. */
  const inSub = useRef(false);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    setPlace(
      placeMenu(
        at,
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        flipX,
      ),
    );
  }, [at, flipX]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const itemElement = useCallback(
    (index: number) => el.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null,
    [],
  );

  const openSub = useCallback(
    (index: number, focus: boolean) => {
      const target = itemElement(index);
      if (!target) return;
      setSub({ index, rect: target.getBoundingClientRect(), focus });
    },
    [itemElement],
  );

  const menuItems = items.map((entry, i): MenuActionItem | MenuSeparator | MenuHeading => {
    if (!isAction(entry)) return entry;
    const { items: children, ...rest } = entry;
    return {
      ...rest,
      id: entry.id ?? `${entry.label}-${i}`,
      ...(children ? { submenu: true } : {}),
    };
  });

  const subItems = sub ? (items[sub.index] as ContextMenuAction | undefined)?.items : undefined;

  return (
    <>
      <div
        ref={el}
        className="dp-context-menu__level"
        style={{ left: place?.left ?? at.x, top: place?.top ?? at.y }}
        onPointerEnter={() => onHover?.(true)}
        onPointerLeave={() => onHover?.(false)}
        onPointerMove={(e) => {
          const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
          if (!item) return;
          const index = Number(item.dataset.index);
          window.clearTimeout(hoverTimer.current);
          if (sub?.index === index) return;
          const entry = items[index];
          hoverTimer.current = window.setTimeout(() => {
            if (inSub.current) return;
            if (isAction(entry) && entry.items && !entry.disabled) openSub(index, false);
            else setSub(null);
          }, HOVER_OPEN_MS);
        }}
      >
        <Menu
          items={menuItems}
          label={label}
          // The first level opens from the pointer: the menu holds focus, no item looks chosen.
          autoFocus={onBack ? focus : "menu"}
          onSelect={(_, index) => {
            const entry = items[index];
            if (isAction(entry) && entry.items) openSub(index, true);
          }}
          onClose={(reason) => {
            if (reason === "select") onCloseAll();
            else if (reason === "arrow-left" || reason === "escape") {
              if (onBack) onBack();
              else if (reason === "escape") onCloseAll();
            } else if (reason === "tab") onCloseAll();
          }}
        />
      </div>
      {sub && subItems ? (
        <MenuLevel
          key={sub.index}
          at={{ x: sub.rect.right - 4, y: sub.rect.top - 4 }}
          flipX={sub.rect.left + 4}
          items={subItems}
          label={(items[sub.index] as ContextMenuAction).label}
          focus={sub.focus}
          onCloseAll={onCloseAll}
          onHover={(inside) => {
            inSub.current = inside;
          }}
          onBack={() => {
            inSub.current = false;
            setSub(null);
            itemElement(sub.index)?.focus();
          }}
        />
      ) : null}
    </>
  );
}
