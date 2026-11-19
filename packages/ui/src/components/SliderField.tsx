import { type KeyboardEvent, useRef } from "react";
import { cx } from "../lib/cx";
import { NumberField } from "./NumberField";

/** A stop on the track worth a name ("iOS" at 60): a button under the track that sets it. */
export interface SliderMark {
  value: number;
  label: string;
}

export interface SliderFieldProps {
  /** Accessible name of the value ("Refraction"). */
  label: string;
  /** Null when there's no one value (a selection that differs): the number shows `placeholder`. */
  value: number | null;
  /** What the number shows without a value ("Mixed"). */
  placeholder?: string;
  /** Named stops, under the track. */
  marks?: readonly SliderMark[];
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /**
   * How the track spreads the range: 1 (the default) evenly; above 1, more
   * of the track for the low end, for sizes where small ones matter most
   * (2 puts a quarter of the range at the track's middle).
   */
  curve?: number;
  /** Each change: every slider move and committed number. */
  onChange: (value: number) => void;
  /** A drag on the track (or a scrub of the number) starts and ends: one undo step for the whole drag. */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  className?: string;
}

/**
 * A value on a track, with its number beside it: drag the track for a feel
 * of it, type or scrub the number for an exact one. The track shows how far
 * along its range the value is.
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  placeholder,
  marks,
  curve = 1,
  onChange,
  onScrubStart,
  onScrubEnd,
  className,
}: SliderFieldProps) {
  const dragging = useRef(false);
  const span = max - min;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  // Where a value sits along the track (0–1), and back, through the curve.
  const shareOf = (v: number) => (span > 0 ? ((clamp(v) - min) / span) ** (1 / curve) : 0);
  const share = value === null ? 0 : shareOf(value);
  const curved = curve !== 1;
  const fromTrack = (t: number) => {
    const raw = min + span * t ** curve;
    return clamp(Math.round(raw / step) * step);
  };
  // On a curved track a key moves the value a step, as on an even one: a step of the track could round to nothing.
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!curved || by === undefined) return;
    e.preventDefault();
    const from = value ?? min;
    const next = clamp(Math.round((from + by * step * (e.shiftKey ? 10 : 1)) / step) * step);
    if (next !== value) onChange(next);
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onScrubEnd?.();
  };
  const track = (
    <input
      type="range"
      className="dp-slider__track"
      aria-label={label}
      {...(curved
        ? {
            min: 0,
            max: 1000,
            step: 1,
            value: Math.round(share * 1000),
            "aria-valuetext": value === null ? (placeholder ?? "") : `${value}${unit ?? ""}`,
          }
        : {
            min,
            max,
            step,
            value: value ?? min,
            ...(value === null && placeholder ? { "aria-valuetext": placeholder } : {}),
          })}
      style={{ "--dp-slider-fill": `${share * 100}%` } as React.CSSProperties}
      onPointerDown={() => {
        dragging.current = true;
        onScrubStart?.();
        // Released anywhere, even off the track: the drag (and its undo step) ends there.
        const release = () => {
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
          end();
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
      }}
      onBlur={end}
      onKeyDown={onKey}
      onChange={(e) => {
        const v = Number(e.target.value);
        onChange(curved ? fromTrack(v / 1000) : v);
      }}
    />
  );
  return (
    <div className={cx("dp-slider", value === null && "dp-slider--mixed", className)}>
      {marks && marks.length > 0 ? (
        <div className="dp-slider__rail">
          {track}
          <div className="dp-slider__marks">
            {marks.map((m) => (
              <button
                key={m.value}
                type="button"
                className="dp-slider__mark"
                style={{ "--dp-slider-at": `${shareOf(m.value) * 100}%` } as React.CSSProperties}
                aria-label={`${label}: ${m.label}, ${m.value}${unit ?? ""}`}
                aria-pressed={value === m.value}
                onClick={() => onChange(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        track
      )}
      <NumberField
        ariaLabel={`${label} value`}
        value={value}
        min={min}
        max={max}
        step={step}
        {...(unit ? { unit } : {})}
        {...(placeholder ? { placeholder } : {})}
        onChange={onChange}
        {...(onScrubStart ? { onScrubStart } : {})}
        {...(onScrubEnd ? { onScrubEnd } : {})}
      />
    </div>
  );
}
