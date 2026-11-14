import type { ComponentPropsWithRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  /** `primary` is the signal fill: at most one per view. Default `secondary`. */
  variant?: ButtonVariant;
  /** `sm` 24px in panes, `md` 28px (default), `lg` 36px on the dashboard and in dialogs. */
  size?: ButtonSize;
  icon?: IconName;
  /** Shortcut shown after the label in mono, such as "⌘ ↵". Visual only; set aria-keyshortcuts too. */
  shortcut?: string | undefined;
}

/** A labelled action. Labels are verb-first, sentence case, one to three words. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  shortcut,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("dp-btn", `dp-btn--${variant}`, `dp-btn--${size}`, className)}
    >
      {icon && <Icon name={icon} />}
      {children}
      {shortcut && (
        <span className="dp-btn__key" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </button>
  );
}
