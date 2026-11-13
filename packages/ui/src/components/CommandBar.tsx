import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

export interface CommandItem {
  /** Stable React key; defaults to the label. */
  id?: string;
  label: string;
  icon?: IconName;
  hint?: string;
  shortcut?: string;
  /** Starts as the active result. Otherwise the first result is active. */
  active?: boolean;
  kind?: "component";
  /** For property commands: the current and the new value, shown as a diff. */
  from?: string;
  to?: string;
}

export interface CommandGroup {
  id?: string;
  /** Set property, Layers, Components, Actions or Help, in that order. Empty groups are hidden. */
  title: string;
  items: readonly CommandItem[];
}

export interface CommandBarProps
  extends Omit<ComponentPropsWithRef<"div">, "children" | "onChange" | "autoFocus"> {
  /** Results for the current query. Filtering is the host's job. */
  groups: readonly CommandGroup[];
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  /** What the command acts on, such as "3 layers selected". */
  scope?: string;
  readOnly?: boolean;
  /** Enter, or a click on a result. */
  onRun?: (item: CommandItem, group: CommandGroup) => void;
  /** Tab: complete a property or token name. */
  onComplete?: (item: CommandItem, group: CommandGroup) => void;
  /** Escape. */
  onClose?: () => void;
  /** Focus the input on mount. Default true. */
  autoFocus?: boolean;
  /** Accessible name of the bar. Default "Command bar". */
  label?: string;
  /** Shown when no group has results. */
  emptyLabel?: string;
}

interface Result {
  item: CommandItem;
  group: CommandGroup;
}

function initialActive(results: Result[]): number {
  return Math.max(
    0,
    results.findIndex((r) => r.item.active),
  );
}

/**
 * The command bar: a combobox over grouped results. Arrow keys move the active result (announced
 * with aria-activedescendant), Enter runs it, Tab completes it and Escape closes.
 */
export function CommandBar({
  groups,
  query: queryProp,
  defaultQuery = "",
  onQueryChange,
  placeholder = "Type a command, layer or property…",
  scope,
  readOnly,
  onRun,
  onComplete,
  onClose,
  autoFocus = true,
  label = "Command bar",
  emptyLabel = "No matching commands",
  className,
  ...rest
}: CommandBarProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useControllableState(queryProp, defaultQuery, onQueryChange);
  const visible = groups.filter((g) => g.items.length > 0);
  const results: Result[] = visible.flatMap((group) =>
    group.items.map((item) => ({ item, group })),
  );

  // New results make the first (or the flagged) result active, so Enter does the obvious thing.
  const [active, setActive] = useState(() => initialActive(results));
  const [shownGroups, setShownGroups] = useState(groups);
  if (shownGroups !== groups) {
    setShownGroups(groups);
    setActive(initialActive(results));
  }
  const activeIndex = Math.min(active, results.length - 1);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const option = document.getElementById(optionId(activeIndex));
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });

  const run = (index: number) => {
    const result = results[index];
    if (result) onRun?.(result.item, result.group);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = results.length;
    const current = results[activeIndex];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + delta + count) % count);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      run(activeIndex);
    } else if (event.key === "Tab" && onComplete && current && !event.shiftKey) {
      event.preventDefault();
      onComplete(current.item, current.group);
    } else if (event.key === "Escape" && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  let index = -1;
  return (
    <div {...rest} role="dialog" aria-label={label} className={cx("dp-cmd", className)}>
      <div className="dp-cmd__input">
        <Icon name="search" />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Type a command or a property"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          readOnly={readOnly}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Kbd keys={["esc"]} />
      </div>
      <div id={listboxId} role="listbox" aria-label="Results" className="dp-cmd__results">
        {results.length === 0 && <div className="dp-cmd__empty">{emptyLabel}</div>}
        {visible.map((group, gi) => {
          const titleId = `${baseId}-group-${gi}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: ARIA listboxes group options with role="group"
            <div key={group.id ?? group.title} role="group" aria-labelledby={titleId}>
              <div id={titleId} className="dp-cmd__group">
                {group.title}
              </div>
              {group.items.map((item) => {
                index++;
                const i = index;
                const isActive = i === activeIndex;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the combobox input
                  <div
                    key={item.id ?? item.label}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    className={cx("dp-cmd__option", isActive && "is-active")}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => {
                      if (!isActive) setActive(i);
                    }}
                    onClick={() => run(i)}
                  >
                    <span
                      className={cx("dp-cmd__icon", item.kind === "component" && "is-component")}
                    >
                      <Icon name={item.icon ?? "pointer"} />
                    </span>
                    <span className="dp-cmd__label">
                      {item.label}
                      {item.from !== undefined && (
                        <span className="dp-cmd__change">
                          <s>{item.from}</s> → <b>{item.to}</b>
                        </span>
                      )}
                      {item.hint && <span className="dp-cmd__hint">{item.hint}</span>}
                    </span>
                    {item.shortcut && <span className="dp-cmd__key">{item.shortcut}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="dp-cmd__foot" aria-hidden="true">
        <span>
          <Kbd keys={["↑", "↓"]} /> move
        </span>
        <span>
          <Kbd keys={["↵"]} /> run
        </span>
        <span>
          <Kbd keys={["tab"]} /> set value
        </span>
        <span className="dp-cmd__scope">{scope}</span>
      </div>
    </div>
  );
}
