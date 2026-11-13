import type { ComponentPropsWithRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps
  extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-pressed" | "aria-label"> {
  icon: IconName;
  /** Required accessible name; also the tooltip text. */
  label: string;
  /** Shown in the tooltip after the label, such as "R" or "⌘ .". */
  shortcut?: string;
  /** Toggle state; renders aria-pressed. Omit for one-shot actions. */
  pressed?: boolean;
  /** `sm` 24px in pane headers (default), `md` 28px in the command strip. */
  size?: "sm" | "md";
  /** Show the label and shortcut in a Tooltip on hover and keyboard focus. Default true. */
  tooltip?: boolean;
}

/** A square, icon-only button for tools and pane actions. */
export function IconButton({
  icon,
  label,
  shortcut,
  pressed,
  size = "sm",
  tooltip = true,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      {...rest}
      type={type}
      className={cx("dp-iconbtn", size === "md" && "dp-iconbtn--md", className)}
      aria-label={label}
      aria-pressed={pressed}
    >
      <Icon name={icon} />
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip label={label} shortcut={shortcut} describe={false}>
      {button}
    </Tooltip>
  );
}
