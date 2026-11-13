import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { IconName } from "../icons";
import { cx } from "../lib/cx";
import { evaluateNumericInput, formatNumber, roundTo } from "../lib/numeric-input";
import { assignRef } from "../lib/refs";
import { Icon } from "./Icon";
import { TokenChip } from "./TokenChip";

export interface NumberFieldProps
  extends Omit<
    ComponentPropsWithRef<"input">,
    "value" | "defaultValue" | "onChange" | "type" | "size" | "min" | "max" | "step"
  > {
  /** One to three characters (W, H, X, ↔). Dragging the label scrubs the value. */
  label?: string;
  /** A glyph instead of a text label; also a scrub handle. */
  icon?: IconName;
  /** Suffix shown after the value, such as "%" or "°". Values typed with it are accepted as is. */
  unit?: string;
  /** When bound to a token, a TokenChip replaces the input. */
  token?: string;
  /** CSS color for a bound color token. */
  swatch?: string;
  /** Accessible name, when `label` is a symbol or `icon` is used. */
  ariaLabel?: string;
  /** The value, or null for "Mixed" (a multi-selection with different values). */
  value?: number | null;
  defaultValue?: number | null;
  /** Called with each committed value: Enter, blur, arrow keys and every scrub step. */
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  /** Arrow and scrub step. Shift multiplies it by 10 and Alt by 0.1. Default 1. */
  step?: number;
  /** Decimals kept after evaluating. Default 2. */
  precision?: number;
  /** Extra units for math input, in base units each: `{ "%": parentWidth / 100 }`. */
  units?: Readonly<Record<string, number>>;
  /** Scrubbing started, for example to open an undo group. */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Makes the bound TokenChip a button. */
  onTokenClick?: () => void;
}

interface Scrub {
  pointerId: number;
  lastX: number;
  /** Unrounded value, so slow drags with Alt still accumulate. */
  exact: number;
}

function stepMultiplier(event: { shiftKey: boolean; altKey: boolean }): number {
  return event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
}

/**
 * The Inspector's numeric input. Accepts math and units (`24*2`, `1.5rem`), commits on Enter and
 * blur, reverts on Escape, steps with the arrow keys and scrubs when you drag its label.
 */
export function NumberField({
  label,
  icon,
  unit,
  token,
  swatch,
  ariaLabel,
  value: valueProp,
  defaultValue = null,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  precision = 2,
  units,
  onScrubStart,
  onScrubEnd,
  onTokenClick,
  className,
  disabled,
  placeholder,
  ref,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: NumberFieldProps) {
  const [internal, setInternal] = useState<number | null>(defaultValue);
  const controlled = valueProp !== undefined;
  const value = controlled ? valueProp : internal;
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectAfterRender = useRef(false);
  const scrub = useRef<Scrub | null>(null);
  const name = ariaLabel ?? rest["aria-label"] ?? label;
  // The latest committed value, so several events between renders (scrubbing) compare correctly.
  const latest = useRef(value);
  latest.current = value;

  useLayoutEffect(() => {
    if (selectAfterRender.current) {
      selectAfterRender.current = false;
      inputRef.current?.select();
    }
  });

  const commitNumber = useCallback(
    (next: number): number => {
      const clamped = roundTo(Math.min(max, Math.max(min, next)), precision);
      if (clamped !== latest.current) {
        latest.current = clamped;
        if (!controlled) setInternal(clamped);
        onChange?.(clamped);
      }
      return clamped;
    },
    [max, min, precision, controlled, onChange],
  );

  const evaluate = (text: string) =>
    evaluateNumericInput(text, { ...(unit ? { unit } : {}), ...(units ? { units } : {}) });

  /** Commits the typed text if it evaluates; otherwise the field keeps its last value. */
  const commitDraft = () => {
    if (draft === null || draft.trim() === "") return;
    const evaluated = evaluate(draft);
    if (evaluated !== null) commitNumber(evaluated);
  };

  const finishEditing = (select: boolean) => {
    setDraft(null);
    selectAfterRender.current = select;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitDraft();
      finishEditing(true);
    } else if (event.key === "Escape") {
      // Only swallow Escape when it reverts something; otherwise let it close the host.
      if (draft !== null) event.stopPropagation();
      finishEditing(true);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const typed = draft === null ? null : evaluate(draft);
      const base = typed ?? value;
      if (base === null) return;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      commitNumber(base + direction * step * stepMultiplier(event));
      finishEditing(true);
    }
  };

  const endScrub = (event: PointerEvent<HTMLSpanElement>) => {
    const active = scrub.current;
    if (!active || active.pointerId !== event.pointerId) return;
    scrub.current = null;
    document.documentElement.classList.remove("dp-scrubbing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onScrubEnd?.();
  };

  const scrubbable = !disabled && !token;
  const labelContent = icon ? <Icon name={icon} size={12} /> : label;

  return (
    <div
      className={cx(
        "dp-field",
        token && "dp-field--token",
        disabled && "dp-field--disabled",
        className,
      )}
      {...(token ? { role: "group", "aria-label": name } : {})}
    >
      {labelContent !== undefined && (
        <span
          className="dp-field__label"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (!scrubbable || event.button !== 0) return;
            event.preventDefault();
            commitDraft();
            setDraft(null);
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub.current = { pointerId: event.pointerId, lastX: event.clientX, exact: value ?? 0 };
            document.documentElement.classList.add("dp-scrubbing");
            onScrubStart?.();
          }}
          onPointerMove={(event) => {
            const active = scrub.current;
            if (!active || active.pointerId !== event.pointerId) return;
            const delta = (event.clientX - active.lastX) * step * stepMultiplier(event);
            active.lastX = event.clientX;
            active.exact = Math.min(max, Math.max(min, active.exact + delta));
            commitNumber(active.exact);
          }}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={endScrub}
        >
          {labelContent}
        </span>
      )}
      {token ? (
        <TokenChip
          name={token}
          swatch={swatch}
          {...(onTokenClick ? { onClick: onTokenClick } : {})}
        />
      ) : (
        <input
          {...rest}
          ref={(node) => {
            inputRef.current = node;
            assignRef(ref, node);
          }}
          className="dp-field__input"
          type="text"
          role="spinbutton"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label={name}
          aria-valuenow={value ?? undefined}
          aria-valuetext={value === null ? "Mixed" : undefined}
          aria-valuemin={Number.isFinite(min) ? min : undefined}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          placeholder={value === null ? "Mixed" : placeholder}
          value={draft ?? (value === null ? "" : formatNumber(value, precision))}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            onFocus?.(event);
            event.currentTarget.select();
          }}
          onBlur={(event) => {
            onBlur?.(event);
            commitDraft();
            finishEditing(false);
          }}
          onKeyDown={handleKeyDown}
        />
      )}
      {unit && !token && <span className="dp-field__unit">{unit}</span>}
    </div>
  );
}
