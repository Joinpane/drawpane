import type { ComponentPropsWithRef } from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type BadgeTone =
  | "neutral"
  | "signal"
  | "component"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** Status tones always carry an icon, so color is never the only cue. */
const STATUS_ICONS: Partial<Record<BadgeTone, IconName>> = {
  success: "check",
  warning: "warning",
  danger: "warning",
  info: "branch",
};

export interface BadgeProps extends ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
  /** Overrides the status tone's default icon. */
  icon?: IconName;
}

/** A short status label beside a name: one to three words. */
export function Badge({ tone = "neutral", icon, className, children, ...rest }: BadgeProps) {
  const glyph = icon ?? STATUS_ICONS[tone];
  return (
    <span {...rest} className={cx("dp-badge", `dp-badge--${tone}`, className)}>
      {glyph && <Icon name={glyph} size={12} />}
      {children}
    </span>
  );
}
