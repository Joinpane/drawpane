/**
 * The overlay: everything drawn on top of the design that isn't the design.
 * Selection, hover, handles, size pill, marquee, smart guides, artboard
 * labels, Layout X-ray and collaborators. It repaints on every pointer move,
 * so it stays cheap: no shadows, no text layout beyond labels.
 */
import { getProp } from "@drawpane/model";
import type { Editor } from "./editor";
import { apply, type Point } from "./geometry";
import type { Interaction } from "./interaction";

export interface OverlayTheme {
  signal: string;
  componentInk: string;
  onSignal: string;
  guide: string;
  component: string;
  inkMuted: string;
  surfaceRaised: string;
  xrayPadding: string;
  xrayGap: string;
  presence: readonly string[];
  onPresence: string;
  agent: string;
  onAgent: string;
  fontUi: string;
}

const HANDLE = 7;

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  interaction: Interaction,
  theme: OverlayTheme,
  dpr: number,
): void {
  const {
    camera,
    selection,
    hover,
    marquee,
    guides,
    pageId,
    xray,
    editingText,
    focusMode,
    peers,
    gesture,
  } = editor.s;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!pageId) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scene = editor.scene;
  const doc = editor.doc;
  const toScreen = (p: Point) => camera.toScreen(p);

  const quad = (corners: Point[], color: string, width: number, dash: number[] = []) => {
    if (corners.length < 4) return;
    ctx.beginPath();
    const pts = corners.map(toScreen);
    ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Artboard labels: names above top-level frames.
  ctx.font = `500 11px ${theme.fontUi}`;
  ctx.textBaseline = "bottom";
  for (const id of doc.childIds(pageId)) {
    const node = doc.get(id);
    if (node?.type !== "frame" || node.props.visible === false) continue;
    const corners = scene.corners(id);
    if (!corners) continue;
    const p = toScreen(corners[0] as Point);
    const selected = selection.includes(id);
    const isComponent = getProp(node.props, "isComponent");
    const isInstance = getProp(node.props, "instanceOf") !== null;
    let x = p.x;
    if (isComponent || isInstance) {
      // Components and instances wear the component colour, with a small diamond.
      drawDiamond(ctx, x + 4, p.y - 9.5, isComponent, theme.component);
      x += 12;
    }
    ctx.fillStyle = selected
      ? theme.signal
      : isComponent || isInstance
        ? theme.componentInk
        : theme.inkMuted;
    ctx.fillText(getProp(node.props, "name") || "Frame", x, p.y - 4);
  }

  // Layout X-ray: padding and gaps of the selected or hovered auto-layout frame.
  if (xray) {
    const ids = new Set([...selection, ...(hover ? [hover] : [])]);
    for (const id of ids) {
      const frameId = doc.get(id)?.type === "frame" ? id : doc.get(id)?.parent;
      const frame = frameId ? doc.get(frameId) : undefined;
      if (frame?.type !== "frame" || getProp(frame.props, "layoutMode") === "none") continue;
      drawXray(ctx, editor, frame.id, theme);
    }
  }

  // Collaborators: their selections, then cursors with name tags.
  if (!focusMode) {
    for (const peer of peers.values()) {
      const presence = peer.presence;
      if (!presence || presence.pageId !== pageId) continue;
      const color =
        peer.kind === "agent"
          ? theme.agent
          : (theme.presence[(peer.color - 1) % theme.presence.length] ?? theme.guide);
      for (const id of presence.selection) {
        const corners = scene.corners(id);
        if (corners)
          quad(
            corners,
            color,
            peer.kind === "agent" ? 1.5 : 1,
            peer.kind === "agent" ? [4, 3] : [],
          );
      }
    }
  }

  // Hover outline: components and instances in their own colour.
  if (hover && !selection.includes(hover) && !gesture) {
    const corners = scene.corners(hover);
    const hovered = doc.get(hover);
    const isComponentish =
      hovered?.type === "frame" &&
      (getProp(hovered.props, "isComponent") || getProp(hovered.props, "instanceOf") !== null);
    if (corners) quad(corners, isComponentish ? theme.component : theme.signal, 1);
  }

  // Selection: each layer's outline, then one set of handles.
  if (!editingText || selection.length > 1) {
    for (const id of selection) {
      const corners = scene.corners(id);
      if (corners) quad(corners, theme.signal, 1.5);
    }
  }
  const frame = interaction.selectionFrame();
  if (frame && selection.length > 0) {
    const corners = [
      { x: 0, y: 0 },
      { x: frame.width, y: 0 },
      { x: frame.width, y: frame.height },
      { x: 0, y: frame.height },
    ].map((p) => apply(frame.matrix, p));
    if (selection.length > 1) quad(corners, theme.signal, 1);
    if (editor.canEdit && !editingText) {
      const screenW = frame.width * camera.zoom;
      const screenH = frame.height * camera.zoom;
      const small = screenW < 24 || screenH < 24;
      const points: Point[] = [...corners];
      if (!small) {
        for (let i = 0; i < 4; i++) {
          const a = corners[i] as Point;
          const b = corners[(i + 1) % 4] as Point;
          points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
      for (const p of points.map(toScreen)) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = theme.signal;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(
          Math.round(p.x - HANDLE / 2) + 0.5,
          Math.round(p.y - HANDLE / 2) + 0.5,
          HANDLE - 1,
          HANDLE - 1,
        );
        ctx.fill();
        ctx.stroke();
      }
    }
    // Size pill under the selection.
    const bounds = scene.unionBounds(selection);
    if (bounds) {
      const label = `${fmt(frame.width)} × ${fmt(frame.height)}`;
      const bottom = toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
      ctx.font = `600 11px ${theme.fontUi}`;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = theme.signal;
      ctx.beginPath();
      ctx.roundRect(bottom.x - w / 2, bottom.y + 8, w, 18, 3);
      ctx.fill();
      ctx.fillStyle = theme.onSignal;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(label, bottom.x, bottom.y + 17.5);
      ctx.textAlign = "left";
    }
  }

  // Smart guides.
  if (guides.length > 0) {
    ctx.strokeStyle = theme.guide;
    ctx.lineWidth = 1;
    for (const g of guides) {
      const a = toScreen(g.axis === "x" ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
      const b = toScreen(g.axis === "x" ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
      ctx.beginPath();
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
      ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
      ctx.stroke();
    }
  }

  // Marquee.
  if (marquee) {
    const a = toScreen({ x: marquee.x, y: marquee.y });
    ctx.fillStyle = withAlpha(theme.signal, 0.08);
    ctx.strokeStyle = theme.signal;
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, marquee.width * camera.zoom, marquee.height * camera.zoom);
    ctx.strokeRect(
      Math.round(a.x) + 0.5,
      Math.round(a.y) + 0.5,
      Math.round(marquee.width * camera.zoom),
      Math.round(marquee.height * camera.zoom),
    );
  }

  if (!focusMode) {
    for (const peer of peers.values()) {
      const cursor = peer.presence?.cursor;
      if (!cursor || peer.presence?.pageId !== pageId) continue;
      const color =
        peer.kind === "agent"
          ? theme.agent
          : (theme.presence[(peer.color - 1) % theme.presence.length] ?? theme.guide);
      drawCursor(
        ctx,
        toScreen(cursor),
        color,
        peer.kind === "agent" ? theme.onAgent : theme.onPresence,
        peer.name,
        theme.fontUi,
      );
    }
  }
}

/** The component glyph: a diamond, solid inside for a main component. */
function drawDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  solid: boolean,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, -4.5);
  ctx.lineTo(4.5, 0);
  ctx.lineTo(0, 4.5);
  ctx.lineTo(-4.5, 0);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  if (solid) {
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(2, 0);
    ctx.lineTo(0, 2);
    ctx.lineTo(-2, 0);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

function drawXray(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  frameId: string,
  theme: OverlayTheme,
): void {
  const doc = editor.doc;
  const frame = doc.get(frameId);
  if (!frame) return;
  const p = frame.props;
  const m = editor.scene.worldMatrix(frameId);
  const w = getProp(p, "width");
  const h = getProp(p, "height");
  const top = getProp(p, "paddingTop");
  const right = getProp(p, "paddingRight");
  const bottom = getProp(p, "paddingBottom");
  const left = getProp(p, "paddingLeft");
  const camera = editor.s.camera;
  const fillLocal = (x: number, y: number, rw: number, rh: number, color: string) => {
    if (rw <= 0 || rh <= 0) return;
    const pts = [
      { x, y },
      { x: x + rw, y },
      { x: x + rw, y: y + rh },
      { x, y: y + rh },
    ].map((pt) => camera.toScreen(apply(m, pt)));
    ctx.beginPath();
    ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
    for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  const padding = withAlpha(theme.xrayPadding, 0.35);
  fillLocal(0, 0, w, top, padding);
  fillLocal(0, h - bottom, w, bottom, padding);
  fillLocal(0, top, left, h - top - bottom, padding);
  fillLocal(w - right, top, right, h - top - bottom, padding);
  // Gaps between consecutive children along the main axis.
  const row = getProp(p, "layoutMode") === "row";
  const children = doc
    .childIds(frameId)
    .map((id) => doc.get(id))
    .filter((c) => c && c.props.visible !== false && getProp(c.props, "positioning") === "auto");
  const gapColor = withAlpha(theme.xrayGap, 0.35);
  for (let i = 0; i < children.length - 1; i++) {
    const a = children[i];
    const b = children[i + 1];
    if (!a || !b) continue;
    if (row) {
      const x = getProp(a.props, "x") + getProp(a.props, "width");
      fillLocal(x, top, getProp(b.props, "x") - x, h - top - bottom, gapColor);
    } else {
      const y = getProp(a.props, "y") + getProp(a.props, "height");
      fillLocal(left, y, w - left - right, getProp(b.props, "y") - y, gapColor);
    }
  }
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  p: Point,
  color: string,
  ink: string,
  name: string,
  font: string,
): void {
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 14);
  ctx.lineTo(3.8, 10.6);
  ctx.lineTo(6.6, 16.4);
  ctx.lineTo(8.8, 15.4);
  ctx.lineTo(6, 9.8);
  ctx.lineTo(11, 9.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.25;
  ctx.fill();
  ctx.stroke();
  ctx.font = `600 11px ${font}`;
  const w = ctx.measureText(name).width + 10;
  ctx.beginPath();
  ctx.roundRect(10, 16, w, 18, 3);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(name, 15, 25.5);
  ctx.restore();
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Applies alpha to a CSS color from tokens (hex or rgb). */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `${c}${a}`;
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m?.[1]) {
    const [r, g, b] = m[1].split(",").map((v) => v.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return c;
}
