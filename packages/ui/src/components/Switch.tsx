import { type ComponentPropsWithRef, useId } from "react";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";

export interface SwitchProps
  extends Omit<ComponentPropsWithRef<"button">, "onChange" | "children" | "defaultChecked"> {
  checked?: boolean;
  defaultChecked?: boolean;
  /** Mixed value across a multi-selection; clicking turns the setting on. */
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  /** Names the setting, not the state: "Clip content". Without it, pass aria-label. */
  label?: string;
}

/** An on/off setting that takes effect immediately. */
export function Switch({
  checked: checkedProp,
  defaultChecked = false,
  indeterminate = false,
  onChange,
  label,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const [checked, setChecked] = useControllableState(checkedProp, defaultChecked, onChange);
  const autoId = useId();
  const labelId = `${autoId}-label`;
  const mixedId = `${autoId}-mixed`;
  const describedBy = [rest["aria-describedby"], indeterminate && mixedId]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={indeterminate ? false : checked}
      aria-labelledby={
        rest["aria-labelledby"] ?? (!rest["aria-label"] && label ? labelId : undefined)
      }
      aria-describedby={describedBy || undefined}
      className={cx("dp-switch", indeterminate && "dp-switch--mixed", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setChecked(indeterminate ? true : !checked);
      }}
    >
      <span className="dp-switch__track" aria-hidden="true">
        <span className="dp-switch__thumb" />
      </span>
      {label && (
        <span id={labelId} className="dp-switch__label">
          {label}
        </span>
      )}
      {indeterminate && (
        <span id={mixedId} className="dp-visually-hidden">
          Mixed
        </span>
      )}
    </button>
  );
}
