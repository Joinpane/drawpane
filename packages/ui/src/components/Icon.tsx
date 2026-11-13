import { type ComponentPropsWithRef, createElement } from "react";
import { type IconName, type IconNode, iconData } from "../icons";
import { cx } from "../lib/cx";

export type IconSize = 12 | 16;

export interface IconProps extends Omit<ComponentPropsWithRef<"svg">, "children"> {
  name: IconName;
  /** 16 by default; 12 inside dense rows and chips. */
  size?: IconSize;
  /** Accessible name, only for an icon that stands alone and means something. Otherwise decorative. */
  label?: string | undefined;
}

/** A glyph from Drawpane's icon set: 16px grid, 1.5px stroke, inherits currentColor. */
export function Icon({ name, size = 16, label, className, ...rest }: IconProps) {
  const nodes: readonly IconNode[] = iconData[name];
  return (
    <svg
      {...rest}
      className={cx("dp-icon", className)}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {nodes.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
    </svg>
  );
}
