/**
 * Retained two-layer overlay renderer shared by both the 2D Canvas and GPU/CPU
 * render engines:
 *
 * 1. **Retained artboard label layer (`labelsCtx`):**
 *    - Packs rasterized label sprites into one shared shelf-packed atlas surface
 *      keyed by `(text, kind, color, componentColor, dpr, width)`, avoiding both
 *      per-label canvas allocations and per-frame `fillText` rasterization.
 *    - When paired with an overscanned `.canvas__labels` element (`overscanCss > 0`),
 *      same-zoom panning translates the retained label layer with CSS `translate3d`
 *      at zero canvas pixel cost and zero compositor texture uploads until the
 *      pan offset reaches the overscan margin, then re-anchors using tight dirty
 *      label clears and warm atlas blits.
 *    - On active zoom frames, draws viewport labels directly without churning
 *      atlas sprites, and skips completely on stationary unchanged frames.
 *
 * 2. **Transient chrome layer (`overlayCtx`):**
 *    - Skips completely when no transient chrome exists (e.g. panning/zooming with
 *      no selection, hover, marquee, guides, or peers), avoiding full 2880x1800
 *      `clearRect` clears and compositor uploads.
 *    - Tracks old and new device-pixel bounding rects for transient selection,
 *      handles, size pill, hover, smart guides, marquee, component sets, and
 *      collaborator selections/cursors, clearing only those dirty regions instead
 *      of the whole viewport (with automatic full clear on resize, complex modes,
 *      or large dirty area).
 *
 * 3. **Retained pixel grid layer (`pixelGridCtx`, when given):**
 *    - The whole-pixel lines shown from 400% zoom are baked once into an
 *      overscanned canvas in a single fill, and same-zoom panning translates
 *      that canvas with CSS `translate3d`, exactly like the label layer, so
 *      a pan at high zoom writes no grid pixels at all. A zoom (which also
 *      changes the grid's fade) rebakes; panning past the overscan rebakes.
 *    - Without a grid canvas (a display too large for another retained
 *      surface, or the single-canvas fallback), the transient layer draws
 *      the grid itself in one fill, as a full-canvas ("complex") redraw.
 */
import { getProp, type NodeRecord } from "@drawpane/model";
import type { Editor, EditorState } from "./editor";
import { apply, type Point } from "./geometry";
import { framesWithGrids, placedGuides } from "./grids";
import type { ImageCache } from "./images";
import type { Interaction } from "./interaction";
import {
  type FrameLabel,
  frameLabelLayoutVersion,
  frameLabelsInRect,
  LABEL_FONT,
  LABEL_HEIGHT,
  LABEL_ICON,
} from "./labels";
import {
  boxOutlinePoints,
  componentSetIds,
  drawDiamond,
  drawOverlay,
  drawOverlayContent,
  drawSingleLabel,
  measureNameTagBounds,
  type OverlayTheme,
  resolveLabelInks,
} from "./overlay";
import { drawPixelGrid, pixelGridFade } from "./pixel-grid";
import { sizePill } from "./size-pill";

export interface DeviceRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SpriteSurface {
  readonly canvas: Parameters<CanvasRenderingContext2D["drawImage"]>[0] & {
    width: number;
    height: number;
  };
  readonly ctx: CanvasRenderingContext2D;
}

export interface OverlayRendererOptions {
  /** Overscan margin in CSS pixels around each edge of the retained label canvas (default 0). */
  readonly overscanCss?: number;
  /** Optional custom surface factory for the shared label sprite atlas (used in tests). */
  readonly createSurface?: (width: number, height: number) => SpriteSurface | null;
}

export interface OverlayRenderStats {
  labelFullDraws: number;
  labelSparseDraws: number;
  labelTranslations: number;
  labelSkipped: number;
  labelSpriteHits: number;
  labelSpriteMisses: number;
  transientFullClears: number;
  transientDirtyClears: number;
  transientSkipped: number;
  transientClearedPixels: number;
  pixelGridFullDraws: number;
  pixelGridTranslations: number;
  pixelGridSkipped: number;
}

interface AtlasRegion {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

interface LabelInkPadding {
  readonly leftPad: number;
  readonly rightPad: number;
  readonly topPad: number;
  readonly bottomPad: number;
}

interface BakedLabelItem {
  readonly label: FrameLabel;
  highlighted: boolean;
  hidden: boolean;
  readonly ink: LabelInkPadding;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rect: DeviceRect;
  readonly dstX: number;
  readonly dstY: number;
}

const PAD_X = 4;
const EXTRA_W = 10;
const PAD_Y = 4;
const BASELINE_Y = LABEL_HEIGHT - 4;
const HANDLE_PAD = 10;
const DIRTY_AREA_LIMIT = 0.45;
const SPARSE_CLEAR_MAX_RECTS = 64;
const ATLAS_W = 2048;
const ATLAS_H = 1024;
const ATLAS_MAX_SPRITE_H = 256;
const ATLAS_PAD = 2;
const LABEL_INK_CACHE_MAX = 2048;
const LABEL_CULL_MARGIN = 48;

function defaultCreateSurface(width: number, height: number): SpriteSurface | null {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
    if (ctx) return { canvas, ctx };
  }
  return null;
}

function hasDomStyle(canvas: unknown): canvas is { style: { transform: string } } {
  return (
    typeof canvas === "object" &&
    canvas !== null &&
    "style" in canvas &&
    typeof (canvas as { style?: unknown }).style === "object" &&
    (canvas as { style?: unknown }).style !== null
  );
}

function setCanvasTransform(canvas: unknown, tx: number, ty: number): void {
  if (!hasDomStyle(canvas)) return;
  canvas.style.transform = tx === 0 && ty === 0 ? "" : `translate3d(${tx}px, ${ty}px, 0)`;
}

function clampRect(r: DeviceRect, cw: number, ch: number): DeviceRect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(cw, Math.ceil(r.x + r.w));
  const y1 = Math.min(ch, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function rectsOverlap(a: DeviceRect, b: DeviceRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function unionBounds(rects: readonly DeviceRect[]): DeviceRect | null {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Merges overlapping or adjacent rects to keep `clearRect` calls minimal and disjoint. */
function coalesceRects(input: readonly DeviceRect[], cw: number, ch: number): DeviceRect[] {
  const rects: DeviceRect[] = [];
  for (const raw of input) {
    const r = clampRect(raw, cw, ch);
    if (r) rects.push(r);
  }
  let merged = true;
  while (merged && rects.length > 1) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      const a = rects[i] as DeviceRect;
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j] as DeviceRect;
        const touching =
          a.x <= b.x + b.w + 2 &&
          b.x <= a.x + a.w + 2 &&
          a.y <= b.y + b.h + 2 &&
          b.y <= a.y + a.h + 2;
        if (!touching) continue;
        const x0 = Math.min(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const x1 = Math.max(a.x + a.w, b.x + b.w);
        const y1 = Math.max(a.y + a.h, b.y + b.h);
        rects[i] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        rects.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return rects;
}

function pointsRect(pts: readonly Point[], dpr: number, padCss: number): DeviceRect | null {
  if (pts.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = padCss * dpr;
  return {
    x: minX * dpr - pad,
    y: minY * dpr - pad,
    w: (maxX - minX) * dpr + pad * 2,
    h: (maxY - minY) * dpr + pad * 2,
  };
}

function isGridFrame(node: NodeRecord | undefined): boolean {
  return node?.type === "frame" && getProp(node.props, "layoutMode") === "grid";
}

function themeSignature(theme: OverlayTheme): string {
  return [
    theme.signal,
    theme.componentInk,
    theme.onSignal,
    theme.onGuide,
    theme.otherLabels?.inkMuted ?? "",
    theme.otherLabels?.componentInk ?? "",
    theme.guide,
    theme.component,
    theme.inkMuted,
    theme.ink ?? "",
    theme.border ?? "",
    theme.surfaceRaised,
    theme.xrayPadding,
    theme.xrayGap,
    theme.presence.join(","),
    theme.onPresence,
    theme.agent,
    theme.onAgent,
    theme.fontUi,
    theme.fontMono ?? "",
  ].join("|");
}

/** True when any state field that affects the overlay changed between `prev` and `next`. */
export function overlayStateChanged(prev: EditorState, next: EditorState): boolean {
  return (
    prev.camera !== next.camera ||
    prev.pageId !== next.pageId ||
    prev.viewport !== next.viewport ||
    prev.insets !== next.insets ||
    prev.selection !== next.selection ||
    prev.hover !== next.hover ||
    prev.tool !== next.tool ||
    prev.editingText !== next.editingText ||
    prev.renamingFrame !== next.renamingFrame ||
    prev.marquee !== next.marquee ||
    prev.guides !== next.guides ||
    prev.gesture !== next.gesture ||
    prev.xray !== next.xray ||
    prev.measure !== next.measure ||
    prev.explain !== next.explain ||
    prev.focusMode !== next.focusMode ||
    prev.role !== next.role ||
    prev.readOnly !== next.readOnly ||
    prev.peers !== next.peers ||
    prev.vectorEdit !== next.vectorEdit ||
    prev.vectorPointer !== next.vectorPointer ||
    prev.prototyping !== next.prototyping ||
    prev.connecting !== next.connecting ||
    prev.layoutGrids !== next.layoutGrids ||
    prev.pixelGrid !== next.pixelGrid ||
    prev.showReadingOrder !== next.showReadingOrder ||
    prev.guideDraft !== next.guideDraft ||
    prev.following !== next.following ||
    prev.cropping !== next.cropping ||
    prev.hoverGuide !== next.hoverGuide
  );
}

export class OverlayRenderer {
  readonly #createSurface: (width: number, height: number) => SpriteSurface | null;
  #overscanCss: number;

  // Single shelf-packed label sprite atlas (one surface, zero per-label canvas churn).
  #atlas: SpriteSurface | null = null;
  #atlasUnavailable = false;
  #atlasDirty = true;
  #atlasCursorX = 0;
  #atlasCursorY = 0;
  #atlasRowH = 0;
  readonly #atlasEntries = new Map<string, AtlasRegion>();
  #spriteMeasurerGen = -1;

  // Retained state for the artboard labels layer.
  #labelsValid = false;
  #labelsBakedWithOverscan = false;
  #labelsW = 0;
  #labelsH = 0;
  #labelsDpr = 0;
  #labelsOverscan = 0;
  #labelsPageId: string | null = null;
  #labelsZoom = 0;
  #labelsAnchorCamX = 0;
  #labelsAnchorCamY = 0;
  #labelsTransformX = 0;
  #labelsTransformY = 0;
  #labelsLayoutVersion = -1;
  #labelsInksKey = "";
  #labelsSelection: readonly string[] | null = null;
  #labelsHover: string | null = null;
  #labelsRenamingFrame: string | null = null;
  #labelsBounds: DeviceRect | null = null;
  #bakedItems: BakedLabelItem[] = [];
  #labelStatesById = new Map<string, number>();
  #labelInkCache = new Map<string, LabelInkPadding>();
  #labelInkMeasurerGen = -1;

  // Retained state for the transient chrome layer.
  #transientValid = false;
  #transientEmpty = true;
  #transientFull = false;
  #transientRects: DeviceRect[] = [];
  #transientW = 0;
  #transientH = 0;
  #transientDpr = 0;
  #transientDocVersion = -1;
  #transientThemeKey = "";
  #transientState: EditorState | null = null;
  #transientPenPreview: unknown = null;

  // Retained state for the pixel grid layer.
  #pixelGridValid = false;
  #pixelGridEmpty = true;
  #pixelGridW = 0;
  #pixelGridH = 0;
  #pixelGridDpr = 0;
  #pixelGridOverscan = 0;
  #pixelGridZoom = 0;
  #pixelGridAnchorCamX = 0;
  #pixelGridAnchorCamY = 0;
  #pixelGridTransformX = 0;
  #pixelGridTransformY = 0;

  // Retained state for single-canvas fallback mode.
  #singleValid = false;
  #singleW = 0;
  #singleH = 0;
  #singleDpr = 0;
  #singleDocVersion = -1;
  #singleMeasurerGen = -1;
  #singleThemeKey = "";
  #singleState: EditorState | null = null;

  readonly stats: OverlayRenderStats = {
    labelFullDraws: 0,
    labelSparseDraws: 0,
    labelTranslations: 0,
    labelSkipped: 0,
    labelSpriteHits: 0,
    labelSpriteMisses: 0,
    transientFullClears: 0,
    transientDirtyClears: 0,
    transientSkipped: 0,
    transientClearedPixels: 0,
    pixelGridFullDraws: 0,
    pixelGridTranslations: 0,
    pixelGridSkipped: 0,
  };

  constructor(options: OverlayRendererOptions = {}) {
    this.#overscanCss = Math.max(0, options.overscanCss ?? 0);
    this.#createSurface = options.createSurface ?? defaultCreateSurface;
  }

  /** Updates the CSS overscan margin applied to the retained label canvas. */
  setOverscan(overscanCss: number): void {
    const next = Math.max(0, overscanCss);
    if (next === this.#overscanCss) return;
    this.#overscanCss = next;
    this.#labelsValid = false;
    this.#pixelGridValid = false;
  }

  /** Drops all cached pixel state and optionally clears the sprite atlas. */
  invalidate(clearSprites = false): void {
    this.#labelsValid = false;
    this.#labelsBakedWithOverscan = false;
    this.#labelsBounds = null;
    this.#bakedItems = [];
    this.#labelStatesById.clear();
    this.#labelsSelection = null;
    this.#labelsHover = null;
    this.#labelsRenamingFrame = null;
    this.#transientValid = false;
    this.#transientEmpty = false;
    this.#transientFull = true;
    this.#transientRects = [];
    this.#transientState = null;
    this.#pixelGridValid = false;
    this.#pixelGridEmpty = false;
    this.#singleValid = false;
    this.#singleState = null;
    if (clearSprites) this.#resetAtlas();
  }

  resetStats(): void {
    this.stats.labelFullDraws = 0;
    this.stats.labelSparseDraws = 0;
    this.stats.labelTranslations = 0;
    this.stats.labelSkipped = 0;
    this.stats.labelSpriteHits = 0;
    this.stats.labelSpriteMisses = 0;
    this.stats.transientFullClears = 0;
    this.stats.transientDirtyClears = 0;
    this.stats.transientSkipped = 0;
    this.stats.transientClearedPixels = 0;
    this.stats.pixelGridFullDraws = 0;
    this.stats.pixelGridTranslations = 0;
    this.stats.pixelGridSkipped = 0;
  }

  /**
   * Draws the retained label layer (`labelsCtx`), the retained pixel grid
   * layer (`pixelGridCtx`, when given) and the transient overlay layer
   * (`overlayCtx`).
   * When `labelsCtx` is null, falls back cleanly to single-canvas `drawOverlay` with unchanged-frame skipping.
   * When `pixelGridCtx` is null, the pixel grid is drawn on the overlay layer instead.
   */
  draw(
    labelsCtx: CanvasRenderingContext2D | null,
    overlayCtx: CanvasRenderingContext2D,
    editor: Editor,
    interaction: Interaction,
    theme: OverlayTheme,
    dpr: number,
    images?: ImageCache,
    pixelGridCtx?: CanvasRenderingContext2D | null,
  ): void {
    const measurerGen = editor.measurer.generation ?? 0;
    if (measurerGen !== this.#spriteMeasurerGen) {
      this.#resetAtlas();
      this.#spriteMeasurerGen = measurerGen;
    }

    if (pixelGridCtx) this.#drawPixelGrid(pixelGridCtx, editor, dpr);

    if (!labelsCtx) {
      this.#drawSingle(
        overlayCtx,
        editor,
        interaction,
        theme,
        dpr,
        images,
        measurerGen,
        !pixelGridCtx,
      );
      return;
    }

    this.#drawLabels(labelsCtx, editor, theme, dpr, measurerGen);
    this.#drawTransient(overlayCtx, editor, interaction, theme, dpr, images, !pixelGridCtx);
  }

  /**
   * The retained pixel grid: baked into its overscanned canvas in one fill
   * at an anchor camera, then moved with that canvas (CSS translate) while
   * panning at the same zoom, like the label layer. Hidden, toggled off or
   * below its zoom, the canvas is cleared once and then left alone.
   */
  #drawPixelGrid(ctx: CanvasRenderingContext2D, editor: Editor, dpr: number): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const pad = this.#overscanCss;
    const { pageId, camera, pixelGrid } = editor.s;
    const shown = !!pageId && pixelGrid && pixelGridFade(camera.zoom) > 0;
    const sizeMatch =
      this.#pixelGridValid &&
      this.#pixelGridW === cw &&
      this.#pixelGridH === ch &&
      this.#pixelGridDpr === dpr &&
      this.#pixelGridOverscan === pad;

    if (!shown) {
      if (sizeMatch && this.#pixelGridEmpty) {
        this.stats.pixelGridSkipped++;
        return;
      }
      setCanvasTransform(ctx.canvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      this.#pixelGridValid = true;
      this.#pixelGridEmpty = true;
      this.#pixelGridW = cw;
      this.#pixelGridH = ch;
      this.#pixelGridDpr = dpr;
      this.#pixelGridOverscan = pad;
      this.#pixelGridZoom = camera.zoom;
      this.#pixelGridAnchorCamX = camera.x;
      this.#pixelGridAnchorCamY = camera.y;
      this.#pixelGridTransformX = 0;
      this.#pixelGridTransformY = 0;
      return;
    }

    if (sizeMatch && !this.#pixelGridEmpty && this.#pixelGridZoom === camera.zoom) {
      const shiftPxX = Math.round((camera.x - this.#pixelGridAnchorCamX) * dpr);
      const shiftPxY = Math.round((camera.y - this.#pixelGridAnchorCamY) * dpr);
      const tx = shiftPxX / dpr;
      const ty = shiftPxY / dpr;
      const canCssTranslate =
        (shiftPxX === 0 && shiftPxY === 0) ||
        (pad > 0 && hasDomStyle(ctx.canvas) && Math.abs(tx) <= pad - 1 && Math.abs(ty) <= pad - 1);
      if (canCssTranslate) {
        if (tx === this.#pixelGridTransformX && ty === this.#pixelGridTransformY) {
          this.stats.pixelGridSkipped++;
          return;
        }
        setCanvasTransform(ctx.canvas, tx, ty);
        this.#pixelGridTransformX = tx;
        this.#pixelGridTransformY = ty;
        this.stats.pixelGridTranslations++;
        return;
      }
    }

    // Bake (or rebake after a zoom, a resize, or a pan past the overscan):
    // one clear and one fill for every line on the overscanned canvas.
    setCanvasTransform(ctx.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    drawPixelGrid(ctx, camera, cw / dpr, ch / dpr, dpr, pad);
    this.stats.pixelGridFullDraws++;
    this.#pixelGridValid = true;
    this.#pixelGridEmpty = false;
    this.#pixelGridW = cw;
    this.#pixelGridH = ch;
    this.#pixelGridDpr = dpr;
    this.#pixelGridOverscan = pad;
    this.#pixelGridZoom = camera.zoom;
    this.#pixelGridAnchorCamX = camera.x;
    this.#pixelGridAnchorCamY = camera.y;
    this.#pixelGridTransformX = 0;
    this.#pixelGridTransformY = 0;
  }

  #resetAtlas(): void {
    this.#atlasEntries.clear();
    this.#labelInkCache.clear();
    this.#atlasCursorX = 0;
    this.#atlasCursorY = 0;
    this.#atlasRowH = 0;
    this.#atlasDirty = true;
  }

  /**
   * Measures actual glyph ink padding around `label.box` using `actualBoundingBox*` metrics so
   * combining marks and script overhangs are neither clipped in the atlas nor left behind by
   * sparse damage clears. Cached per `(text, kind, width)` until font generation changes.
   */
  #measureLabelInk(
    ctx: CanvasRenderingContext2D,
    label: FrameLabel,
    measurerGen: number,
  ): LabelInkPadding {
    if (this.#labelInkMeasurerGen !== measurerGen) {
      this.#labelInkCache.clear();
      this.#labelInkMeasurerGen = measurerGen;
    }
    const minRight = EXTRA_W - PAD_X;
    if (!label.text) {
      return { leftPad: PAD_X, rightPad: minRight, topPad: PAD_Y, bottomPad: PAD_Y };
    }
    const key = `${label.kind}\0${label.box.width}\0${label.text}`;
    const cached = this.#labelInkCache.get(key);
    if (cached) return cached;

    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "alphabetic";
    const m = ctx.measureText(label.text);
    ctx.restore();

    const textOffsetX = label.kind !== "frame" ? LABEL_ICON : 0;
    const advanceW = Number.isFinite(m.width) ? m.width : label.box.width;
    const ascent = Number.isFinite(m.actualBoundingBoxAscent)
      ? m.actualBoundingBoxAscent
      : BASELINE_Y;
    const descent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : 4;
    const bboxLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
    const bboxRight = Number.isFinite(m.actualBoundingBoxRight)
      ? m.actualBoundingBoxRight
      : advanceW;

    const ink: LabelInkPadding = {
      leftPad: Math.max(PAD_X, Math.ceil(bboxLeft - textOffsetX) + 3),
      rightPad: Math.max(minRight, Math.ceil(textOffsetX + bboxRight - label.box.width) + 3),
      topPad: Math.max(PAD_Y, Math.ceil(ascent - BASELINE_Y) + 3),
      bottomPad: Math.max(PAD_Y, Math.ceil(descent - (LABEL_HEIGHT - BASELINE_Y)) + 3),
    };
    if (this.#labelInkCache.size >= LABEL_INK_CACHE_MAX) this.#labelInkCache.clear();
    this.#labelInkCache.set(key, ink);
    return ink;
  }

  #ensureAtlas(): SpriteSurface | null {
    if (this.#atlasUnavailable) return null;
    if (!this.#atlas) {
      this.#atlas = this.#createSurface(ATLAS_W, ATLAS_H);
      if (!this.#atlas) {
        this.#atlasUnavailable = true;
        return null;
      }
      this.#atlasDirty = false;
      return this.#atlas;
    }
    if (this.#atlasDirty) {
      this.#atlas.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.#atlas.ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
      this.#atlasDirty = false;
    }
    return this.#atlas;
  }

  #getAtlasRegion(
    item: BakedLabelItem,
    theme: OverlayTheme,
    mutedInk: string,
    componentInk: string,
    dpr: number,
  ): { surface: SpriteSurface; region: AtlasRegion } | null {
    const { label, highlighted, ink, widthPx: sw, heightPx: sh } = item;
    if (sw > ATLAS_W || sh > ATLAS_H || sh > ATLAS_MAX_SPRITE_H) return null;

    const surface = this.#ensureAtlas();
    if (!surface) return null;

    const isComponentish = label.kind !== "frame";
    const textColor = highlighted ? theme.signal : isComponentish ? componentInk : mutedInk;
    const compColor = isComponentish ? theme.component : "";
    const key = `${label.text}\0${label.kind}\0${textColor}\0${compColor}\0${dpr}\0${sw}\0${sh}\0${ink.leftPad}\0${ink.topPad}`;
    const existing = this.#atlasEntries.get(key);
    if (existing) {
      this.stats.labelSpriteHits++;
      return { surface, region: existing };
    }

    if (this.#atlasCursorX + sw > ATLAS_W) {
      this.#atlasCursorX = 0;
      this.#atlasCursorY += this.#atlasRowH + ATLAS_PAD;
      this.#atlasRowH = 0;
    }
    if (this.#atlasCursorY + sh > ATLAS_H) {
      surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
      surface.ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
      this.#atlasEntries.clear();
      this.#atlasCursorX = 0;
      this.#atlasCursorY = 0;
      this.#atlasRowH = 0;
    }

    const sx = this.#atlasCursorX;
    const sy = this.#atlasCursorY;
    this.#atlasCursorX += sw + ATLAS_PAD;
    if (sh > this.#atlasRowH) this.#atlasRowH = sh;

    this.stats.labelSpriteMisses++;
    const sctx = surface.ctx;
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.beginPath();
    sctx.rect(sx, sy, sw, sh);
    sctx.clip();
    sctx.setTransform(dpr, 0, 0, dpr, sx + ink.leftPad * dpr, sy + ink.topPad * dpr);
    if (isComponentish) {
      drawDiamond(sctx, 4, BASELINE_Y - 3.5, label.kind === "component", theme.component);
    }
    if (label.text) {
      sctx.font = LABEL_FONT;
      sctx.textBaseline = "alphabetic";
      sctx.fillStyle = textColor;
      sctx.fillText(label.text, isComponentish ? LABEL_ICON : 0, BASELINE_Y);
    }
    sctx.restore();

    const region: AtlasRegion = { sx, sy, sw, sh };
    this.#atlasEntries.set(key, region);
    return { surface, region };
  }

  #blitLabel(
    ctx: CanvasRenderingContext2D,
    item: BakedLabelItem,
    theme: OverlayTheme,
    mutedInk: string,
    componentInk: string,
    dpr: number,
    padCss: number,
  ): void {
    const entry = this.#getAtlasRegion(item, theme, mutedInk, componentInk, dpr);
    if (entry) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(
        entry.surface.canvas,
        entry.region.sx,
        entry.region.sy,
        entry.region.sw,
        entry.region.sh,
        item.dstX,
        item.dstY,
        entry.region.sw,
        entry.region.sh,
      );
      return;
    }
    // Fallback when no offscreen atlas is available or a label exceeds atlas dimensions.
    ctx.setTransform(dpr, 0, 0, dpr, padCss * dpr, padCss * dpr);
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "alphabetic";
    drawSingleLabel(ctx, item.label, item.highlighted, theme, mutedInk, componentInk);
  }

  /**
   * Clears previously drawn labels cheaply: tight coalesced rects when sparse,
   * previous union bounds when valid, or full canvas after resize/invalidation.
   * Returns true when tight sparse rects were cleared instead of the whole bounds.
   */
  #clearPreviousLabels(ctx: CanvasRenderingContext2D, cw: number, ch: number): boolean {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.#labelsValid || this.#labelsW !== cw || this.#labelsH !== ch) {
      ctx.clearRect(0, 0, cw, ch);
      return false;
    }
    if (this.#bakedItems.length === 0 || !this.#labelsBounds) {
      return true;
    }
    if (this.#bakedItems.length <= SPARSE_CLEAR_MAX_RECTS) {
      const rects: DeviceRect[] = [];
      for (const item of this.#bakedItems) {
        if (!item.hidden) rects.push(item.rect);
      }
      const coalesced = coalesceRects(rects, cw, ch);
      let area = 0;
      for (const r of coalesced) area += r.w * r.h;
      if (area < cw * ch * DIRTY_AREA_LIMIT) {
        for (const r of coalesced) ctx.clearRect(r.x, r.y, r.w, r.h);
        return true;
      }
    }
    ctx.clearRect(
      this.#labelsBounds.x,
      this.#labelsBounds.y,
      this.#labelsBounds.w,
      this.#labelsBounds.h,
    );
    return false;
  }

  #drawSingle(
    ctx: CanvasRenderingContext2D,
    editor: Editor,
    interaction: Interaction,
    theme: OverlayTheme,
    dpr: number,
    images: ImageCache | undefined,
    measurerGen: number,
    includePixelGrid: boolean,
  ): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const themeKey = themeSignature(theme);
    const hasPeers = !editor.s.focusMode && this.#hasActivePeersOnPage(editor);
    if (
      this.#singleValid &&
      !hasPeers &&
      this.#singleW === cw &&
      this.#singleH === ch &&
      this.#singleDpr === dpr &&
      this.#singleDocVersion === editor.doc.version &&
      this.#singleMeasurerGen === measurerGen &&
      this.#singleThemeKey === themeKey &&
      this.#singleState !== null &&
      !overlayStateChanged(this.#singleState, editor.s)
    ) {
      this.stats.transientSkipped++;
      return;
    }
    drawOverlay(ctx, editor, interaction, theme, dpr, images, includePixelGrid);
    this.stats.transientFullClears++;
    this.stats.transientClearedPixels += cw * ch;
    this.#singleValid = true;
    this.#singleW = cw;
    this.#singleH = ch;
    this.#singleDpr = dpr;
    this.#singleDocVersion = editor.doc.version;
    this.#singleMeasurerGen = measurerGen;
    this.#singleThemeKey = themeKey;
    this.#singleState = editor.s;
  }

  #drawLabels(
    ctx: CanvasRenderingContext2D,
    editor: Editor,
    theme: OverlayTheme,
    dpr: number,
    measurerGen: number,
  ): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const pad = this.#overscanCss;
    const { pageId, camera, selection, hover, renamingFrame } = editor.s;
    if (!pageId) {
      setCanvasTransform(ctx.canvas, 0, 0);
      if (!this.#labelsValid || this.#labelsBounds !== null) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
      } else {
        this.stats.labelSkipped++;
      }
      this.#labelsValid = true;
      this.#labelsBakedWithOverscan = false;
      this.#labelsW = cw;
      this.#labelsH = ch;
      this.#labelsDpr = dpr;
      this.#labelsOverscan = pad;
      this.#labelsPageId = null;
      this.#labelsTransformX = 0;
      this.#labelsTransformY = 0;
      this.#labelsBounds = null;
      this.#bakedItems = [];
      this.#labelStatesById.clear();
      this.#labelsSelection = selection;
      this.#labelsHover = hover;
      this.#labelsRenamingFrame = renamingFrame;
      return;
    }

    const { mutedInk, componentInk } = resolveLabelInks(editor, pageId, theme);
    const labelInksKey = `${mutedInk}|${componentInk}|${theme.signal}|${theme.component}|${measurerGen}`;
    const layoutVersion = frameLabelLayoutVersion(editor);

    const sizeMatch =
      this.#labelsValid &&
      this.#labelsW === cw &&
      this.#labelsH === ch &&
      this.#labelsDpr === dpr &&
      this.#labelsOverscan === pad;

    const canReuse =
      sizeMatch &&
      this.#labelsPageId === pageId &&
      this.#labelsZoom === camera.zoom &&
      this.#labelsLayoutVersion === layoutVersion &&
      this.#labelsInksKey === labelInksKey;

    if (canReuse) {
      const shiftX = camera.x - this.#labelsAnchorCamX;
      const shiftY = camera.y - this.#labelsAnchorCamY;
      const shiftPxX = Math.round(shiftX * dpr);
      const shiftPxY = Math.round(shiftY * dpr);
      const tx = shiftPxX / dpr;
      const ty = shiftPxY / dpr;
      const isZeroFromAnchor = shiftPxX === 0 && shiftPxY === 0;
      const canCssTranslate =
        pad > 0 &&
        this.#labelsBakedWithOverscan &&
        hasDomStyle(ctx.canvas) &&
        Math.abs(tx) <= pad - 1 &&
        Math.abs(ty) <= pad - 1;

      if (isZeroFromAnchor || canCssTranslate) {
        const sameHighlightInputs =
          selection === this.#labelsSelection &&
          hover === this.#labelsHover &&
          renamingFrame === this.#labelsRenamingFrame;

        if (sameHighlightInputs) {
          if (tx === this.#labelsTransformX && ty === this.#labelsTransformY) {
            this.stats.labelSkipped++;
            return;
          }
          setCanvasTransform(ctx.canvas, tx, ty);
          this.#labelsTransformX = tx;
          this.#labelsTransformY = ty;
          this.stats.labelTranslations++;
          return;
        }

        // Only selection/hover/renaming changed: update affected baked labels in-place.
        const selectionSet = selection.length > 4 ? new Set(selection) : null;
        const dirty: DeviceRect[] = [];
        for (const item of this.#bakedItems) {
          const id = item.label.id;
          const hidden = id === renamingFrame;
          const highlighted =
            !hidden &&
            (hover === id || (selectionSet ? selectionSet.has(id) : selection.includes(id)));
          const nextState = hidden ? 0 : highlighted ? 2 : 1;
          const prevState = this.#labelStatesById.get(id) ?? 1;
          if (nextState !== prevState) {
            item.hidden = hidden;
            item.highlighted = highlighted;
            this.#labelStatesById.set(id, nextState);
            dirty.push(item.rect);
          }
        }

        this.#labelsSelection = selection;
        this.#labelsHover = hover;
        this.#labelsRenamingFrame = renamingFrame;

        if (dirty.length === 0) {
          if (tx === this.#labelsTransformX && ty === this.#labelsTransformY) {
            this.stats.labelSkipped++;
            return;
          }
          setCanvasTransform(ctx.canvas, tx, ty);
          this.#labelsTransformX = tx;
          this.#labelsTransformY = ty;
          this.stats.labelTranslations++;
          return;
        }

        const regions = coalesceRects(dirty, cw, ch);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const r of regions) {
          ctx.clearRect(r.x, r.y, r.w, r.h);
          ctx.save();
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.w, r.h);
          ctx.clip();
          for (const item of this.#bakedItems) {
            if (!item.hidden && rectsOverlap(item.rect, r)) {
              this.#blitLabel(ctx, item, theme, mutedInk, componentInk, dpr, pad);
            }
          }
          ctx.restore();
        }
        if (tx !== this.#labelsTransformX || ty !== this.#labelsTransformY) {
          setCanvasTransform(ctx.canvas, tx, ty);
          this.#labelsTransformX = tx;
          this.#labelsTransformY = ty;
        }
        this.stats.labelSparseDraws++;
        return;
      }
    }

    const viewW = Math.max(1, cw / dpr - pad * 2);
    const viewH = Math.max(1, ch / dpr - pad * 2);
    const selectionSet = selection.length > 4 ? new Set(selection) : null;
    const isZooming =
      sizeMatch && this.#labelsPageId === pageId && this.#labelsZoom !== camera.zoom;

    setCanvasTransform(ctx.canvas, 0, 0);
    const sparseCleared = this.#clearPreviousLabels(ctx, cw, ch);

    // Active zoom: draw viewport labels directly without overscan or sprite atlas churn.
    if (isZooming) {
      const visible = frameLabelsInRect(
        editor,
        { x: 0, y: 0, width: viewW, height: viewH },
        LABEL_CULL_MARGIN,
      );
      const nextItems: BakedLabelItem[] = [];
      const nextStatesById = new Map<string, number>();
      const visibleRects: DeviceRect[] = [];

      ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
      ctx.font = LABEL_FONT;
      ctx.textBaseline = "alphabetic";
      for (const label of visible) {
        if (!label.text && label.kind === "frame") continue;
        const hidden = label.id === renamingFrame;
        const highlighted =
          !hidden &&
          (hover === label.id ||
            (selectionSet ? selectionSet.has(label.id) : selection.includes(label.id)));
        const ink = this.#measureLabelInk(ctx, label, measurerGen);
        const dstX = Math.round((label.box.x + pad - ink.leftPad) * dpr);
        const dstY = Math.round((label.box.y + pad - ink.topPad) * dpr);
        const widthPx = Math.max(
          1,
          Math.ceil((label.box.width + ink.leftPad + ink.rightPad) * dpr),
        );
        const heightPx = Math.max(1, Math.ceil((LABEL_HEIGHT + ink.topPad + ink.bottomPad) * dpr));
        const clamped = clampRect({ x: dstX, y: dstY, w: widthPx, h: heightPx }, cw, ch);
        if (!clamped) continue;
        nextItems.push({
          label,
          highlighted,
          hidden,
          ink,
          widthPx,
          heightPx,
          rect: clamped,
          dstX,
          dstY,
        });
        nextStatesById.set(label.id, hidden ? 0 : highlighted ? 2 : 1);
        if (!hidden) {
          visibleRects.push(clamped);
          ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
          ctx.font = LABEL_FONT;
          ctx.textBaseline = "alphabetic";
          drawSingleLabel(ctx, label, highlighted, theme, mutedInk, componentInk);
        }
      }

      this.stats.labelFullDraws++;
      this.#commitLabelsState(
        cw,
        ch,
        dpr,
        pad,
        false,
        pageId,
        camera.zoom,
        camera.x,
        camera.y,
        layoutVersion,
        labelInksKey,
        selection,
        hover,
        renamingFrame,
        nextItems,
        visibleRects,
        nextStatesById,
      );
      return;
    }

    // Bake / re-anchor at current camera (with overscan when configured) using the shared sprite atlas.
    const visible = frameLabelsInRect(
      editor,
      { x: -pad, y: -pad, width: viewW + pad * 2, height: viewH + pad * 2 },
      LABEL_CULL_MARGIN,
    );
    const nextItems: BakedLabelItem[] = [];
    const nextStatesById = new Map<string, number>();
    const visibleRects: DeviceRect[] = [];

    for (const label of visible) {
      if (!label.text && label.kind === "frame") continue;
      const hidden = label.id === renamingFrame;
      const highlighted =
        !hidden &&
        (hover === label.id ||
          (selectionSet ? selectionSet.has(label.id) : selection.includes(label.id)));
      const ink = this.#measureLabelInk(ctx, label, measurerGen);
      const dstX = Math.round((label.box.x + pad - ink.leftPad) * dpr);
      const dstY = Math.round((label.box.y + pad - ink.topPad) * dpr);
      const widthPx = Math.max(1, Math.ceil((label.box.width + ink.leftPad + ink.rightPad) * dpr));
      const heightPx = Math.max(1, Math.ceil((LABEL_HEIGHT + ink.topPad + ink.bottomPad) * dpr));
      const clamped = clampRect({ x: dstX, y: dstY, w: widthPx, h: heightPx }, cw, ch);
      if (!clamped) continue;
      const item: BakedLabelItem = {
        label,
        highlighted,
        hidden,
        ink,
        widthPx,
        heightPx,
        rect: clamped,
        dstX,
        dstY,
      };
      nextItems.push(item);
      nextStatesById.set(label.id, hidden ? 0 : highlighted ? 2 : 1);
      if (!hidden) {
        visibleRects.push(clamped);
        this.#blitLabel(ctx, item, theme, mutedInk, componentInk, dpr, pad);
      }
    }

    if (canReuse && sparseCleared) {
      this.stats.labelSparseDraws++;
    } else {
      this.stats.labelFullDraws++;
    }
    this.#commitLabelsState(
      cw,
      ch,
      dpr,
      pad,
      pad > 0,
      pageId,
      camera.zoom,
      camera.x,
      camera.y,
      layoutVersion,
      labelInksKey,
      selection,
      hover,
      renamingFrame,
      nextItems,
      visibleRects,
      nextStatesById,
    );
  }

  #commitLabelsState(
    cw: number,
    ch: number,
    dpr: number,
    overscan: number,
    bakedWithOverscan: boolean,
    pageId: string,
    zoom: number,
    anchorCamX: number,
    anchorCamY: number,
    layoutVersion: number,
    labelInksKey: string,
    selection: readonly string[],
    hover: string | null,
    renamingFrame: string | null,
    bakedItems: BakedLabelItem[],
    visibleRects: readonly DeviceRect[],
    labelStatesById: Map<string, number>,
  ): void {
    this.#labelsValid = true;
    this.#labelsBakedWithOverscan = bakedWithOverscan;
    this.#labelsW = cw;
    this.#labelsH = ch;
    this.#labelsDpr = dpr;
    this.#labelsOverscan = overscan;
    this.#labelsPageId = pageId;
    this.#labelsZoom = zoom;
    this.#labelsAnchorCamX = anchorCamX;
    this.#labelsAnchorCamY = anchorCamY;
    this.#labelsTransformX = 0;
    this.#labelsTransformY = 0;
    this.#labelsLayoutVersion = layoutVersion;
    this.#labelsInksKey = labelInksKey;
    this.#labelsSelection = selection;
    this.#labelsHover = hover;
    this.#labelsRenamingFrame = renamingFrame;
    this.#bakedItems = bakedItems;
    this.#labelStatesById = labelStatesById;
    this.#labelsBounds = unionBounds(visibleRects);
  }

  #hasActivePeersOnPage(editor: Editor): boolean {
    const { pageId, peers } = editor.s;
    if (!pageId || peers.size === 0) return false;
    for (const peer of peers.values()) {
      const pr = peer.presence;
      if (pr && pr.pageId === pageId && (pr.selection.length > 0 || pr.cursor !== null)) {
        return true;
      }
    }
    return false;
  }

  #hasGridLayoutOverlay(editor: Editor): boolean {
    const { selection, hover, gesture, prototyping, focusMode } = editor.s;
    if (prototyping || focusMode) return false;
    const doc = editor.doc;
    const check = (id: string) => {
      const node = doc.get(id);
      return isGridFrame(node) || isGridFrame(node ? doc.get(node.parent) : undefined);
    };
    for (const id of selection) if (check(id)) return true;
    if (hover && !gesture && check(hover)) return true;
    return false;
  }

  #computeTransientBounds(
    ctx: CanvasRenderingContext2D,
    editor: Editor,
    interaction: Interaction,
    theme: OverlayTheme,
    dpr: number,
    compSets: readonly string[],
  ): DeviceRect[] {
    const {
      camera,
      selection,
      hover,
      marquee,
      guides,
      pageId,
      editingText,
      focusMode,
      peers,
      gesture,
      vectorEdit,
      cropping,
    } = editor.s;
    if (!pageId) return [];
    const scene = editor.scene;
    const doc = editor.doc;
    const toScreen = (p: Point) => camera.toScreen(p);
    const rects: DeviceRect[] = [];

    for (const id of compSets) {
      const corners = scene.corners(id);
      if (corners) {
        const r = pointsRect(corners.map(toScreen), dpr, 3);
        if (r) rects.push(r);
      }
    }

    if (!focusMode) {
      for (const peer of peers.values()) {
        const presence = peer.presence;
        if (!presence || presence.pageId !== pageId) continue;
        let left = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const id of presence.selection) {
          const corners = scene.corners(id);
          if (!corners) continue;
          const pts = corners.map(toScreen);
          const r = pointsRect(pts, dpr, 3);
          if (r) rects.push(r);
          for (const p of pts) {
            if (p.x < left) left = p.x;
            if (p.y > bottom) bottom = p.y;
          }
        }
        if (Number.isFinite(left) && Number.isFinite(bottom)) {
          const tag = measureNameTagBounds(ctx, left - 0.5, bottom + 4, peer.name, theme.fontUi);
          rects.push({
            x: tag.x * dpr,
            y: tag.y * dpr,
            w: tag.width * dpr,
            h: tag.height * dpr,
          });
        }
        if (presence.cursor) {
          const p = toScreen(presence.cursor);
          rects.push({
            x: (p.x - 4) * dpr,
            y: (p.y - 4) * dpr,
            w: 20 * dpr,
            h: 24 * dpr,
          });
          const tag = measureNameTagBounds(ctx, p.x + 10, p.y + 16, peer.name, theme.fontUi);
          rects.push({
            x: tag.x * dpr,
            y: tag.y * dpr,
            w: tag.width * dpr,
            h: tag.height * dpr,
          });
        }
      }
    }

    if (hover && !selection.includes(hover) && !gesture) {
      const hovered = doc.get(hover);
      const outline =
        hovered?.type === "rect" || hovered?.type === "frame" ? boxOutlinePoints(hovered) : null;
      if (outline) {
        const m = scene.worldMatrix(hover);
        const r = pointsRect(
          outline.map((p) => toScreen(apply(m, p))),
          dpr,
          3,
        );
        if (r) rects.push(r);
      } else {
        const corners = scene.corners(hover);
        if (corners) {
          const r = pointsRect(corners.map(toScreen), dpr, 3);
          if (r) rects.push(r);
        }
      }
    }

    if ((!editingText || selection.length > 1) && !vectorEdit && !cropping) {
      for (const id of selection) {
        const corners = scene.corners(id);
        if (corners) {
          const r = pointsRect(corners.map(toScreen), dpr, 4);
          if (r) rects.push(r);
        }
      }
    }

    const pill = sizePill(editor);
    if (pill) {
      rects.push({
        x: (pill.box.x - 6) * dpr,
        y: (pill.box.y - 6) * dpr,
        w: (pill.box.width + 12) * dpr,
        h: (pill.box.height + 12) * dpr,
      });
    }

    const frame = cropping ? null : interaction.selectionFrame();
    if (frame && selection.length > 0 && !vectorEdit) {
      const corners = [
        { x: 0, y: 0 },
        { x: frame.width, y: 0 },
        { x: frame.width, y: frame.height },
        { x: 0, y: frame.height },
      ].map((p) => toScreen(apply(frame.matrix, p)));
      const r = pointsRect(corners, dpr, HANDLE_PAD);
      if (r) rects.push(r);
    }

    for (const g of guides) {
      const a = toScreen(g.axis === "x" ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
      const b = toScreen(g.axis === "x" ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
      const r = pointsRect([a, b], dpr, 3);
      if (r) rects.push(r);
    }

    if (marquee) {
      const a = toScreen({ x: marquee.x, y: marquee.y });
      rects.push({
        x: (a.x - 3) * dpr,
        y: (a.y - 3) * dpr,
        w: (marquee.width * camera.zoom + 6) * dpr,
        h: (marquee.height * camera.zoom + 6) * dpr,
      });
    }

    return rects;
  }

  #drawTransient(
    ctx: CanvasRenderingContext2D,
    editor: Editor,
    interaction: Interaction,
    theme: OverlayTheme,
    dpr: number,
    images: ImageCache | undefined,
    includePixelGrid: boolean,
  ): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const s = editor.s;
    const pageId = s.pageId;
    const themeKey = themeSignature(theme);
    const penPreview = s.tool === "pen" ? interaction.pen.preview() : null;
    const sizeMatch =
      this.#transientValid &&
      this.#transientW === cw &&
      this.#transientH === ch &&
      this.#transientDpr === dpr;

    if (!pageId) {
      if (!sizeMatch || !this.#transientEmpty) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        this.stats.transientFullClears++;
        this.stats.transientClearedPixels += cw * ch;
      } else {
        this.stats.transientSkipped++;
      }
      this.#transientValid = true;
      this.#transientEmpty = true;
      this.#transientFull = false;
      this.#transientRects = [];
      this.#transientW = cw;
      this.#transientH = ch;
      this.#transientDpr = dpr;
      this.#transientDocVersion = editor.doc.version;
      this.#transientThemeKey = themeKey;
      this.#transientState = s;
      this.#transientPenPreview = null;
      return;
    }

    const doc = editor.doc;
    const hasGrids = s.layoutGrids && framesWithGrids(doc, pageId).length > 0;
    const hasRulerGuides =
      placedGuides(editor.scene, pageId).length > 0 || !!s.guideDraft || !!s.hoverGuide;
    const compSets = componentSetIds(doc, pageId);
    const hasPeers = !s.focusMode && this.#hasActivePeersOnPage(editor);
    const hasHover = s.hover !== null && !s.gesture;
    const hasPen = s.tool === "pen" && (s.vectorPointer !== null || penPreview !== null);
    const hasReadingOrder = s.showReadingOrder && !s.gesture;
    // Only when no retained canvas owns it: with one, the grid never makes
    // this layer draw, so panning with no selection still writes nothing here.
    const hasPixelGrid = includePixelGrid && s.pixelGrid && pixelGridFade(s.camera.zoom) > 0;

    const hasTransient =
      hasPixelGrid ||
      hasGrids ||
      hasRulerGuides ||
      compSets.length > 0 ||
      s.selection.length > 0 ||
      hasHover ||
      s.marquee !== null ||
      s.guides.length > 0 ||
      s.xray ||
      s.explain !== null ||
      hasPeers ||
      s.cropping !== null ||
      s.vectorEdit !== null ||
      hasPen ||
      s.prototyping ||
      hasReadingOrder;

    // Fast empty path: nothing transient to show.
    if (!hasTransient) {
      if (sizeMatch && this.#transientEmpty) {
        this.stats.transientSkipped++;
        this.#transientState = s;
        this.#transientDocVersion = doc.version;
        this.#transientThemeKey = themeKey;
        this.#transientPenPreview = penPreview;
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (sizeMatch && !this.#transientFull && this.#transientRects.length > 0) {
        const dirty = coalesceRects(this.#transientRects, cw, ch);
        let cleared = 0;
        for (const r of dirty) {
          ctx.clearRect(r.x, r.y, r.w, r.h);
          cleared += r.w * r.h;
        }
        this.stats.transientDirtyClears++;
        this.stats.transientClearedPixels += cleared;
      } else {
        ctx.clearRect(0, 0, cw, ch);
        this.stats.transientFullClears++;
        this.stats.transientClearedPixels += cw * ch;
      }
      if (!s.focusMode) editor.cursors.keepOnly(new Set());
      this.#transientValid = true;
      this.#transientEmpty = true;
      this.#transientFull = false;
      this.#transientRects = [];
      this.#transientW = cw;
      this.#transientH = ch;
      this.#transientDpr = dpr;
      this.#transientDocVersion = doc.version;
      this.#transientThemeKey = themeKey;
      this.#transientState = s;
      this.#transientPenPreview = penPreview;
      return;
    }

    // Skip transient redraw when state, doc, theme, and size are completely unchanged (and no peer cursor is fading).
    if (
      sizeMatch &&
      !hasPeers &&
      this.#transientDocVersion === doc.version &&
      this.#transientThemeKey === themeKey &&
      this.#transientPenPreview === penPreview &&
      this.#transientState !== null &&
      !overlayStateChanged(this.#transientState, s)
    ) {
      this.stats.transientSkipped++;
      return;
    }

    const complex =
      hasPixelGrid ||
      hasGrids ||
      hasRulerGuides ||
      s.xray ||
      s.explain !== null ||
      s.cropping !== null ||
      s.vectorEdit !== null ||
      hasPen ||
      s.prototyping ||
      hasReadingOrder ||
      (s.measure && s.selection.length > 0 && !!s.hover && !s.selection.includes(s.hover)) ||
      this.#hasGridLayoutOverlay(editor);

    if (!complex && sizeMatch && !this.#transientFull) {
      const nextRects = coalesceRects(
        this.#computeTransientBounds(ctx, editor, interaction, theme, dpr, compSets),
        cw,
        ch,
      );
      const dirty = coalesceRects([...this.#transientRects, ...nextRects], cw, ch);
      let dirtyArea = 0;
      for (const r of dirty) dirtyArea += r.w * r.h;

      if (dirtyArea < cw * ch * DIRTY_AREA_LIMIT) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const r of dirty) ctx.clearRect(r.x, r.y, r.w, r.h);
        this.stats.transientDirtyClears++;
        this.stats.transientClearedPixels += dirtyArea;
        drawOverlayContent(ctx, editor, interaction, theme, dpr, images, false, includePixelGrid);
        this.#transientValid = true;
        this.#transientEmpty = false;
        this.#transientFull = false;
        this.#transientRects = nextRects;
        this.#transientW = cw;
        this.#transientH = ch;
        this.#transientDpr = dpr;
        this.#transientDocVersion = doc.version;
        this.#transientThemeKey = themeKey;
        this.#transientState = s;
        this.#transientPenPreview = penPreview;
        return;
      }
    }

    // Full transient clear fallback (resize, complex full-canvas mode, or > 45% dirty area).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    this.stats.transientFullClears++;
    this.stats.transientClearedPixels += cw * ch;
    drawOverlayContent(ctx, editor, interaction, theme, dpr, images, false, includePixelGrid);
    const nextRects = complex
      ? []
      : coalesceRects(
          this.#computeTransientBounds(ctx, editor, interaction, theme, dpr, compSets),
          cw,
          ch,
        );
    this.#transientValid = true;
    this.#transientEmpty = false;
    this.#transientFull = complex;
    this.#transientRects = nextRects;
    this.#transientW = cw;
    this.#transientH = ch;
    this.#transientDpr = dpr;
    this.#transientDocVersion = doc.version;
    this.#transientThemeKey = themeKey;
    this.#transientState = s;
    this.#transientPenPreview = penPreview;
  }
}
