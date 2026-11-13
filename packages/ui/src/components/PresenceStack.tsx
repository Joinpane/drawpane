import type { ComponentPropsWithRef, CSSProperties } from "react";
import { cx } from "../lib/cx";
import { type PresenceSlot, presenceColor } from "../tokens";
import { Tooltip } from "./Tooltip";

export interface Person {
  /** Stable identity for keys and `following`; defaults to the name. */
  id?: string;
  name: string;
  /** Defaults to the first letters of the first two words of the name. */
  initials?: string;
  /** Presence slot 1–8; defaults to the person's position in the stack. */
  color?: PresenceSlot;
  /** Where they are, such as a page or board name. */
  where?: string;
}

export interface PresenceStackProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  people: readonly Person[];
  /** Avatars shown before the rest collapse into a "+n" chip. Default 4. */
  max?: number;
  /** Makes avatars buttons; clicking one enters follow mode. */
  onFollow?: (person: Person) => void;
  /** The id (or name) of the person being followed; their ring thickens. */
  following?: string;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

type RingStyle = CSSProperties & Record<"--ring", string>;

/** Everyone in the file, each ringed in their presence color. */
export function PresenceStack({
  people,
  max = 4,
  onFollow,
  following,
  className,
  ...rest
}: PresenceStackProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const count = people.length === 1 ? "1 person" : `${people.length} people`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of avatars, not a form
    <div
      {...rest}
      role="group"
      aria-label={`${count} in this file`}
      className={cx("dp-presence", className)}
    >
      {shown.map((person, i) => {
        const key = person.id ?? person.name;
        const name = person.where ? `${person.name} · ${person.where}` : person.name;
        const style: RingStyle = { "--ring": presenceColor(person.color ?? i + 1) };
        const classes = cx("dp-avatar", following === key && "is-following");
        const initials = person.initials ?? initialsOf(person.name);
        const avatar = onFollow ? (
          <button
            type="button"
            className={classes}
            style={style}
            aria-label={`Follow ${name}`}
            aria-pressed={following === key}
            onClick={() => onFollow(person)}
          >
            {initials}
          </button>
        ) : (
          <span className={classes} style={style} role="img" aria-label={name}>
            {initials}
          </span>
        );
        return (
          <Tooltip key={key} label={name} describe={false}>
            {avatar}
          </Tooltip>
        );
      })}
      {extra > 0 && (
        <span className="dp-avatar dp-avatar--more" role="img" aria-label={`${extra} more`}>
          +{extra}
        </span>
      )}
    </div>
  );
}
