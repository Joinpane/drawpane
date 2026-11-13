/**
 * What the canvas shows with the Prototype tab open: flow badges on starting
 * screens, a curve from every layer with an interaction to the screen it opens,
 * the selected layer's connection handle and the curve being dragged from it.
 *
 * Connections from the selection are solid in the signal colour with a label
 * that reads like the interaction; the rest are quiet dashed lines, so a busy
 * prototype stays legible.
 */
import { actionTarget, type Reaction } from "@drawpane/model";
import type { Editor } from "../editor";
import type { Point, Rect } from "../geometry";
import { type OverlayTheme, withAlpha } from "../overlay";
import { connectionHandle } from "../tools/connect";
import {
  hotspotIds,
  isLiveTarget,
  liveFlows,
  reactionsOf,
  screensOf,
  TRANSITION_LABEL,
  triggerLabel,
} from "./screens";

/** Where an arrow lands on a screen: this far below its top edge, in screen pixels. */
const LAND_PX = 36;

interface Connection {
  readonly source: string;
  readonly target: string;
  readonly reaction: Reaction;
}

function connectionsOn(editor: Editor, pageId: string): Connection[] {
  const doc = editor.doc;
  const out: Connection[] = [];
  for (const screen of screensOf(doc, pageId)) {
    for (const source of hotspotIds(doc, screen)) {
      for (const reaction of reactionsOf(doc.get(source))) {
        const target = actionTarget(reaction.action);
        if (target && isLiveTarget(doc, source, target)) out.push({ source, target, reaction });
      }
    }
  }
  return out;
}

/** A connection's label: "Tap → Dissolve". */
function shortLabel(reaction: Reaction): string {
  const trigger = triggerLabel(reaction.trigger).replace(/^(On|While|After) /, "");
  const action =
    reaction.action.type === "overlay"
      ? "Overlay"
      : reaction.action.type === "swap-overlay"
        ? "Swap"
        : TRANSITION_LABEL[reaction.transition.type];
  return `${trigger[0]?.toUpperCase() ?? ""}${trigger.slice(1)} → ${action}`;
}

/**
 * The curve between two screen points: leaves the source horizontally and
 * arrives horizontally, bending more the further apart they are.
 */
function curve(start: Point, end: Point, side: 1 | -1): [Point, Point, Point, Point] {
  const reach = Math.max(40, Math.abs(end.x - start.x) * 0.5);
  return [
    start,
    { x: start.x + reach * side, y: start.y },
    { x: end.x - reach * side, y: end.y },
    end,
  ];
}

function bezierPoint(c: readonly Point[], t: number): Point {
  const [a, b, d, e] = c as [Point, Point, Point, Point];
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * d.x + t * t * t * e.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * d.y + t * t * t * e.y,
  };
}

/** The connection's ends: from the source's facing edge to the target's facing edge, near its top. */
function ends(source: Rect, target: Rect, toScreen: (p: Point) => Point) {
  const forward = target.x + target.width / 2 >= source.x + source.width / 2;
  const a = toScreen(
    forward
      ? { x: source.x + source.width, y: source.y + source.height / 2 }
      : { x: source.x, y: source.y + source.height / 2 },
  );
  const tl = toScreen({ x: target.x, y: target.y });
  const br = toScreen({ x: target.x + target.width, y: target.y + target.height });
  const land = Math.min(LAND_PX, (br.y - tl.y) / 2);
  const b = forward ? { x: tl.x, y: tl.y + land } : { x: br.x, y: tl.y + land };
  return { a, b, side: (forward ? 1 : -1) as 1 | -1 };
}

export function drawPrototypeOverlay(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  theme: OverlayTheme,
): void {
  const { pageId, selection, camera, connecting } = editor.s;
  if (!pageId) return;
  const doc = editor.doc;
  const scene = editor.scene;
  const toScreen = (p: Point) => camera.toScreen(p);
  const selected = new Set(selection);

  const stroke = (c: readonly Point[], color: string, width: number, dash: number[]) => {
    const [a, b, d, e] = c as [Point, Point, Point, Point];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(b.x, b.y, d.x, d.y, e.x, e.y);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const arrowhead = (c: readonly Point[], color: string, size: number) => {
    const tip = c[3] as Point;
    const from = bezierPoint(c, 0.96);
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    ctx.save();
    ctx.translate(tip.x, tip.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size * 0.55);
    ctx.lineTo(-size * 0.7, 0);
    ctx.lineTo(-size, size * 0.55);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };
  const dot = (p: Point, color: string, fill: string, r = 3.5) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  const pill = (text: string, at: Point, fg: string, bg: string, border: string | null) => {
    ctx.font = `500 11px ${theme.fontUi}`;
    const w = Math.ceil(ctx.measureText(text).width) + 12;
    const h = 18;
    const x = Math.round(at.x - w / 2);
    const y = Math.round(at.y - h / 2);
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.fillStyle = bg;
    ctx.fill();
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, at.x, y + h / 2 + 0.5);
    ctx.textAlign = "left";
  };

  // Flow badges sit where the screen's name would be.
  const starts = new Map<string, string[]>();
  for (const flow of liveFlows(doc, pageId)) {
    starts.set(flow.start, [...(starts.get(flow.start) ?? []), flow.name]);
  }
  for (const [screen, names] of starts) {
    const b = scene.bounds(screen);
    if (!b) continue;
    const p = toScreen({ x: b.x, y: b.y });
    const text = names.join(", ");
    ctx.font = `600 11px ${theme.fontUi}`;
    const w = Math.ceil(ctx.measureText(text).width) + 26;
    const h = 18;
    const y = Math.round(p.y - h - 4);
    ctx.beginPath();
    ctx.roundRect(Math.round(p.x), y, w, h, 3);
    ctx.fillStyle = theme.signal;
    ctx.fill();
    // A small play triangle, then the flow names.
    ctx.beginPath();
    ctx.moveTo(p.x + 7, y + 5);
    ctx.lineTo(p.x + 14, y + 9);
    ctx.lineTo(p.x + 7, y + 13);
    ctx.closePath();
    ctx.fillStyle = theme.onSignal;
    ctx.fill();
    ctx.textBaseline = "middle";
    ctx.fillText(text, Math.round(p.x) + 19, y + h / 2 + 0.5);
  }

  // Connections: the quiet ones first, so the selection's draw on top.
  const all = connectionsOn(editor, pageId);
  const isActive = (c: Connection) => selected.has(c.source);
  const labels: { text: string; at: Point }[] = [];
  for (const pass of [false, true]) {
    for (const connection of all) {
      if (isActive(connection) !== pass) continue;
      if (connecting && connecting.from === connection.source) continue;
      const source = scene.bounds(connection.source);
      const target = scene.bounds(connection.target);
      if (!source || !target) continue;
      const { a, b, side } = ends(source, target, toScreen);
      const c = curve(a, b, side);
      if (pass) {
        stroke(c, theme.signal, 1.5, []);
        arrowhead(c, theme.signal, 8);
        dot(a, theme.signal, theme.surfaceRaised);
        labels.push({ text: shortLabel(connection.reaction), at: bezierPoint(c, 0.5) });
      } else {
        const muted = withAlpha(theme.inkMuted, 0.55);
        stroke(c, muted, 1, [4, 3]);
        arrowhead(c, muted, 6);
        dot(a, muted, theme.surfaceRaised, 2.5);
      }
    }
  }

  // The connection being dragged, and the screen it would land on.
  if (connecting) {
    const source = scene.bounds(connecting.from);
    if (source) {
      if (connecting.target) {
        const corners = scene.corners(connecting.target);
        if (corners) {
          const pts = corners.map(toScreen);
          ctx.beginPath();
          ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
          for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.closePath();
          ctx.strokeStyle = theme.signal;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      const target = connecting.target ? scene.bounds(connecting.target) : null;
      const pointer = toScreen(connecting.pointer);
      const start = toScreen({ x: source.x + source.width, y: source.y + source.height / 2 });
      const { a, b, side } = target
        ? ends(source, target, toScreen)
        : { a: start, b: pointer, side: (pointer.x >= start.x ? 1 : -1) as 1 | -1 };
      const c = curve(a, b, side);
      stroke(c, theme.signal, 1.5, []);
      arrowhead(c, theme.signal, 8);
      dot(a, theme.signal, theme.surfaceRaised);
    }
  }

  for (const label of labels) {
    pill(
      label.text,
      label.at,
      theme.ink ?? theme.inkMuted,
      theme.surfaceRaised,
      theme.border ?? null,
    );
  }

  // The handle you drag a new connection from.
  const handle = connecting ? null : connectionHandle(editor);
  if (handle && editor.canEdit) {
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = theme.signal;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.surfaceRaised;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(handle.x - 3, handle.y);
    ctx.lineTo(handle.x + 3, handle.y);
    ctx.moveTo(handle.x, handle.y - 3);
    ctx.lineTo(handle.x, handle.y + 3);
    ctx.strokeStyle = theme.onSignal;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Screens with a flow starting on them; the overlay draws their flow badge instead of their name. */
export function flowStartScreens(editor: Editor): ReadonlySet<string> {
  const { pageId, prototyping } = editor.s;
  if (!prototyping || !pageId) return new Set();
  return new Set(liveFlows(editor.doc, pageId).map((f) => f.start));
}
