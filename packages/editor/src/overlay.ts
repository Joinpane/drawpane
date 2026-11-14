/**
 * The overlay: everything drawn on top of the design that isn't the design.
 * Selection, hover, handles, size pill, marquee, smart guides, artboard
 * labels, Layout X-ray and collaborators. It repaints on every pointer move,
 * so it stays cheap: no shadows, no text layout beyond labels.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import { imageRect } from "./crop";
import { croppingTarget } from "./crop-session";
import type { Editor } from "./editor";
import { apply, type Point, type Rect } from "./geometry";
import { gridLines, gridTracks, placedGuides, visibleGrids } from "./grids";
import type { ImageCache } from "./images";
import type { Interaction } from "./interaction";
import { frameLabels, LABEL_FONT } from "./labels";
import { trackLabel } from "./layout";
import { drawPrototypeOverlay } from "./prototype/overlay";
import { PILL_FONT, PILL_MODE_FONT, sizePill } from "./size-pill";
import { drawVectorOverlay } from "./tools/overlay";
import { explainedFrame, solvedGrid, xrayFrames, xrayRegions } from "./xray";

export interface OverlayTheme {
  signal: string;
  componentInk: string;
  onSignal: string;
  guide: string;
  component: string;
  inkMuted: string;
  /** Text on raised surfaces (connection labels); defaults to inkMuted. */
  ink?: string;
  /** Hairlines on raised surfaces; none when omitted. */
  border?: string;
  surfaceRaised: string;
  xrayPadding: string;
  xrayGap: string;
  presence: readonly string[];
  onPresence: string;
  agent: string;
  onAgent: string;
  fontUi: string;
  /** Coordinate tags in vector edit (defaults to fontUi). */
  fontMono?: string;
}

const HANDLE = 7;
/** Dark inks of the X-ray colours, for values drawn on them (the design's own). */
const XRAY_PADDING_INK = "#6b4e00";
const XRAY_GAP_INK = "#8a1f50";

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  interaction: Interaction,
  theme: OverlayTheme,
  dpr: number,
  /** The app's image cache, for the image shown around a crop. */
  images?: ImageCache,
): void {
  const {
    camera,
    selection,
    hover,
    marquee,
    guides,
    pageId,
    xray,
    explain,
    editingText,
    focusMode,
    peers,
    gesture,
    vectorEdit,
    prototyping,
    cropping,
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

  // Layout grids and guides sit under everything else the overlay draws.
  if (editor.s.layoutGrids) drawLayoutGrids(ctx, editor, dpr);
  drawGuides(ctx, editor, theme);

  // Component sets: a dashed outline in the component colour, like Figma.
  const sets: string[] = [];
  for (const id of doc.childIds(pageId)) {
    const node = doc.get(id);
    if (node?.type === "frame" && getProp(node.props, "isComponentSet")) sets.push(id);
    else if (node?.type === "frame") {
      for (const child of doc.childIds(id))
        if (getProp(doc.get(child)?.props ?? {}, "isComponentSet")) sets.push(child);
    }
  }
  for (const id of sets) {
    const corners = scene.corners(id);
    if (corners) quad(corners, theme.component, 1, [4, 3]);
  }

  // Artboard labels: names above top-level frames (the one being renamed is an input instead).
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "alphabetic";
  for (const label of frameLabels(editor)) {
    if (label.id === editor.s.renamingFrame) continue;
    const selected = selection.includes(label.id);
    const hovered = hover === label.id;
    const isComponentish = label.kind !== "frame";
    if (isComponentish) {
      // Components and instances wear the component colour, with a small diamond.
      drawDiamond(
        ctx,
        label.box.x + 4,
        label.baseline - 3.5,
        label.kind === "component",
        theme.component,
      );
    }
    ctx.fillStyle =
      selected || hovered ? theme.signal : isComponentish ? theme.componentInk : theme.inkMuted;
    if (label.text) ctx.fillText(label.text, label.textX, label.baseline);
  }

  // Grid layout: the cells of a selected grid, or of the grid a selected or
  // hovered layer sits in, with track sizes along the edges when selected.
  if (!prototyping && !focusMode) {
    const grids = new Map<string, Set<string>>();
    const consider = (id: string, headers: boolean) => {
      const node = doc.get(id);
      if (!node) return;
      const frameId = isGridFrame(node)
        ? id
        : isGridFrame(doc.get(node.parent))
          ? node.parent
          : null;
      if (!frameId) return;
      const picked = grids.get(frameId) ?? new Set<string>();
      if (headers) picked.add(id);
      grids.set(frameId, picked);
    };
    for (const id of selection) consider(id, true);
    if (hover && !gesture) consider(hover, false);
    for (const [frameId, picked] of grids) drawGridLayout(ctx, editor, frameId, picked, theme);
  }

  // Layout X-ray: padding and gaps of the selected or hovered auto-layout
  // frame, and of the frame whose padding and gaps Explain is adding up.
  const xrayed = new Set(xray ? xrayFrames(editor) : []);
  const explained = explain ? explainedFrame(editor, explain.id, explain.axis) : null;
  if (explained) xrayed.add(explained);
  for (const frameId of xrayed) drawXray(ctx, editor, frameId, theme);

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

  // Cropping draws its own box, handles and size instead of the selection's.
  if (cropping) drawCrop(ctx, editor, theme, dpr, images);

  // Selection: each layer's outline, then one set of handles.
  if ((!editingText || selection.length > 1) && !vectorEdit && !cropping) {
    for (const id of selection) {
      const corners = scene.corners(id);
      if (corners) quad(corners, theme.signal, 1.5);
    }
  }
  // The size pill under the selection, beneath its handles, so a handle is never covered.
  drawSizePill(ctx, editor, theme);
  const frame = cropping ? null : interaction.selectionFrame();
  if (frame && selection.length > 0 && !vectorEdit) {
    const corners = [
      { x: 0, y: 0 },
      { x: frame.width, y: 0 },
      { x: frame.width, y: frame.height },
      { x: 0, y: frame.height },
    ].map((p) => apply(frame.matrix, p));
    if (selection.length > 1) quad(corners, theme.signal, 1);
    if (editor.canEdit && !editingText && !prototyping && !editor.selectionLocked) {
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
  }

  // Alt + hover: measure from the selection to the hovered layer.
  if (xray && selection.length > 0 && hover && !selection.includes(hover)) {
    const a = scene.unionBounds(selection);
    const b = scene.bounds(hover);
    if (a && b) drawMeasurements(ctx, a, b, (p) => toScreen(p), theme);
  }
  if (prototyping) drawPrototypeOverlay(ctx, editor, theme);
  // Pen and vector edit: anchors, handles and the pen's rubber band.
  drawVectorOverlay(ctx, editor, interaction, theme);

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

/**
 * Distance lines between two boxes, like browser devtools: from each edge of
 * `a` to the facing edge of `b` (or to `b`'s inner edges when `b` contains
 * `a`), each labelled with its length in page units.
 */
function drawMeasurements(
  ctx: CanvasRenderingContext2D,
  a: Rect,
  b: Rect,
  toScreen: (p: Point) => Point,
  theme: OverlayTheme,
): void {
  const lines: Array<{ from: Point; to: Point; length: number }> = [];
  const contains =
    b.x <= a.x && b.y <= a.y && b.x + b.width >= a.x + a.width && b.y + b.height >= a.y + a.height;
  const midY = a.y + a.height / 2;
  const midX = a.x + a.width / 2;
  if (contains) {
    lines.push({ from: { x: a.x, y: midY }, to: { x: b.x, y: midY }, length: a.x - b.x });
    lines.push({
      from: { x: a.x + a.width, y: midY },
      to: { x: b.x + b.width, y: midY },
      length: b.x + b.width - (a.x + a.width),
    });
    lines.push({ from: { x: midX, y: a.y }, to: { x: midX, y: b.y }, length: a.y - b.y });
    lines.push({
      from: { x: midX, y: a.y + a.height },
      to: { x: midX, y: b.y + b.height },
      length: b.y + b.height - (a.y + a.height),
    });
  } else {
    const overlapY = Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height);
    const overlapX = Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width);
    const y = overlapY ? (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2 : midY;
    const x = overlapX ? (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2 : midX;
    if (b.x >= a.x + a.width)
      lines.push({
        from: { x: a.x + a.width, y },
        to: { x: b.x, y },
        length: b.x - (a.x + a.width),
      });
    else if (b.x + b.width <= a.x)
      lines.push({
        from: { x: b.x + b.width, y },
        to: { x: a.x, y },
        length: a.x - (b.x + b.width),
      });
    if (b.y >= a.y + a.height)
      lines.push({
        from: { x, y: a.y + a.height },
        to: { x, y: b.y },
        length: b.y - (a.y + a.height),
      });
    else if (b.y + b.height <= a.y)
      lines.push({
        from: { x, y: b.y + b.height },
        to: { x, y: a.y },
        length: a.y - (b.y + b.height),
      });
  }
  ctx.save();
  ctx.strokeStyle = theme.guide;
  ctx.fillStyle = theme.guide;
  ctx.lineWidth = 1;
  ctx.font = `600 11px ${theme.fontUi}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Outline the hovered box so it's clear what you measure to.
  const tl = toScreen({ x: b.x, y: b.y });
  const br = toScreen({ x: b.x + b.width, y: b.y + b.height });
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(
    Math.round(tl.x) + 0.5,
    Math.round(tl.y) + 0.5,
    Math.round(br.x - tl.x),
    Math.round(br.y - tl.y),
  );
  ctx.setLineDash([]);
  for (const line of lines) {
    if (line.length <= 0.01) continue;
    const p1 = toScreen(line.from);
    const p2 = toScreen(line.to);
    ctx.beginPath();
    ctx.moveTo(Math.round(p1.x) + 0.5, Math.round(p1.y) + 0.5);
    ctx.lineTo(Math.round(p2.x) + 0.5, Math.round(p2.y) + 0.5);
    ctx.stroke();
    const label = fmt(line.length);
    const w = ctx.measureText(label).width + 8;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - 8, w, 16, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, cx, cy + 0.5);
    ctx.fillStyle = theme.guide;
  }
  ctx.restore();
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

/**
 * "300 Fill × 196 Hug" under the selection. With Explain open, the number
 * being explained gets a halo, so the card and the canvas point at each other.
 */
function drawSizePill(ctx: CanvasRenderingContext2D, editor: Editor, theme: OverlayTheme): void {
  const pill = sizePill(editor);
  if (!pill) return;
  const { box, parts, middle } = pill;
  const explaining = editor.s.explain?.axis;
  ctx.fillStyle = theme.signal;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, 3);
  ctx.fill();
  if (explaining) {
    const part = parts[explaining === "width" ? 0 : 1];
    ctx.strokeStyle = withAlpha(theme.signal, 0.28);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(box.x - 1.5, box.y - 1.5, box.width + 3, box.height + 3, 4.5);
    ctx.stroke();
    // A hairline under the number it's about.
    ctx.fillStyle = theme.onSignal;
    ctx.fillRect(Math.round(part.x), box.y + box.height - 4, Math.round(part.width), 1);
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = theme.onSignal;
  ctx.font = PILL_FONT;
  for (const part of parts) ctx.fillText(part.value, part.x, middle);
  ctx.fillText(" × ", pill.timesX, middle);
  ctx.font = PILL_MODE_FONT;
  ctx.globalAlpha = 0.78;
  for (const part of parts) if (part.mode) ctx.fillText(part.mode, part.modeX, middle);
  ctx.globalAlpha = 1;
  ctx.textBaseline = "alphabetic";
}

function drawXray(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  frameId: string,
  theme: OverlayTheme,
): void {
  const m = editor.scene.worldMatrix(frameId);
  const camera = editor.s.camera;
  const frame = editor.doc.get(frameId);
  if (!frame) return;
  const corners = (r: Rect) =>
    [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
    ].map((pt) => camera.toScreen(apply(m, pt)));
  const padding = withAlpha(theme.xrayPadding, 0.35);
  const gap = withAlpha(theme.xrayGap, 0.35);
  for (const region of xrayRegions(editor, frameId)) {
    const pts = corners(region.rect);
    ctx.beginPath();
    ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
    for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
    ctx.closePath();
    ctx.fillStyle = region.kind === "gap" ? gap : padding;
    ctx.fill();
    // Its value in the middle, where there's room for it.
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const wide = Math.max(...xs) - Math.min(...xs);
    const tall = Math.max(...ys) - Math.min(...ys);
    if (wide < 16 || tall < 14) continue;
    const value = String(Math.round(getProp(frame.props, region.prop) * 100) / 100);
    // Padding values sit a quarter of the way along, clear of the edge's middle handle.
    const along = region.kind === "padding" ? 0.25 : 0.5;
    const across = region.axis === "y";
    const cx = Math.min(...xs) + wide * (across ? along : 0.5);
    const cy = Math.min(...ys) + tall * (across ? 0.5 : along);
    ctx.font = `600 10px ${theme.fontMono ?? theme.fontUi}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (region.kind === "gap") {
      // A gap's value sits on a white chip ringed in the gap colour: it's a handle.
      const w = ctx.measureText(value).width + 8;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - 6.5, w, 13, 6.5);
      ctx.fill();
      ctx.strokeStyle = theme.xrayGap;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = XRAY_GAP_INK;
    } else ctx.fillStyle = XRAY_PADDING_INK;
    ctx.fillText(value, cx, cy + 0.5);
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function isGridFrame(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "layoutMode") === "grid";
}

/**
 * A grid frame's cells, dashed, and (for the picked layers) the tracks they
 * occupy, highlighted. With the frame or one of its items selected, track
 * sizes sit along the top and left edges, like column and row headers.
 */
function drawGridLayout(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  frameId: string,
  picked: ReadonlySet<string>,
  theme: OverlayTheme,
): void {
  const grid = solvedGrid(editor, frameId);
  if (!grid) return;
  const m = editor.scene.worldMatrix(frameId);
  const camera = editor.s.camera;
  const screen = (x: number, y: number) => camera.toScreen(apply(m, { x, y }));
  const columnEnd = grid.columns.at(-1);
  const rowEnd = grid.rows.at(-1);
  if (!columnEnd || !rowEnd) return;

  // Every cell, dashed and hairline: the structure without the noise.
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = withAlpha(theme.signal, 0.35);
  ctx.beginPath();
  for (const c of grid.columns) {
    for (const r of grid.rows) {
      const pts = [
        screen(c.start, r.start),
        screen(c.start + c.size, r.start),
        screen(c.start + c.size, r.start + r.size),
        screen(c.start, r.start + r.size),
      ];
      ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
      for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
      ctx.closePath();
    }
  }
  ctx.stroke();
  ctx.restore();

  const showHeaders = picked.size > 0;
  // Headers need an upright frame to line up with screen-space chips.
  if (!showHeaders || Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) return;
  const busyColumns = new Set<number>();
  const busyRows = new Set<number>();
  for (const id of picked) {
    const cell = grid.cells.get(id);
    if (!cell) continue;
    for (let i = 0; i < cell.columnSpan; i++) busyColumns.add(cell.column + i);
    for (let i = 0; i < cell.rowSpan; i++) busyRows.add(cell.row + i);
  }
  const frame = editor.doc.get(frameId);
  // Top-level frames carry their name above them: headers sit above that.
  const titled = frame && editor.doc.get(frame.parent)?.type === "page";
  const origin = screen(0, 0);
  const SIZE = 16;
  const GAP = 4;
  const headerY = origin.y - GAP - SIZE - (titled ? 18 : 0);
  const headerX = origin.x - GAP - SIZE;
  ctx.save();
  ctx.font = `500 10px ${theme.fontMono ?? theme.fontUi}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const chip = (
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    busy: boolean,
    vertical: boolean,
  ) => {
    // Skip tracks too thin to label.
    if ((vertical ? h : w) < 14) return;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fillStyle = busy ? withAlpha(theme.signal, 0.16) : theme.surfaceRaised;
    ctx.fill();
    if (theme.border && !busy) {
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const fits = ctx.measureText(label).width + 8 <= (vertical ? h : w);
    if (!fits) return;
    ctx.fillStyle = busy ? theme.signal : (theme.ink ?? theme.inkMuted);
    if (vertical) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(label, 0, 0.5);
      ctx.restore();
    } else ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  };
  grid.columns.forEach((c, i) => {
    const a = screen(c.start, 0);
    const b = screen(c.start + c.size, 0);
    const track = grid.columnTracks[i];
    if (track) chip(a.x, headerY, b.x - a.x, SIZE, trackLabel(track), busyColumns.has(i), false);
  });
  grid.rows.forEach((r, i) => {
    const a = screen(0, r.start);
    const b = screen(0, r.start + r.size);
    const track = grid.rowTracks[i];
    if (track) chip(headerX, a.y, SIZE, b.y - a.y, trackLabel(track), busyRows.has(i), true);
  });
  ctx.restore();
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

/** Frames on a page that have layout grids, cached per document version. */
let gridFrames: { version: number; pageId: string; ids: string[] } | null = null;

function framesWithGrids(editor: Editor, pageId: string): string[] {
  const doc = editor.doc;
  if (gridFrames && gridFrames.version === doc.version && gridFrames.pageId === pageId)
    return gridFrames.ids;
  const ids: string[] = [];
  const walk = (id: string) => {
    for (const child of doc.childIds(id)) {
      const node = doc.get(child);
      if (!node || node.props.visible === false) continue;
      if (node.type === "frame" && visibleGrids(node).length > 0) ids.push(child);
      if (node.type === "frame" || node.type === "group") walk(child);
    }
  };
  walk(pageId);
  gridFrames = { version: doc.version, pageId, ids };
  return ids;
}

/** A `#rrggbbaa` color as CSS. */
function cssHex(hex: string): string {
  if (hex.length !== 9) return hex;
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${Math.round((n(7) / 255) * 1000) / 1000})`;
}

/** Each frame's columns, rows and square grids, clipped to the frame, in its own rotation. */
function drawLayoutGrids(ctx: CanvasRenderingContext2D, editor: Editor, dpr: number): void {
  const { camera, viewport, pageId } = editor.s;
  if (!pageId) return;
  const view = camera.visibleRect(viewport);
  for (const id of framesWithGrids(editor, pageId)) {
    const node = editor.doc.get(id);
    const b = editor.scene.bounds(id);
    if (!node || !b) continue;
    if (b.x > view.x + view.width || b.y > view.y + view.height) continue;
    if (b.x + b.width < view.x || b.y + b.height < view.y) continue;
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const m = editor.scene.worldMatrix(id);
    ctx.save();
    ctx.setTransform(
      m[0] * camera.zoom * dpr,
      m[1] * camera.zoom * dpr,
      m[2] * camera.zoom * dpr,
      m[3] * camera.zoom * dpr,
      (m[4] * camera.zoom + camera.x) * dpr,
      (m[5] * camera.zoom + camera.y) * dpr,
    );
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    for (const grid of visibleGrids(node)) {
      const color = cssHex(grid.color);
      if (grid.type === "grid") {
        // Too dense to read below 4 screen pixels a cell: leave it out.
        if (grid.size * camera.zoom < 4) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1 / camera.zoom;
        ctx.beginPath();
        for (const x of gridLines(grid.size, w)) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        for (const y of gridLines(grid.size, h)) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = color;
      for (const t of gridTracks(grid, grid.type === "columns" ? w : h)) {
        if (grid.type === "columns") ctx.fillRect(t.start, 0, t.size, h);
        else ctx.fillRect(0, t.start, w, t.size);
      }
    }
    ctx.restore();
  }
}

/**
 * Ruler guides: page guides cross the whole view, frame guides their frame.
 * The hovered guide is bolder; one being dragged shows with its position,
 * dashed when letting go would remove it.
 */
function drawGuides(ctx: CanvasRenderingContext2D, editor: Editor, theme: OverlayTheme): void {
  const { camera, viewport, pageId, guideDraft, hoverGuide } = editor.s;
  if (!pageId) return;
  const line = (axis: "x" | "y", at: number, span: { from: number; to: number } | null) => {
    ctx.beginPath();
    if (axis === "x") {
      const x = Math.round(camera.toScreen({ x: at, y: 0 }).x) + 0.5;
      const from = span ? camera.toScreen({ x: 0, y: span.from }).y : 0;
      const to = span ? camera.toScreen({ x: 0, y: span.to }).y : viewport.height;
      ctx.moveTo(x, from);
      ctx.lineTo(x, to);
    } else {
      const y = Math.round(camera.toScreen({ x: 0, y: at }).y) + 0.5;
      const from = span ? camera.toScreen({ x: span.from, y: 0 }).x : 0;
      const to = span ? camera.toScreen({ x: span.to, y: 0 }).x : viewport.width;
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
    }
    ctx.stroke();
  };
  ctx.strokeStyle = theme.guide;
  for (const g of placedGuides(editor.scene, pageId)) {
    const moving = guideDraft?.from?.owner === g.owner && guideDraft.from.index === g.index;
    if (moving) continue;
    const hovered = hoverGuide?.owner === g.owner && hoverGuide.index === g.index;
    ctx.lineWidth = hovered ? 2 : 1;
    line(g.axis, g.at, g.span);
  }
  if (!guideDraft) return;
  ctx.lineWidth = 1;
  ctx.setLineDash(guideDraft.removing ? [4, 4] : []);
  ctx.globalAlpha = guideDraft.removing ? 0.5 : 1;
  line(guideDraft.axis, guideDraft.at, null);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (guideDraft.removing) return;
  // The position, in its owner's coordinates, in a chip beside the line.
  const label = `${guideDraft.axis} ${formatOffset(guideDraft.offset)}`;
  ctx.font = `600 11px ${theme.fontMono ?? theme.fontUi}`;
  const w = ctx.measureText(label).width + 10;
  const { insets } = editor.s;
  const p = camera.toScreen({ x: guideDraft.at, y: guideDraft.at });
  const x = guideDraft.axis === "x" ? Math.round(p.x) + 6 : insets.left + 8;
  const y = guideDraft.axis === "x" ? insets.top + 8 : Math.round(p.y) - 22;
  ctx.fillStyle = theme.guide;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = theme.surfaceRaised;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 5, y + 9.5);
}

function formatOffset(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Cropping: the whole image dimmed around the box (so you see what you can
 * bring back), the box with a rule-of-thirds grid, square handles, and the
 * crop's size against the image's own.
 */
function drawCrop(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  theme: OverlayTheme,
  dpr: number,
  images: ImageCache | undefined,
): void {
  const target = croppingTarget(editor);
  if (!target) return;
  const { node, paint } = target;
  const { camera } = editor.s;
  ctx.save();
  const w = getProp(node.props, "width");
  const h = getProp(node.props, "height");
  const image = imageRect(paint, { width: w, height: h }, { width: 1, height: 1 });
  const m = editor.scene.worldMatrix(node.id);
  const z = camera.zoom * dpr;
  ctx.save();
  ctx.setTransform(
    m[0] * z,
    m[1] * z,
    m[2] * z,
    m[3] * z,
    (m[4] * camera.zoom + camera.x) * dpr,
    (m[5] * camera.zoom + camera.y) * dpr,
  );
  // The image outside the box, dimmed; the box itself shows the layer as it is.
  const ring = new Path2D();
  ring.rect(image.x, image.y, image.width, image.height);
  ring.rect(0, 0, w, h);
  ctx.save();
  ctx.clip(ring, "evenodd");
  const view = images?.get(paint.ref, image.width * Math.hypot(m[0], m[1]) * z);
  if (view) {
    ctx.globalAlpha = 0.4;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(view.bitmap, image.x, image.y, image.width, image.height);
  } else {
    ctx.fillStyle = withAlpha(theme.inkMuted, 0.15);
    ctx.fillRect(image.x, image.y, image.width, image.height);
  }
  ctx.restore();
  // Lines one screen pixel wide whatever the zoom.
  const px = 1 / (Math.hypot(m[0], m[1]) * camera.zoom);
  ctx.setLineDash([4 * px, 4 * px]);
  ctx.strokeStyle = withAlpha(theme.inkMuted, 0.8);
  ctx.lineWidth = px;
  ctx.strokeRect(image.x, image.y, image.width, image.height);
  ctx.setLineDash([]);
  // Rule of thirds inside the box.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.beginPath();
  for (const k of [1 / 3, 2 / 3]) {
    ctx.moveTo(w * k, 0);
    ctx.lineTo(w * k, h);
    ctx.moveTo(0, h * k);
    ctx.lineTo(w, h * k);
  }
  ctx.stroke();
  ctx.strokeStyle = theme.signal;
  ctx.lineWidth = 1.5 * px;
  ctx.strokeRect(0, 0, w, h);
  ctx.restore();

  // Handles and the size pill, in screen space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const at = (x: number, y: number) => camera.toScreen(apply(m, { x, y }));
  const points = [
    [0, 0],
    [w / 2, 0],
    [w, 0],
    [w, h / 2],
    [w, h],
    [w / 2, h],
    [0, h],
    [0, h / 2],
  ].map(([x, y]) => at(x as number, y as number));
  for (const p of points) {
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
  const natural = editor.imageSize(paint.ref);
  const label = natural
    ? `${fmt(w)} × ${fmt(h)} of ${fmt(natural.width)} × ${fmt(natural.height)}`
    : `${fmt(w)} × ${fmt(h)}`;
  const bounds = editor.scene.bounds(node.id);
  if (!bounds) {
    ctx.restore();
    return;
  }
  const bottom = camera.toScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });
  ctx.font = `600 11px ${theme.fontUi}`;
  const lw = ctx.measureText(label).width + 10;
  ctx.fillStyle = theme.signal;
  ctx.beginPath();
  ctx.roundRect(bottom.x - lw / 2, bottom.y + 8, lw, 18, 3);
  ctx.fill();
  ctx.fillStyle = theme.onSignal;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(label, bottom.x, bottom.y + 17.5);
  ctx.textAlign = "left";
  ctx.restore();
}
