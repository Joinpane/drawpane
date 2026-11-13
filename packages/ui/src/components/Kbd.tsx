import type { ComponentPropsWithRef } from "react";
import { cx } from "../lib/cx";

export interface KbdProps extends Omit<ComponentPropsWithRef<"kbd">, "children"> {
  /** Key labels in the order they are pressed, one cap each: `["⌘", "K"]`. */
  keys?: readonly string[];
  /** Space-separated keys, as an alternative to `keys`: "⌘ K". */
  children?: string;
  /** Spoken name for the shortcut, such as "Command K". The caps are hidden from assistive tech. */
  label?: string;
}

/** Key caps for keyboard shortcuts. One cap per key; never write "+" between caps. */
export function Kbd({ keys, children, label, className, ...rest }: KbdProps) {
  const caps = keys ?? children?.split(/\s+/).filter(Boolean) ?? [];
  return (
    <kbd {...rest} className={cx("dp-kbd", className)}>
      {label && <span className="dp-visually-hidden">{label}</span>}
      {caps.map((cap, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a key can repeat, order is fixed
        <kbd key={i} aria-hidden={label ? true : undefined}>
          {cap}
        </kbd>
      ))}
    </kbd>
  );
}
