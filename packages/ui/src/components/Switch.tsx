import type { ComponentPropsWithRef } from "react";
import { cx } from "../lib/cx";
import { useControllableState } from "../lib/use-controllable-state";

export interface SwitchProps
  extends Omit<ComponentPropsWithRef<"button">, "onChange" | "children" | "defaultChecked"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Names the setting, not the state: "Clip content". Without it, pass aria-label. */
  label?: string;
}

/** An on/off setting that takes effect immediately. */
export function Switch({
  checked: checkedProp,
  defaultChecked = false,
  onChange,
  label,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const [checked, setChecked] = useControllableState(checkedProp, defaultChecked, onChange);
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx("dp-switch", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setChecked(!checked);
      }}
    >
      <span className="dp-switch__track" aria-hidden="true">
        <span className="dp-switch__thumb" />
      </span>
      {label && <span className="dp-switch__label">{label}</span>}
    </button>
  );
}
