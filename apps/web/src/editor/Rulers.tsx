/**
 * Rulers along the top and left of the canvas (⇧R). They measure from the
 * board you're working in (the top-level frame of the selection), like Figma
 * and the design sheet, highlight the selection's extent, and are where new
 * guides come from: drag out of a ruler onto the canvas.
 */
import type { Editor, Interaction, PointerInput } from "@drawpane/editor";
import { useEffect, useRef } from "react";
import { isMac } from "../app/format";
import { useEditor } from "./hooks";

/** Ruler thickness, and the gap between the two strips. */
export const RULER = 20;
export const RULER_GAP = 4;

/** Steps between labelled ticks, in page units; the first that leaves room for a label wins. */
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const MIN_LABEL_GAP = 56;

/** The labelled step for a zoom, and how many minor ticks divide it. */
export function rulerStep(zoom: number): { step: number; minor: number } {
  const step = STEPS.find((s) => s * zoom >= MIN_LABEL_GAP) ?? (STEPS.at(-1) as number);
  const px = step * zoom;
  const minor = px / 10 >= 6 ? 10 : px / 5 >= 6 ? 5 : 2;
  return { step, minor };
}

/** Where rulers measure from: the top-level frame holding the selection, else the page origin. */
export function rulerOrigin(editor: Editor): { x: number; y: number } {
  const { selection, pageId } = editor.s;
  const first = selection[0];
  if (!first || !pageId) return { x: 0, y: 0 };
  const top = [editor.doc.get(first), ...editor.doc.ancestors(first)].findLast(
    (n) => n && n.type !== "page",
  );
  if (top?.type !== "frame") return { x: 0, y: 0 };
  const b = editor.scene.bounds(top.id);
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
}

interface Colors {
  surface: string;
  tick: string;
  label: string;
  band: string;
  bandLabel: string;
  font: string;
}

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  return {
    surface: v("surface"),
    tick: v("line-control"),
    label: v("ink-muted"),
    band: v("signal-soft"),
    bandLabel: v("signal-ink"),
    font: v("font-mono") || "monospace",
  };
}

/** Draws one ruler. `axis` "x" is the top ruler; "y" the left one, with labels turned. */
function drawRuler(canvas: HTMLCanvasElement, editor: Editor, axis: "x" | "y", c: Colors): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const { camera, selection } = editor.s;
  const zoom = camera.zoom;
  const origin = rulerOrigin(editor);
  const o = axis === "x" ? origin.x : origin.y;
  // The ruler's own offset on screen: page p sits at camera(p) - start.
  const start = axis === "x" ? rect.left : rect.top;
  const length = axis === "x" ? rect.width : rect.height;
  const toRuler = (page: number) => (axis === "x" ? camera.x : camera.y) + page * zoom - start;
  const toPage = (px: number) => (px + start - (axis === "x" ? camera.x : camera.y)) / zoom;

  // The selection's extent: a soft band, and its edges as values.
  const bounds = editor.scene.unionBounds(selection);
  let band: [number, number] | null = null;
  if (bounds) {
    const a = toRuler(axis === "x" ? bounds.x : bounds.y);
    const b = toRuler(axis === "x" ? bounds.x + bounds.width : bounds.y + bounds.height);
    band = [a, b];
    ctx.fillStyle = c.band;
    if (axis === "x") ctx.fillRect(a, 0, Math.max(1, b - a), RULER);
    else ctx.fillRect(0, a, RULER, Math.max(1, b - a));
  }

  const { step, minor } = rulerStep(zoom);
  const first = Math.floor((toPage(0) - o) / step) * step;
  const last = toPage(length) - o;
  ctx.strokeStyle = c.tick;
  ctx.lineWidth = 1;
  ctx.font = `400 9px ${c.font}`;
  ctx.fillStyle = c.label;
  ctx.textBaseline = "top";
  const nearBand = (p: number) =>
    band !== null && (Math.abs(p - band[0]) < 28 || Math.abs(p - band[1]) < 28);
  ctx.beginPath();
  for (let v = first; v <= last + step; v += step) {
    for (let i = 0; i < minor; i++) {
      const value = v + (i * step) / minor;
      const p = Math.round(toRuler(value + o)) + 0.5;
      if (p < 0 || p > length) continue;
      const tick = i === 0 ? RULER - 4 : i === minor / 2 ? 7 : 4;
      if (axis === "x") {
        ctx.moveTo(p, RULER);
        ctx.lineTo(p, RULER - tick);
      } else {
        ctx.moveTo(RULER, p);
        ctx.lineTo(RULER - tick, p);
      }
    }
    const p = toRuler(v + o);
    if (p < -40 || p > length + 40 || nearBand(p)) continue;
    label(ctx, axis, p, formatValue(v));
  }
  ctx.stroke();

  if (band && bounds) {
    ctx.fillStyle = c.bandLabel;
    ctx.font = `600 9px ${c.font}`;
    const lo = axis === "x" ? bounds.x : bounds.y;
    const hi = lo + (axis === "x" ? bounds.width : bounds.height);
    label(ctx, axis, band[0], formatValue(lo - o));
    if (band[1] - band[0] > 24) label(ctx, axis, band[1], formatValue(hi - o));
  }
}

function label(ctx: CanvasRenderingContext2D, axis: "x" | "y", p: number, text: string): void {
  if (axis === "x") {
    ctx.fillText(text, p + 3, 3);
    return;
  }
  ctx.save();
  ctx.translate(3, p - 3);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function formatValue(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

export function Rulers({
  interaction,
  left,
  right,
}: {
  interaction: Interaction;
  /** Where the rulers start and end on screen, beside the panes. */
  left: number;
  right: number;
}) {
  const editor = useEditor();
  const top = useRef<HTMLCanvasElement>(null);
  const side = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let frame = 0;
    let colors = readColors();
    const draw = () => {
      frame = 0;
      if (top.current) drawRuler(top.current, editor, "x", colors);
      if (side.current) drawRuler(side.current, editor, "y", colors);
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const offState = editor.state.subscribe(request);
    const offDoc = editor.doc.subscribe(request);
    const resize = new ResizeObserver(request);
    if (top.current) resize.observe(top.current);
    if (side.current) resize.observe(side.current);
    // Theme changes recolor the rulers.
    const theme = new MutationObserver(() => {
      colors = readColors();
      request();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    draw();
    return () => {
      offState();
      offDoc();
      resize.disconnect();
      theme.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor]);

  /** Pointer events on a ruler drag out a new guide; the ruler holds the pointer until it lands. */
  const handlers = (axis: "x" | "y") => {
    const input = (e: React.PointerEvent): PointerInput => ({
      screen: { x: e.clientX, y: e.clientY },
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: isMac() ? e.metaKey : e.ctrlKey,
      clicks: 1,
    });
    return {
      onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0 || !editor.canEdit) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        interaction.beginGuide(axis, input(e));
      },
      onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) interaction.move(input(e));
      },
      onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        interaction.up(input(e));
      },
      onPointerCancel: () => interaction.cancel(),
    };
  };

  // Vertical guides come out of the left ruler, horizontal ones out of the top.
  return (
    <div className="rulers" style={{ left, right }} aria-hidden="true">
      <canvas
        ref={top}
        className="rulers__top"
        data-can-edit={editor.canEdit || undefined}
        {...handlers("y")}
      />
      <canvas
        ref={side}
        className="rulers__side"
        data-can-edit={editor.canEdit || undefined}
        {...handlers("x")}
      />
    </div>
  );
}
