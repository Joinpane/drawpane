import { type ComponentPropsWithRef, type KeyboardEvent, useRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label?: string;
  icon?: IconName;
  /** Required for icon-only options: the accessible name and tooltip. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string>
  extends Omit<ComponentPropsWithRef<"div">, "onChange" | "defaultValue" | "children"> {
  /** Two to five options. More than five? Use a Menu. */
  options: readonly SegmentedOption<V>[];
  value?: V;
  defaultValue?: V;
  onChange?: (value: V) => void;
  /** Accessible name of the group. */
  label?: string;
  disabled?: boolean;
}

/**
 * Mutually exclusive options shown at once, as a radio group: arrow keys move and select, Home and
 * End jump to the ends, and Tab leaves the group.
 */
export function SegmentedControl<V extends string = string>({
  options,
  value: valueProp,
  defaultValue,
  onChange,
  label,
  disabled = false,
  className,
  ...rest
}: SegmentedControlProps<V>) {
  const [value, setValue] = useControllableState<V | undefined>(
    valueProp,
    defaultValue,
    onChange && ((next) => next !== undefined && onChange(next)),
  );
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (i: number) => !disabled && options[i] !== undefined && !options[i]?.disabled;
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = enabled(selectedIndex) ? selectedIndex : options.findIndex((_, i) => enabled(i));

  const select = (i: number) => {
    const option = options[i];
    if (!option || !enabled(i)) return;
    buttons.current[i]?.focus();
    if (option.value !== value) setValue(option.value);
  };

  const step = (from: number, delta: 1 | -1) => {
    for (let n = 1; n <= options.length; n++) {
      const i = (from + delta * n + options.length * n) % options.length;
      if (enabled(i)) return i;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? step(index, 1)
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? step(index, -1)
          : event.key === "Home"
            ? step(last, 1)
            : event.key === "End"
              ? step(0, -1)
              : null;
    if (target === null) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div
      {...rest}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cx("dp-seg", className)}
    >
      {options.map((option, i) => {
        const checked = option.value === value;
        const iconOnly = Boolean(option.icon && !option.label);
        const radio = (
          // biome-ignore lint/a11y/useSemanticElements: APG radio group; buttons give the segmented look and roving focus
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[i] = node;
            }}
            type="button"
            role="radio"
            className="dp-seg__option"
            aria-checked={checked}
            aria-label={iconOnly ? option.title : undefined}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={!enabled(i)}
            onClick={() => select(i)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            {option.icon && <Icon name={option.icon} />}
            {option.label}
          </button>
        );
        return iconOnly && option.title ? (
          <Tooltip key={option.value} label={option.title} describe={false}>
            {radio}
          </Tooltip>
        ) : (
          radio
        );
      })}
    </div>
  );
}
