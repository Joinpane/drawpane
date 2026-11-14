import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cx } from "../lib/cx";

export interface LightDialProps {
  /** Where the light comes from, in degrees: 0 is the top, turning clockwise. */
  angle: number;
  onChange: (angle: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Accessible name. Default "Light angle". */
  label?: string;
  className?: string;
}

/** An angle as the dial shows it: −180 to 180, whole degrees. */
export function normalizeAngle(angle: number): number {
  let a = Math.round(angle) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/**
 * Where light comes from, set by pointing: a rounded shape lit from the
 * dial's angle, with the light on a ring around it. Drag anywhere on it to
 * move the light; ← and → turn it a degree (⇧ for 15).
 */
export function LightDial({
  angle,
  onChange,
  onDragStart,
  onDragEnd,
  label = "Light angle",
  className,
}: LightDialProps) {
  const dragging = useRef(false);
  const radians = (angle * Math.PI) / 180;
  // The light on its ring (a 40% radius of the dial), y down.
  const lx = 50 + Math.sin(radians) * 38;
  const ly = 50 - Math.cos(radians) * 38;
  const angleAt = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    return normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 1;
    const by = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (by === undefined) return;
    e.preventDefault();
    onChange(normalizeAngle(angle + by));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={-180}
      aria-valuemax={180}
      aria-valuenow={normalizeAngle(angle)}
      aria-valuetext={`${normalizeAngle(angle)}°`}
      className={cx("dp-light-dial", className)}
      style={
        {
          "--dp-light-x": `${lx}%`,
          "--dp-light-y": `${ly}%`,
        } as React.CSSProperties
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        onDragStart?.();
        onChange(angleAt(e));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(angleAt(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        onDragEnd?.();
      }}
      onKeyDown={onKey}
    >
      <span className="dp-light-dial__shape" aria-hidden="true" />
      <span className="dp-light-dial__light" aria-hidden="true" />
    </div>
  );
}
