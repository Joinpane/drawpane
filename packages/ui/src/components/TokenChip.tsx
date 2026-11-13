import type { HTMLAttributes, MouseEventHandler } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export interface TokenChipProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Token path as authored, such as "space/300" or "brand/500". */
  name: string;
  /** CSS color for color tokens; omit for number tokens. */
  swatch?: string | undefined;
  /** The layer overrides the token's value. */
  detached?: boolean;
  /** Makes the chip a button, for example to offer "Reattach" and "Update token". */
  onClick?: MouseEventHandler<HTMLElement>;
}

/**
 * A token reference. Names are set in mono, and long names truncate from the left so the last
 * path segment stays visible.
 */
export function TokenChip({ name, swatch, detached, className, onClick, ...rest }: TokenChipProps) {
  const title = detached ? `Detached from ${name}` : name;
  const content = (
    <>
      {swatch ? (
        <span className="dp-token__swatch" style={{ background: swatch }} />
      ) : (
        <Icon name={detached ? "warning" : "token"} size={12} />
      )}
      <span className="dp-token__name">
        <span dir="ltr">{name}</span>
      </span>
      {detached && <span className="dp-visually-hidden">, detached</span>}
    </>
  );
  const classes = cx("dp-token", detached && "dp-token--detached", className);
  if (onClick) {
    return (
      <button {...rest} type="button" className={classes} title={title} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span {...rest} className={classes} title={title}>
      {content}
    </span>
  );
}
