import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { cx } from "../lib/cx";

export interface PropertySectionProps extends Omit<ComponentPropsWithRef<"section">, "title"> {
  /** A noun in sentence case: "Auto layout", "Fill". */
  title: string;
  /** Up to three IconButtons, such as "Add fill". */
  actions?: ReactNode;
}

/** One titled group in the Inspector, separated from the next by a hairline. */
export function PropertySection({
  title,
  actions,
  className,
  children,
  ...rest
}: PropertySectionProps) {
  const titleId = useId();
  return (
    <section {...rest} className={cx("dp-section", className)} aria-labelledby={titleId}>
      <header className="dp-section__head">
        <h3 id={titleId} className="dp-section__title">
          {title}
        </h3>
        {actions && <div className="dp-section__actions">{actions}</div>}
      </header>
      {children && <div className="dp-section__body">{children}</div>}
    </section>
  );
}

export interface PropertyRowProps extends ComponentPropsWithRef<"div"> {
  /** Two equal columns (default), three, or a 72px label column plus a control. */
  columns?: 2 | 3 | "label";
}

/** A grid row inside a PropertySection: the `dp-row` layout helpers as a component. */
export function PropertyRow({ columns = 2, className, ...rest }: PropertyRowProps) {
  return (
    <div
      {...rest}
      className={cx(
        "dp-row",
        columns === 3 && "dp-row--3",
        columns === "label" && "dp-row--label",
        className,
      )}
    />
  );
}
