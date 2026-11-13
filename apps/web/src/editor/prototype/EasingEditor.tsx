import {
  type Bezier,
  bezierOf,
  EASING_LABEL,
  EASING_PRESETS,
  easingCss,
  SPRING_PRESETS,
  sampleEasing,
  springSettleMs,
  transitionMs,
} from "@drawpane/editor";
import type { Easing, Transition } from "@drawpane/model";
import { IconButton, NumberField, SegmentedControl } from "@drawpane/ui";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

type Family = "ease" | "spring" | "bezier";

const familyOf = (easing: Easing): Family =>
  easing.type === "spring" ? "spring" : easing.type === "bezier" ? "bezier" : "ease";

const PRESET_TYPES = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;

/** The plot: 0..1 in time across, -0.35..1.35 in progress up, so overshoot stays visible. */
const W = 216;
const H = 112;
const PAD_X = 12;
const Y_MIN = -0.35;
const Y_MAX = 1.35;
const px = (x: number) => PAD_X + x * (W - PAD_X * 2);
const py = (y: number) => H - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * H;
const fromPx = (x: number) => (x - PAD_X) / (W - PAD_X * 2);
const fromPy = (y: number) => Y_MIN + ((H - y) / H) * (Y_MAX - Y_MIN);
const round = (n: number) => Math.round(n * 100) / 100;

/** Parses "cubic-bezier(0.2, 0.8, 0.2, 1)" or "0.2, 0.8, 0.2, 1". */
function parseBezier(text: string): Bezier | null {
  const numbers = text.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) return null;
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1 || y1 < -2 || y1 > 3 || y2 < -2 || y2 > 3) return null;
  return [x1, y1, x2, y2];
}

export interface EasingEditorProps {
  transition: Transition;
  onChange: (transition: Transition) => void;
  /** Groups a handle drag into one undo step. */
  onGestureStart: () => void;
  onGestureEnd: () => void;
}

/**
 * Timing for a transition: a named ease, a draggable cubic bézier or a
 * spring, drawn as its curve with a preview that plays it for real.
 */
export function EasingEditor({
  transition,
  onChange,
  onGestureStart,
  onGestureEnd,
}: EasingEditorProps) {
  const { easing } = transition;
  const family = familyOf(easing);
  const bezier = bezierOf(easing);
  const setEasing = (next: Easing) => onChange({ ...transition, easing: next });
  const svg = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<1 | 2 | null>(null);

  const switchFamily = (next: Family) => {
    if (next === family) return;
    if (next === "spring") setEasing(SPRING_PRESETS.snappy);
    else if (next === "ease") setEasing({ type: "ease-out" });
    else {
      const [x1, y1, x2, y2] = bezier ?? EASING_PRESETS["ease-out"];
      setEasing({ type: "bezier", x1, y1, x2, y2 });
    }
  };

  const dragHandle = (handle: 1 | 2) => (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!bezier || event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(handle);
    onGestureStart();
    const move = (e: PointerEvent) => {
      const rect = svg.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.min(1, Math.max(0, round(fromPx(((e.clientX - rect.left) / rect.width) * W))));
      const y = Math.min(
        3,
        Math.max(-2, round(fromPy(((e.clientY - rect.top) / rect.height) * H))),
      );
      const [x1, y1, x2, y2] = bezierOf(transition.easing) ?? bezier;
      onChange({
        ...transition,
        easing:
          handle === 1
            ? { type: "bezier", x1: x, y1: y, x2, y2 }
            : { type: "bezier", x1, y1, x2: x, y2: y },
      });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(null);
      onGestureEnd();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const samples = sampleEasing(easing, 96);
  const curve = samples
    .map((y, i) => `${i === 0 ? "M" : "L"}${px(i / 96).toFixed(1)},${py(y).toFixed(1)}`)
    .join("");
  const ms = transitionMs({
    ...transition,
    type: transition.type === "instant" ? "dissolve" : transition.type,
  });

  return (
    <div className="easing">
      <SegmentedControl
        label="Easing"
        options={[
          { value: "ease", label: "Ease" },
          { value: "spring", label: "Spring" },
          { value: "bezier", label: "Bezier" },
        ]}
        value={family}
        onChange={switchFamily}
      />
      <div className="easing__plot">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className="easing__svg"
          role="img"
          aria-label={`${EASING_LABEL[easing.type]} curve`}
        >
          <line className="easing__grid" x1={px(0)} y1={py(0)} x2={px(1)} y2={py(0)} />
          <line className="easing__grid" x1={px(0)} y1={py(1)} x2={px(1)} y2={py(1)} />
          <line className="easing__diagonal" x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} />
          {bezier ? (
            <>
              <line
                className="easing__arm"
                x1={px(0)}
                y1={py(0)}
                x2={px(bezier[0])}
                y2={py(bezier[1])}
              />
              <line
                className="easing__arm"
                x1={px(1)}
                y1={py(1)}
                x2={px(bezier[2])}
                y2={py(bezier[3])}
              />
            </>
          ) : null}
          <path className="easing__curve" d={curve} />
          {bezier ? (
            <>
              <circle
                className="easing__handle"
                data-active={dragging === 1 || undefined}
                cx={px(bezier[0])}
                cy={py(bezier[1])}
                r={4.5}
                onPointerDown={dragHandle(1)}
              />
              <circle
                className="easing__handle"
                data-active={dragging === 2 || undefined}
                cx={px(bezier[2])}
                cy={py(bezier[3])}
                r={4.5}
                onPointerDown={dragHandle(2)}
              />
            </>
          ) : null}
        </svg>
        <Preview easing={easing} ms={ms} />
      </div>

      {easing.type === "spring" ? (
        <>
          <div className="dp-row dp-row--3">
            <NumberField
              label="M"
              ariaLabel="Mass"
              value={easing.mass}
              min={0.1}
              max={10}
              step={0.1}
              precision={1}
              onChange={(mass) => setEasing({ ...easing, mass })}
              onScrubStart={onGestureStart}
              onScrubEnd={onGestureEnd}
            />
            <NumberField
              label="S"
              ariaLabel="Stiffness"
              value={easing.stiffness}
              min={1}
              max={2000}
              onChange={(stiffness) => setEasing({ ...easing, stiffness })}
              onScrubStart={onGestureStart}
              onScrubEnd={onGestureEnd}
            />
            <NumberField
              label="D"
              ariaLabel="Damping"
              value={easing.damping}
              min={0.1}
              max={200}
              onChange={(damping) => setEasing({ ...easing, damping })}
              onScrubStart={onGestureStart}
              onScrubEnd={onGestureEnd}
            />
          </div>
          <div className="easing__presets">
            {(Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[]).map((name) => {
              const preset = SPRING_PRESETS[name];
              const active =
                preset.mass === easing.mass &&
                preset.stiffness === easing.stiffness &&
                preset.damping === easing.damping;
              return (
                <button
                  key={name}
                  type="button"
                  className="easing__preset"
                  aria-pressed={active}
                  onClick={() => setEasing(preset)}
                >
                  {name[0]?.toUpperCase()}
                  {name.slice(1)}
                </button>
              );
            })}
            <span className="easing__settle">Settles in {springSettleMs(easing)} ms</span>
          </div>
        </>
      ) : (
        <div className="easing__row">
          {family === "ease" ? (
            <select
              className="inspector__select"
              aria-label="Ease"
              value={easing.type}
              onChange={(e) => setEasing({ type: e.target.value as (typeof PRESET_TYPES)[number] })}
            >
              {PRESET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {EASING_LABEL[type]}
                </option>
              ))}
            </select>
          ) : bezier ? (
            <BezierField bezier={bezier} onChange={setEasing} />
          ) : null}
          <NumberField
            label="ms"
            ariaLabel="Duration"
            value={transition.duration}
            min={0}
            max={10_000}
            step={10}
            onChange={(duration) => onChange({ ...transition, duration: Math.round(duration) })}
            onScrubStart={onGestureStart}
            onScrubEnd={onGestureEnd}
          />
        </div>
      )}
    </div>
  );
}

/** The bézier as CSS you can read, copy or paste over. */
function BezierField({ bezier, onChange }: { bezier: Bezier; onChange: (e: Easing) => void }) {
  // Just the four numbers: the field is narrow, and pasting a full cubic-bezier() works too.
  const text = bezier.map(round).join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseBezier(draft) === null;
  const commit = () => {
    if (draft === null) return;
    const parsed = parseBezier(draft);
    setDraft(null);
    if (parsed) {
      const [x1, y1, x2, y2] = parsed;
      onChange({ type: "bezier", x1, y1, x2, y2 });
    }
  };
  return (
    <input
      className="easing__css"
      aria-label="Cubic bézier"
      aria-invalid={invalid || undefined}
      spellCheck={false}
      value={draft ?? text}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** A puck that runs the easing across a track, for real, at the transition's speed. */
function Preview({ easing, ms }: { easing: Easing; ms: number }) {
  const puck = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => animation.current?.cancel(), []);
  const play = () => {
    const el = puck.current;
    if (!el) return;
    animation.current?.cancel();
    const run = el.animate([{ left: "0%" }, { left: "100%" }], {
      duration: Math.max(120, ms),
      easing: easingCss(easing),
      fill: "forwards",
    });
    animation.current = run;
    setPlaying(true);
    run.finished
      .then(() => setTimeout(() => run.cancel(), 500))
      .catch(() => {})
      .finally(() => setPlaying(false));
  };
  return (
    <div className="easing__preview">
      <span className="easing__track" aria-hidden="true">
        <span ref={puck} className="easing__puck" />
      </span>
      <IconButton
        icon={playing ? "restart" : "play"}
        label="Preview timing"
        size="sm"
        onClick={play}
      />
    </div>
  );
}
