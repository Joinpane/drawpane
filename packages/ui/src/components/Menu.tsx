import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { assignRef } from "../lib/refs";
import { Icon } from "./Icon";

export interface MenuActionItem {
  /** Stable React key; defaults to the label. */
  id?: string;
  label: string;
  icon?: IconName;
  /** Shown right-aligned in mono, such as "⌘ C". */
  shortcut?: string;
  /** Makes the item a menuitemcheckbox; shows a check when there is no icon. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Starts as the active (highlighted, focusable) item. */
  active?: boolean;
  /** Shows a chevron; ArrowRight and Enter call onSelect so the host can open the submenu. */
  submenu?: boolean;
  onSelect?: () => void;
}

export interface MenuSeparator {
  id?: string;
  separator: true;
}

export interface MenuHeading {
  id?: string;
  /** Labels the items after it, up to the next separator or heading. */
  heading: string;
}

export type MenuItem = MenuActionItem | MenuSeparator | MenuHeading;

export type MenuCloseReason = "escape" | "tab" | "select" | "arrow-left";

export interface MenuProps
  extends Omit<ComponentPropsWithRef<"div">, "onSelect" | "children" | "autoFocus"> {
  items: readonly MenuItem[];
  /** Accessible name of the menu. */
  label?: string;
  /** Called for an enabled item chosen with Enter, Space, ArrowRight (submenus) or a click. */
  onSelect?: (item: MenuActionItem, index: number) => void;
  /** Escape, Tab, a selection, or ArrowLeft (to close a submenu). */
  onClose?: (reason: MenuCloseReason) => void;
  /**
   * Focus on mount, for menus that pop up: `true` focuses the active (or
   * first) item, for menus opened from the keyboard; `"menu"` focuses the
   * menu itself, for menus opened with the pointer, so no item looks chosen
   * until ↓, ↑ or a letter moves into the list.
   */
  autoFocus?: boolean | "menu";
}

const TYPEAHEAD_RESET_MS = 500;

function isAction(item: MenuItem | undefined): item is MenuActionItem {
  return item !== undefined && !("separator" in item) && !("heading" in item);
}

/**
 * A context or dropdown menu with roving focus: arrow keys, Home and End move, typing jumps to a
 * label, Enter and Space select, and Escape or Tab close.
 */
export function Menu({
  items,
  label,
  onSelect,
  onClose,
  autoFocus = false,
  className,
  ref,
  ...rest
}: MenuProps) {
  const baseId = useId();
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const typeahead = useRef({ text: "", time: 0 });
  const actionIndexes = items.flatMap((item, i) => (isAction(item) ? [i] : []));
  const initial = items.findIndex((item) => isAction(item) && item.active);
  const [active, setActive] = useState(initial);
  const tabStop = isAction(items[active]) ? active : (actionIndexes[0] ?? -1);

  const focusItem = (index: number) => {
    setActive(index);
    refs.current[index]?.focus();
  };

  const menuRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, on mount
  useEffect(() => {
    if (autoFocus === "menu") menuRef.current?.focus({ preventScroll: true });
    else if (autoFocus && tabStop >= 0) focusItem(tabStop);
  }, []);

  /** Keys while the menu itself has focus (pointer-opened): move into the items. */
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const first = actionIndexes[0];
    const last = actionIndexes.at(-1);
    if ((event.key === "ArrowDown" || event.key === "Home") && first !== undefined)
      focusItem(first);
    else if ((event.key === "ArrowUp" || event.key === "End") && last !== undefined)
      focusItem(last);
    else if (event.key === "Escape" && onClose) {
      event.stopPropagation();
      onClose("escape");
    } else if (event.key === "Tab") onClose?.("tab");
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
      matchTypeahead(event.key);
    else return;
    event.preventDefault();
  };

  const select = (index: number) => {
    const item = items[index];
    if (!isAction(item) || item.disabled) return;
    item.onSelect?.();
    onSelect?.(item, index);
    if (!item.submenu) onClose?.("select");
  };

  const move = (delta: 1 | -1) => {
    const position = actionIndexes.indexOf(tabStop);
    const count = actionIndexes.length;
    const next = actionIndexes[(position + delta + count) % count];
    if (next !== undefined) focusItem(next);
  };

  const matchTypeahead = (key: string) => {
    const now = performance.now();
    const state = typeahead.current;
    state.text = now - state.time > TYPEAHEAD_RESET_MS ? key : state.text + key;
    state.time = now;
    const query = state.text.toLowerCase();
    // Repeating one letter cycles through the items that start with it.
    const repeated = [...query].every((char) => char === query[0]);
    const search = repeated ? (query[0] ?? "") : query;
    const position = actionIndexes.indexOf(tabStop);
    const ordered = [...actionIndexes.slice(position + 1), ...actionIndexes.slice(0, position + 1)];
    const startsWith = (i: number) => {
      const item = items[i];
      return isAction(item) && item.label.toLowerCase().startsWith(search);
    };
    const match = (repeated ? ordered : [tabStop, ...ordered]).find(startsWith);
    if (match !== undefined) focusItem(match);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const item = items[index];
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        if (actionIndexes[0] !== undefined) focusItem(actionIndexes[0]);
        break;
      case "End": {
        const last = actionIndexes.at(-1);
        if (last !== undefined) focusItem(last);
        break;
      }
      case "Enter":
      case " ":
        select(index);
        break;
      case "ArrowRight":
        if (isAction(item) && item.submenu) select(index);
        else return;
        break;
      case "ArrowLeft":
        if (!onClose) return;
        onClose("arrow-left");
        break;
      case "Escape":
        if (!onClose) return;
        event.stopPropagation();
        onClose("escape");
        break;
      case "Tab":
        onClose?.("tab");
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          matchTypeahead(event.key);
          break;
        }
        return;
    }
    event.preventDefault();
  };

  const renderItem = (item: MenuActionItem, index: number) => {
    const checkable = item.checked !== undefined;
    const glyph = item.icon ?? (item.checked ? "check" : undefined);
    return (
      <div
        key={item.id ?? `${item.label}-${index}`}
        ref={(node) => {
          refs.current[index] = node;
        }}
        id={`${baseId}-${index}`}
        data-index={index}
        role="menuitem"
        {...(checkable ? { role: "menuitemcheckbox", "aria-checked": item.checked } : {})}
        aria-disabled={item.disabled || undefined}
        aria-haspopup={item.submenu ? "menu" : undefined}
        tabIndex={index === tabStop ? 0 : -1}
        className={cx(
          "dp-menu__item",
          index === active && "is-active",
          item.danger && "is-danger",
          item.disabled && "is-disabled",
        )}
        onKeyDown={(event) => onKeyDown(event, index)}
        onClick={() => select(index)}
        onPointerMove={() => {
          if (active !== index) focusItem(index);
        }}
        onFocus={() => setActive(index)}
      >
        <span className="dp-menu__icon">{glyph && <Icon name={glyph} />}</span>
        <span className="dp-menu__label">{item.label}</span>
        {item.submenu ? (
          <Icon name="chevron-right" size={12} />
        ) : (
          item.shortcut && (
            <span className="dp-menu__key" aria-hidden="true">
              {item.shortcut}
            </span>
          )
        )}
      </div>
    );
  };

  // Headings start a labelled group that runs to the next separator or heading.
  const content: ReactNode[] = [];
  let group: { id: string; key: string; heading: string; children: ReactNode[] } | null = null;
  const closeGroup = () => {
    if (!group) return;
    content.push(
      // biome-ignore lint/a11y/useSemanticElements: ARIA menus group items with role="group"
      <div key={group.key} role="group" aria-labelledby={group.id}>
        <div id={group.id} className="dp-menu__heading">
          {group.heading}
        </div>
        {group.children}
      </div>,
    );
    group = null;
  };
  items.forEach((item, index) => {
    const key = item.id ?? `${index}`;
    if ("separator" in item) {
      closeGroup();
      content.push(<hr key={key} className="dp-menu__sep" />);
    } else if ("heading" in item) {
      closeGroup();
      group = { id: `${baseId}-group-${index}`, key, heading: item.heading, children: [] };
    } else if (group) {
      group.children.push(renderItem(item, index));
    } else {
      content.push(renderItem(item, index));
    }
  });
  closeGroup();

  return (
    <div
      {...rest}
      ref={(node) => {
        menuRef.current = node;
        assignRef(ref, node);
      }}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={autoFocus === "menu" ? -1 : undefined}
      className={cx("dp-menu", className)}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event);
        if (!event.defaultPrevented) onMenuKeyDown(event);
      }}
    >
      {content}
    </div>
  );
}
