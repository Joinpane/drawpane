import { type ComponentPropsWithRef, useId } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export interface TextFieldProps extends ComponentPropsWithRef<"input"> {
  /** Sits above the field, in sentence case, with no colon. */
  label?: string;
  hint?: string;
  /** Says what happened and what to do; replaces the hint and turns the border danger. */
  error?: string | undefined;
}

/**
 * A labelled text input for forms outside the canvas. `className` goes on the wrapper; every
 * other prop, including `ref`, goes on the input.
 */
export function TextField({ label, hint, error, className, id, ...rest }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const message = error ?? hint;
  const describedBy = [rest["aria-describedby"], message && messageId].filter(Boolean).join(" ");
  return (
    <div className={cx("dp-tf", error && "dp-tf--error", className)}>
      {label && (
        <label className="dp-tf__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        {...rest}
        id={inputId}
        className="dp-tf__input"
        aria-invalid={error ? true : rest["aria-invalid"]}
        aria-describedby={describedBy || undefined}
      />
      {error ? (
        <span id={messageId} className="dp-tf__msg dp-tf__msg--error">
          <Icon name="warning" size={12} />
          {error}
        </span>
      ) : (
        hint && (
          <span id={messageId} className="dp-tf__msg">
            {hint}
          </span>
        )
      )}
    </div>
  );
}
