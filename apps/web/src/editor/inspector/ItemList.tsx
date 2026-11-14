/**
 * Lists of things a layer has several of, each of a kind: effects, layout
 * grids. They look and work alike, like Figma's:
 *
 * - "+" opens a menu of kinds; picking one adds it and opens its editor.
 * - Each item is a row: its kind's icon and name, a glance at its values,
 *   show or hide, remove.
 * - The row opens the item's editor in a popover beside the inspector: the
 *   kind as a switcher in its header, a close button, then its values.
 */
import { DropdownMenu, Icon, IconButton, type IconName, MenuButton, Popover } from "@drawpane/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

export interface ItemKind<T extends string> {
  readonly type: T;
  readonly label: string;
  readonly icon: IconName;
}

/** "+" with a menu of the kinds to add. */
export function AddItemButton<T extends string>({
  label,
  kinds,
  onAdd,
}: {
  /** "Add effect". */
  label: string;
  kinds: readonly ItemKind<T>[];
  onAdd: (type: T) => void;
}) {
  return (
    <MenuButton
      icon="plus"
      label={label}
      items={kinds.map((kind) => ({
        id: kind.type,
        label: kind.label,
        icon: kind.icon,
        onSelect: () => onAdd(kind.type),
      }))}
    />
  );
}

/** One item's row. Its button opens the editor (`open` while it shows). */
export function ItemRow({
  kind,
  summary,
  hidden,
  open,
  buttonRef,
  onOpen,
  onToggleHidden,
  onRemove,
}: {
  kind: ItemKind<string>;
  /** A glance at its values: "0 4 12 0", "12 · stretch". */
  summary: string;
  hidden: boolean;
  open: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onToggleHidden: () => void;
  onRemove: () => void;
}) {
  const noun = kind.label.toLowerCase();
  return (
    <div className="item-row" data-hidden={hidden || undefined} data-open={open || undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="item-row__toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      >
        <Icon name={kind.icon} size={16} />
        <span className="item-row__name">{kind.label}</span>
        <span className="item-row__summary">{summary}</span>
      </button>
      <IconButton
        icon={hidden ? "eye-off" : "eye"}
        label={hidden ? `Show ${noun}` : `Hide ${noun}`}
        onClick={onToggleHidden}
      />
      <IconButton icon="minus" label={`Remove ${noun}`} onClick={onRemove} />
    </div>
  );
}

/**
 * An item's editor beside the inspector: its kind (switchable, keeping what
 * carries over), a close button, then `children`.
 */
export function ItemEditor<T extends string>({
  anchor,
  kinds,
  current,
  kindLabel,
  onKind,
  onClose,
  className,
  children,
}: {
  anchor: HTMLElement;
  kinds: readonly ItemKind<T>[];
  current: T;
  /** The switcher's accessible name: "Effect type". */
  kindLabel: string;
  onKind: (type: T) => void;
  onClose: () => void;
  className?: string | undefined;
  children: ReactNode;
}) {
  const kind = kinds.find((k) => k.type === current) ?? kinds[0];
  const typeButton = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);
  if (!kind) return null;
  return (
    <Popover
      anchor={anchor}
      label={kind.label}
      className={`item-editor dp-root${className ? ` ${className}` : ""}`}
      autoFocus={false}
      onClose={onClose}
    >
      <div className="item-editor__body">
        <div className="item-editor__head">
          <button
            ref={typeButton}
            type="button"
            className="item-editor__type"
            aria-haspopup="menu"
            aria-expanded={choosing}
            aria-label={`${kindLabel}: ${kind.label}`}
            onClick={() => setChoosing(!choosing)}
          >
            <Icon name={kind.icon} size={16} />
            <span>{kind.label}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        {choosing && typeButton.current ? (
          <DropdownMenu
            anchor={typeButton.current}
            label={kindLabel}
            align="start"
            items={kinds.map((k) => ({
              id: k.type,
              label: k.label,
              icon: k.icon,
              checked: k.type === current,
              // With icons the menu shows no check: the current kind starts highlighted instead.
              active: k.type === current,
              onSelect: () => onKind(k.type),
            }))}
            onClose={() => setChoosing(false)}
          />
        ) : null}
        {children}
      </div>
    </Popover>
  );
}

/**
 * Which item's editor is open, and the row buttons it opens beside. Items
 * are by position, so the editor closes when they stop being the same
 * list: another selection (`scope`, its ids), or the open item gone (an
 * undo took it, so the list is shorter than `count` says it was).
 */
export function useItemEditor(scope: string, count: number) {
  const [state, setState] = useState<{ scope: string; index: number } | null>(null);
  // Closed at once for another selection or a missing item, then forgotten, so it can't reopen later.
  const open = state && state.scope === scope && state.index < count ? state.index : null;
  useEffect(() => {
    if (state && open === null) setState(null);
  }, [state, open]);
  const setOpen = (index: number | null | ((current: number | null) => number | null)) =>
    setState((current) => {
      const now = current && current.scope === scope ? current.index : null;
      const next = typeof index === "function" ? index(now) : index;
      return next === null ? null : { scope, index: next };
    });
  const rows = useRef(new Map<number, HTMLButtonElement>());
  return {
    open,
    setOpen,
    /** The row to anchor the open editor to. */
    anchor: open === null ? null : (rows.current.get(open) ?? null),
    rowRef: (i: number) => (el: HTMLButtonElement | null) => {
      if (el) rows.current.set(i, el);
      else rows.current.delete(i);
    },
    toggle: (i: number) => setOpen((current) => (current === i ? null : i)),
    /** After adding item `i`: its editor opens once its row is there. */
    openNew: (i: number) => requestAnimationFrame(() => setOpen(i)),
  };
}
