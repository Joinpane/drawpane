/**
 * The minimap: the page in miniature at the canvas's bottom left, with the
 * part you can see outlined and a dot where each person on the page is
 * pointing. Click or drag in it to move the view; drag the outline to carry
 * it. ⌥M shows or hides it, and it steps aside when the canvas is too narrow
 * to hold it beside the zoom controls.
 *
 * Drawn on a canvas (crisp at any pixel ratio), at most once a frame, from
 * `minimapModel`: the page's top-level layers, so it stays cheap on big files.
 */
import {
  fromMinimap,
  type MinimapFit,
  type MinimapModel,
  minimapFit,
  minimapModel,
  toMinimap,
} from "@drawpane/editor";
import { getProp } from "@drawpane/model";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useEditor, useEditorState } from "./hooks";
import type { Box } from "./lens-placement";
import { useUi } from "./ui-state";

/** The card's width, and the map's height inside it (the design's 168 × 72). */
const CARD_WIDTH = 168;
const MAP_HEIGHT = 72;
const PADDING = 8;
const MAP_WIDTH = CARD_WIDTH - PADDING * 2;
/** Half the zoom controls' width, plus breathing room: the minimap mustn't reach them. */
const ZOOM_HALF = 84;
const GUTTER = 12;
/** The card's height: its padding, the 14px heading and 6px under it, and the map. */
const CARD_HEIGHT = PADDING * 2 + 14 + 6 + MAP_HEIGHT;

/**
 * Where the minimap sits on the canvas, or null while it's hidden (switched
 * off, or no room beside the zoom controls). The Selection Lens keeps clear of it.
 */
export function minimapBox(
  shown: boolean,
  insetLeft: number,
  viewport: { readonly width: number; readonly height: number },
): Box | null {
  const left = insetLeft + GUTTER;
  const roomy = left + CARD_WIDTH + GUTTER <= viewport.width / 2 - ZOOM_HALF;
  if (!shown || !roomy) return null;
  return {
    x: left,
    y: viewport.height - GUTTER - CARD_HEIGHT,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  };
}

interface Colors {
  readonly canvas: string;
  readonly board: string;
  readonly line: string;
  readonly signal: string;
  readonly agent: string;
  readonly ring: string;
  readonly presence: readonly string[];
}

function colorsOf(el: Element): Colors {
  const style = getComputedStyle(el);
  const v = (name: string) => style.getPropertyValue(name).trim();
  return {
    canvas: v("--canvas"),
    board: v("--surface-raised"),
    line: v("--line-strong"),
    signal: v("--signal"),
    agent: v("--agent"),
    ring: v("--surface"),
    presence: Array.from({ length: 8 }, (_, i) => v(`--presence-${i + 1}`)),
  };
}

function draw(canvas: HTMLCanvasElement, model: MinimapModel, fit: MinimapFit): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(MAP_WIDTH * ratio);
  const height = Math.round(MAP_HEIGHT * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const c = colorsOf(canvas);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  /** A rect on the map, at least `min` pixels each way (grown about its centre), so it still shows. */
  const box = (r: { x: number; y: number; width: number; height: number }, min: number) => {
    const a = toMinimap(fit, r);
    const w = r.width * fit.scale;
    const h = r.height * fit.scale;
    const W = Math.max(min, w);
    const H = Math.max(min, h);
    return { x: a.x - (W - w) / 2, y: a.y - (H - h) / 2, w: W, h: H };
  };

  for (const layer of model.layers) {
    const b = box(layer.rect, 2);
    ctx.globalAlpha = layer.hidden ? 0.5 : 1;
    if (layer.board) {
      ctx.fillStyle = c.board;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(0, b.w - 1), Math.max(0, b.h - 1));
    } else {
      ctx.fillStyle = c.line;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }
  ctx.globalAlpha = 1;

  // The visible area: the signal outline, a faint wash inside.
  // Never smaller than a few pixels: on a spread-out page, you still see where you are.
  const v = box(model.view, 8);
  ctx.beginPath();
  ctx.roundRect(v.x + 0.75, v.y + 0.75, Math.max(0, v.w - 1.5), Math.max(0, v.h - 1.5), 2);
  ctx.fillStyle = withAlpha(c.signal, 0.08);
  ctx.fill();
  ctx.strokeStyle = c.signal;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  for (const peer of model.peers) {
    const p = toMinimap(fit, peer.at);
    const color = peer.agent ? c.agent : (c.presence[(peer.color - 1) % 8] ?? c.signal);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    if (peer.pointing) {
      // Their pointer: a dot.
      ctx.fillStyle = color;
      ctx.strokeStyle = c.ring;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    } else {
      // Their pointer is off the canvas: a ring where they're looking.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/** `#rrggbb` with an alpha, for the outline's wash. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = Number.parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function Minimap() {
  const editor = useEditor();
  const shown = useUi(editor, (s) => s.minimap);
  const insetLeft = useEditorState((s) => s.insets.left);
  const viewport = useEditorState((s) => s.viewport);
  const pageId = useEditorState((s) => s.pageId);
  const canvas = useRef<HTMLCanvasElement>(null);
  // While dragging, the map holds still: the view moves inside it.
  const drag = useRef<{ fit: MinimapFit; offset: { x: number; y: number } } | null>(null);
  const fit = useRef<MinimapFit | null>(null);
  const [summary, setSummary] = useState({ page: "", boards: 0 });
  const [grabbing, setGrabbing] = useState(false);
  /** Redraws on the next frame. */
  const redraw = useRef(() => {});

  const box = minimapBox(shown, insetLeft, viewport);
  const visible = box !== null && pageId !== null;
  const left = box?.x ?? 0;

  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const render = () => {
      frame = 0;
      const el = canvas.current;
      const model = minimapModel(editor);
      if (!el || !model) return;
      const next = drag.current?.fit ?? minimapFit(model.bounds, MAP_WIDTH, MAP_HEIGHT);
      fit.current = next;
      draw(el, model, next);
      const page = editor.s.pageId ? editor.doc.get(editor.s.pageId) : undefined;
      const name = page ? getProp(page.props, "name") || "Page" : "";
      setSummary((s) =>
        s.page === name && s.boards === model.boards ? s : { page: name, boards: model.boards },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redraw.current = schedule;
    render();
    const offState = editor.state.subscribe(schedule);
    const offDoc = editor.doc.subscribe(schedule);
    // The theme can change under it (the colors are read from tokens).
    const themes = new MutationObserver(schedule);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", schedule);
    return () => {
      offState();
      offDoc();
      themes.disconnect();
      scheme.removeEventListener("change", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, visible]);

  if (!visible) return null;

  const pointAt = (e: ReactPointerEvent<HTMLCanvasElement>, f: MinimapFit) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return fromMinimap(f, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  const inView = (p: { x: number; y: number }) => {
    const v = editor.visibleArea();
    return !!v && p.x >= v.x && p.x <= v.x + v.width && p.y >= v.y && p.y <= v.y + v.height;
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !fit.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = fit.current;
    const p = pointAt(e, f);
    const v = editor.visibleArea();
    // Grabbing the outline carries it from where it was grabbed; elsewhere, the view jumps there.
    const offset =
      v && inView(p)
        ? { x: p.x - (v.x + v.width / 2), y: p.y - (v.y + v.height / 2) }
        : { x: 0, y: 0 };
    drag.current = { fit: f, offset };
    setGrabbing(true);
    editor.centerOn({ x: p.x - offset.x, y: p.y - offset.y });
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = pointAt(e, d.fit);
    editor.centerOn({ x: p.x - d.offset.x, y: p.y - d.offset.y });
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    setGrabbing(false);
    // The map refits now the view has settled.
    redraw.current();
  };

  const boards = summary.boards === 1 ? "1 board" : `${summary.boards} boards`;
  return (
    <section className="minimap pane" style={{ left }} aria-label="Minimap">
      <div className="minimap__head" title={`${summary.page} · ${boards}`}>
        <span className="minimap__page">{summary.page}</span>
        <span aria-hidden="true">·</span>
        <span>{boards}</span>
      </div>
      <canvas
        ref={canvas}
        className="minimap__map"
        data-grabbing={grabbing || undefined}
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
        role="img"
        aria-label={`Map of ${summary.page}: ${boards}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </section>
  );
}
