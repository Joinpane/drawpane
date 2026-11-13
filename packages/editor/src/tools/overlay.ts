/**
 * Overlay marks for the pen and vector edit: the path outline, handles and
 * anchors, the pen's rubber band, and a coordinate tag on a lone selected
 * anchor. Only the edited path is drawn, so this stays cheap at 500+ anchors.
 *
 * Everything here is yours, so it is signal (the brand book's canvas
 * semantics): anchors are 7px white squares with a signal outline, filled
 * when selected; Bézier handles are 7px white circles on 1px signal stems.
 */
import type { Editor } from "../editor";
import { apply, boxOf, localMatrix, type Matrix, multiply, type Point } from "../geometry";
import type { Interaction } from "../interaction";
import type { OverlayTheme } from "../overlay";
import { type Anchor, anchorKey, anchorKind, type VectorPath } from "../vector/path";
import { visibleHandles } from "./vector-edit";

const ANCHOR = 7;
const KNOB_R = 3.5;

export function drawVectorOverlay(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  interaction: Interaction,
  theme: OverlayTheme,
): void {
  const { camera, vectorEdit, tool } = editor.s;
  const view: Matrix = [camera.zoom, 0, 0, camera.zoom, camera.x, camera.y];

  if (vectorEdit) {
    const node = editor.doc.get(vectorEdit.id);
    const path = editor.pathOf(vectorEdit.id);
    if (!node || !path) return;
    const m = multiply(view, editor.scene.worldMatrix(node.id));
    const selected = new Set(vectorEdit.anchors);
    outline(ctx, path, m, theme.signal);
    const marks = visibleHandles(path, vectorEdit.anchors).map((h) => {
      const a = path[h.ref.s]?.anchors[h.ref.i] as Anchor;
      return { from: apply(m, a), to: apply(m, h.at) };
    });
    handles(ctx, marks, theme.signal);
    path.forEach((sub, s) => {
      sub.anchors.forEach((a, i) => {
        anchorMark(ctx, apply(m, a), selected.has(anchorKey({ s, i })), theme.signal);
      });
    });
    if (vectorEdit.anchors.length === 1) {
      const key = vectorEdit.anchors[0] as string;
      const [s, i] = key.split(":").map(Number);
      const a = path[s ?? -1]?.anchors[i ?? -1];
      if (a) {
        // Coordinates in the layer's parent space, like the inspector's X and Y.
        const p = apply(localMatrix(boxOf(node)), a);
        const avoid = marks.map((h) => h.to);
        tag(ctx, apply(m, a), `${num(p.x)}, ${num(p.y)} · ${anchorKind(a)}`, theme, avoid);
      }
    }
    return;
  }

  if (tool === "pen") {
    const preview = interaction.pen.preview();
    const pointer = editor.s.vectorPointer;
    if (!preview) {
      if (pointer) anchorMark(ctx, camera.toScreen(pointer), false, theme.signal, 0.6);
      return;
    }
    const { anchors, closed } = preview;
    const path: VectorPath = [{ anchors, closed }];
    outline(ctx, path, view, theme.signal);
    // Rubber band from the last anchor to the pointer.
    const last = anchors[anchors.length - 1];
    if (last && pointer && !closed && !preview.dragging) {
      const a = camera.toScreen(last);
      const target = preview.nearFirst && anchors[0] ? anchors[0] : pointer;
      const p = camera.toScreen(target);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if (last.out) {
        const c = camera.toScreen(last.out);
        ctx.bezierCurveTo(c.x, c.y, p.x, p.y, p.x, p.y);
      } else ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = theme.signal;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (last) {
      const marks: Array<{ from: Point; to: Point }> = [];
      if (last.in) marks.push({ from: camera.toScreen(last), to: camera.toScreen(last.in) });
      if (last.out) marks.push({ from: camera.toScreen(last), to: camera.toScreen(last.out) });
      handles(ctx, marks, theme.signal);
    }
    anchors.forEach((a, i) => {
      const filled = i === anchors.length - 1 || (i === 0 && preview.nearFirst);
      anchorMark(ctx, camera.toScreen(a), filled, theme.signal);
    });
  }
}

function outline(ctx: CanvasRenderingContext2D, path: VectorPath, m: Matrix, color: string) {
  ctx.beginPath();
  for (const sub of path) {
    const n = sub.anchors.length;
    const first = sub.anchors[0];
    if (!first) continue;
    const p0 = apply(m, first);
    ctx.moveTo(p0.x, p0.y);
    const count = n < 2 ? 0 : sub.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = sub.anchors[i] as Anchor;
      const b = sub.anchors[(i + 1) % n] as Anchor;
      const p = apply(m, b);
      if (!a.out && !b.in) ctx.lineTo(p.x, p.y);
      else {
        const c1 = apply(m, a.out ?? a);
        const c2 = apply(m, b.in ?? b);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
      }
    }
    if (sub.closed) ctx.closePath();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.stroke();
}

function handles(
  ctx: CanvasRenderingContext2D,
  marks: ReadonlyArray<{ from: Point; to: Point }>,
  color: string,
) {
  if (marks.length === 0) return;
  ctx.beginPath();
  for (const { from, to } of marks) {
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  for (const { to } of marks) {
    ctx.beginPath();
    ctx.arc(to.x, to.y, KNOB_R, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function anchorMark(
  ctx: CanvasRenderingContext2D,
  p: Point,
  selected: boolean,
  signal: string,
  alpha = 1,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(
    Math.round(p.x - ANCHOR / 2) + 0.5,
    Math.round(p.y - ANCHOR / 2) + 0.5,
    ANCHOR - 1,
    ANCHOR - 1,
  );
  ctx.fillStyle = selected ? signal : "#ffffff";
  ctx.fill();
  ctx.strokeStyle = signal;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** A coordinate tag beside an anchor, in the first corner that doesn't cover a handle. */
function tag(
  ctx: CanvasRenderingContext2D,
  p: Point,
  label: string,
  theme: OverlayTheme,
  avoid: readonly Point[],
) {
  ctx.font = `500 11px ${theme.fontMono ?? theme.fontUi}`;
  const w = ctx.measureText(label).width + 12;
  const h = 16;
  const corners = [
    { x: p.x + 10, y: p.y - 10 - h },
    { x: p.x + 10, y: p.y + 10 },
    { x: p.x - 10 - w, y: p.y - 10 - h },
    { x: p.x - 10 - w, y: p.y + 10 },
  ];
  const clear = (c: Point) =>
    avoid.every(
      (q) =>
        q.x < c.x - KNOB_R - 2 ||
        q.x > c.x + w + KNOB_R + 2 ||
        q.y < c.y - KNOB_R - 2 ||
        q.y > c.y + h + KNOB_R + 2,
    );
  const at = corners.find(clear) ?? (corners[0] as Point);
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  ctx.fillStyle = theme.signal;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 16, 3);
  ctx.fill();
  ctx.fillStyle = theme.onSignal;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 6, y + 8.5);
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}
