import { useRef } from "react";
import { cx } from "../lib/cx";
import { NumberField } from "./NumberField";

export interface SliderFieldProps {
  /** Accessible name of the value ("Refraction"). */
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
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
  onChange,
  onScrubStart,
  onScrubEnd,
  className,
}: SliderFieldProps) {
  const dragging = useRef(false);
  const share = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onScrubEnd?.();
  };
  return (
    <div className={cx("dp-slider", className)}>
      <input
        type="range"
        className="dp-slider__track"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--dp-slider-fill": `${share * 100}%` } as React.CSSProperties}
        onPointerDown={() => {
          dragging.current = true;
          onScrubStart?.();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumberField
        ariaLabel={`${label} value`}
        value={value}
        min={min}
        max={max}
        step={step}
        {...(unit ? { unit } : {})}
        onChange={onChange}
        {...(onScrubStart ? { onScrubStart } : {})}
        {...(onScrubEnd ? { onScrubEnd } : {})}
      />
    </div>
  );
}
