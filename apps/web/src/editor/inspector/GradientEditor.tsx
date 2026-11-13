/**
 * Edits a linear or radial gradient: its handles on a preview, its stops on
 * a bar (click to add, drag to move, Delete to remove), each stop's position,
 * color and opacity, and the selected stop's color in a full picker.
 */
import { ColorPicker, IconButton, NumberField, SegmentedControl, toHex } from "@drawpane/ui";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import {
  CHECKER,
  colorAt,
  type GradientPaint,
  gradientAngle,
  gradientCss,
  handlesForAngle,
  rgbaOf,
  swatchCss,
} from "./paint";

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export interface GradientEditorProps {
  paint: GradientPaint;
  /** `label` names the undo step. */
  onChange: (next: GradientPaint, label: string) => void;
  onChangeStart: () => void;
  onChangeEnd: () => void;
  label: string;
}

export function GradientEditor({
  paint,
  onChange,
  onChangeStart,
  onChangeEnd,
  label,
}: GradientEditorProps) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, paint.stops.length - 1);
  const stop = paint.stops[index] ?? paint.stops[0];

  const setStops = (stops: GradientPaint["stops"], name: string) =>
    onChange({ ...paint, stops }, name);
  const updateStop = (i: number, patch: Partial<GradientPaint["stops"][number]>, name: string) =>
    setStops(
      paint.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)),
      name,
    );
  const addStop = (position: number) => {
    const p = round4(clamp01(position));
    setStops([...paint.stops, { position: p, color: colorAt(paint, p) }], "Add gradient stop");
    setSelected(paint.stops.length);
  };
  const removeStop = (i: number) => {
    if (paint.stops.length <= 2) return;
    setStops(
      paint.stops.filter((_, j) => j !== i),
      "Remove gradient stop",
    );
    setSelected(Math.max(0, i - 1));
  };
  const reverse = () =>
    setStops(
      paint.stops.map((s) => ({ ...s, position: round4(1 - s.position) })),
      "Reverse gradient",
    );

  const order = paint.stops
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.position - b.s.position || a.i - b.i);

  return (
    <div className="gradient-editor">
      <div className="gradient-editor__head">
        <SegmentedControl
          label="Gradient type"
          options={[
            { value: "linear", label: "Linear" },
            { value: "radial", label: "Radial" },
          ]}
          value={paint.type}
          onChange={(type) =>
            onChange(
              type === "radial"
                ? { ...paint, type, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } }
                : { ...paint, type, ...handlesForAngle(180) },
              "Gradient type",
            )
          }
        />
        {paint.type === "linear" ? (
          <NumberField
            icon="rotate"
            ariaLabel="Gradient angle"
            unit="°"
            precision={0}
            value={gradientAngle(paint)}
            onChange={(angle) =>
              onChange({ ...paint, ...handlesForAngle(angle) }, "Gradient angle")
            }
            onScrubStart={onChangeStart}
            onScrubEnd={onChangeEnd}
          />
        ) : (
          <span />
        )}
        <IconButton icon="flip-horizontal" label="Reverse stops" onClick={reverse} />
      </div>
      <HandlePreview
        paint={paint}
        onChange={onChange}
        onStart={onChangeStart}
        onEnd={onChangeEnd}
      />
      <StopBar
        paint={paint}
        selected={index}
        onSelect={setSelected}
        onAdd={addStop}
        onRemove={removeStop}
        onMove={(i, position) =>
          updateStop(i, { position: round4(position) }, "Move gradient stop")
        }
        onStart={onChangeStart}
        onEnd={onChangeEnd}
      />
      <div className="gradient-editor__stops-head">
        <span>Stops</span>
        <IconButton icon="plus" label="Add stop" onClick={() => addStop(0.5)} />
      </div>
      <div className="gradient-editor__stops" role="listbox" aria-label="Gradient stops">
        {order.map(({ s, i }) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: rows hold their own fields; arrows move on the bar
          <div
            key={i}
            className="gradient-editor__stop"
            role="option"
            aria-selected={i === index}
            tabIndex={-1}
            onClick={() => setSelected(i)}
          >
            <NumberField
              ariaLabel="Stop position"
              unit="%"
              min={0}
              max={100}
              precision={1}
              value={Math.round(s.position * 1000) / 10}
              onChange={(v) =>
                updateStop(i, { position: round4(clamp01(v / 100)) }, "Move gradient stop")
              }
              onFocus={() => setSelected(i)}
              onScrubStart={onChangeStart}
              onScrubEnd={onChangeEnd}
            />
            <span
              className="gradient-editor__swatch"
              style={{ background: swatchCss({ type: "solid", color: s.color }) }}
              aria-hidden="true"
            />
            <span className="gradient-editor__hex">{s.color.slice(1, 7).toUpperCase()}</span>
            <NumberField
              ariaLabel="Stop opacity"
              unit="%"
              min={0}
              max={100}
              precision={0}
              value={Math.round(rgbaOf(s.color).a * 100)}
              onChange={(v) => {
                const c = rgbaOf(s.color);
                updateStop(i, { color: toHex({ ...c, a: clamp01(v / 100) }) }, "Stop opacity");
              }}
              onFocus={() => setSelected(i)}
            />
            <IconButton
              icon="minus"
              label="Remove stop"
              disabled={paint.stops.length <= 2}
              onClick={(e) => {
                e.stopPropagation();
                removeStop(i);
              }}
            />
          </div>
        ))}
      </div>
      {stop ? (
        <ColorPicker
          label={`${label} stop`}
          value={stop.color}
          onChange={(color) => updateStop(index, { color }, "Stop color")}
          onChangeStart={onChangeStart}
          onChangeEnd={onChangeEnd}
        />
      ) : null}
    </div>
  );
}

/** Drags with pointer capture, reporting 0–1 fractions of `el`'s box. */
function dragOn(
  el: HTMLElement,
  e: PointerEvent<HTMLElement>,
  move: (fx: number, fy: number) => void,
  onStart: () => void,
  onEnd: () => void,
) {
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  onStart();
  const at = (ev: globalThis.PointerEvent) => {
    const r = el.getBoundingClientRect();
    move(
      clamp01((ev.clientX - r.left) / (r.width || 1)),
      clamp01((ev.clientY - r.top) / (r.height || 1)),
    );
  };
  const up = () => {
    target.removeEventListener("pointermove", at);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("lostpointercapture", up);
    onEnd();
  };
  target.addEventListener("pointermove", at);
  target.addEventListener("pointerup", up);
  target.addEventListener("lostpointercapture", up);
}

/** The gradient on a preview, with its start and end handles to drag. */
function HandlePreview({
  paint,
  onChange,
  onStart,
  onEnd,
}: {
  paint: GradientPaint;
  onChange: (next: GradientPaint, label: string) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const handle = (which: "from" | "to") => (
    <button
      type="button"
      className="gradient-editor__handle"
      data-handle={which}
      aria-label={
        which === "from"
          ? "Gradient start"
          : paint.type === "radial"
            ? "Gradient radius"
            : "Gradient end"
      }
      style={{ left: `${paint[which].x * 100}%`, top: `${paint[which].y * 100}%` }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !box.current) return;
        e.preventDefault();
        dragOn(
          box.current,
          e,
          (fx, fy) =>
            onChange({ ...paint, [which]: { x: round4(fx), y: round4(fy) } }, "Gradient handles"),
          onStart,
          onEnd,
        );
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.01;
        const d: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = d[e.key];
        if (!delta) return;
        e.preventDefault();
        e.stopPropagation();
        const p = paint[which];
        onChange(
          {
            ...paint,
            [which]: { x: round4(clamp01(p.x + delta[0])), y: round4(clamp01(p.y + delta[1])) },
          },
          "Gradient handles",
        );
      }}
    />
  );
  return (
    <div
      ref={box}
      className="gradient-editor__preview"
      style={{ background: `${gradientCss(paint, true)}, ${CHECKER}` }}
    >
      <svg
        className="gradient-editor__line"
        aria-hidden="true"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <line
          x1={paint.from.x * 100}
          y1={paint.from.y * 100}
          x2={paint.to.x * 100}
          y2={paint.to.y * 100}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {handle("from")}
      {handle("to")}
    </div>
  );
}

/** The stops on a bar: click empty space to add, drag to move, arrows and Delete on a focused stop. */
function StopBar({
  paint,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onStart,
  onEnd,
}: {
  paint: GradientPaint;
  selected: number;
  onSelect: (i: number) => void;
  onAdd: (position: number) => void;
  onRemove: (i: number) => void;
  onMove: (i: number, position: number) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const linear = { ...paint, type: "linear" as const, ...handlesForAngle(90) };
  return (
    <div className="gradient-editor__bar-wrap">
      <div
        ref={bar}
        className="gradient-editor__bar"
        style={{ background: `${gradientCss(linear, true)}, ${CHECKER}` }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          onAdd((e.clientX - r.left) / (r.width || 1));
        }}
      >
        {paint.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className="gradient-editor__marker"
            aria-label={`Stop at ${Math.round(s.position * 100)}%`}
            aria-pressed={i === selected}
            style={{
              left: `${s.position * 100}%`,
              background: swatchCss({ type: "solid", color: s.color }),
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !bar.current) return;
              e.preventDefault();
              e.currentTarget.focus();
              onSelect(i);
              dragOn(bar.current, e, (fx) => onMove(i, fx), onStart, onEnd);
            }}
            onFocus={() => onSelect(i)}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
              if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                e.stopPropagation();
                onRemove(i);
                return;
              }
              const step = e.shiftKey ? 0.1 : 0.01;
              const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
              if (!d) return;
              e.preventDefault();
              e.stopPropagation();
              onMove(i, clamp01(s.position + d));
            }}
          />
        ))}
      </div>
    </div>
  );
}
