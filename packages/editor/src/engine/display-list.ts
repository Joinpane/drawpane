/**
 * The display list for one page, built once and then patched from the document's change log
 * (docs/decisions/0040-display-list.md): a change costs what it touches, never a walk of the
 * whole document.
 *
 * - `build(pageId)` writes a fresh list: every layer on the page as a record, parents first.
 * - `update()` writes a patch from `Doc.changesSince`: records set again where a layer changed,
 *   only a transform where only its place did (a drag), removals, and new child orders. When the
 *   change log no longer reaches back (or the document was reset), it writes a fresh list.
 * - Layers keep stable handles (a layer's id interned to a number for the session), and glyph
 *   outlines are interned once by their path data, so a font's glyphs cross once.
 *
 * Messages are made for the revision the engine holds: apply each in order and tell the builder
 * what came of it (`acknowledge`); after a refusal its next message is a fresh list, for a
 * revision past the engine's.
 *
 * Glyph outlines are counted by the records using them: one no record uses any more is freed
 * (`glyphFree`) at the end of the message that let it go. A file's saved outlines (its glyph
 * sets) can change on their own; text drawn from them is encoded again when they do.
 */
import {
  ANY_REVISION,
  FLAG,
  ListWriter,
  type PathData,
  ROOT,
  refusingBits,
  type WireRecord,
} from "@drawpane/engine/wire";
import { getProp, type NodeRecord } from "@drawpane/model";
import { boxOf, type Rect } from "../geometry";
import { glassParams } from "../glass";
import { type CropRect, imageDrawnSize, type ScaleMode, type Size } from "../images";
import { endsMask, hasMask, isActiveMask } from "../masks";
import { blurSigma } from "../post-effects";
import { glyphTable } from "../saved-glyphs";
import type { Scene } from "../scene";
import type { TextMeasurer } from "../text";
import { encodeLayer, type LayerContext, localTransform } from "./layer";
import { svgPathData } from "./svg-path";

export interface EngineImage {
  readonly handle: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageDemand {
  readonly ref: string;
  readonly visible: boolean;
  /** Projected dimensions in page units, before camera zoom and device pixel ratio. */
  readonly span: Size | null;
  /** Estimated drawn span in page units before natural image dimensions are known. */
  readonly hint?: Size;
  /** Distance from the layer's bounds centre to the viewport centre, in page units. */
  readonly centerDistance?: number;
}

export interface DisplayListOptions {
  /** `null` draws a placeholder. `undefined` omits an unavailable image from an export. */
  readonly image?: (ref: string) => EngineImage | null | undefined;
}

export interface BuildStats {
  /** Records written in the last message. */
  readonly records: number;
  /** Of them, transform-only patches. */
  readonly transforms: number;
  readonly removed: number;
  readonly glyphs: number;
  readonly bytes: number;
  readonly ms: number;
  readonly fresh: boolean;
}

const PLACE_PROPS = new Set(["x", "y", "rotation", "flipX", "flipY"]);

/** Whether `b` differs from `a` only in where it is (its place), not in what it draws. */
function onlyMoved(a: NodeRecord, b: NodeRecord): boolean {
  if (a.type !== b.type || a.parent !== b.parent || a.type === "group") return false;
  const pa = a.props as Record<string, unknown>;
  const pb = b.props as Record<string, unknown>;
  for (const k in pb) if (!PLACE_PROPS.has(k) && pa[k] !== pb[k]) return false;
  for (const k in pa) if (!PLACE_PROPS.has(k) && !(k in pb)) return false;
  return true;
}

/** Glyph path data as saved: outlines saved before imports dropped a leading close may not start with a move. */
function glyphPath(d: string): PathData {
  let s = d.trimStart();
  while (s.startsWith("Z") || s.startsWith("z")) s = s.slice(1).trimStart();
  if (s && s[0] !== "M" && s[0] !== "m") s = `M0 0${s}`;
  return svgPathData(s);
}

/** Milliseconds an update spends encoding deferred text whole (see `build`'s `deferText`). */
const DEFER_MS = 10;
/** Leave time for applying the records and painting the opening preview. */
const OPEN_LIST_MS = 5;

interface OpeningLevel {
  readonly ids: readonly string[];
  readonly nearby: (readonly string[])[];
  readonly distant: (readonly string[])[];
  next: number;
  nextBranch: number;
}

function openingLevel(ids: readonly string[]): OpeningLevel {
  return { ids, nearby: [], distant: [], next: 0, nextBranch: 0 };
}

export class DisplayListBuilder {
  readonly #scene: Scene;
  readonly #measurer: TextMeasurer;
  readonly #image: (ref: string) => EngineImage | null | undefined;
  #page: string | null = null;
  #revision = 0;
  /** The engine refused a message: the next one is a fresh list. */
  #stale = false;
  /** The glyph table's version text was last encoded from. */
  #glyphTable = -1;
  /** Bytes of the last fresh list. */
  #lastFresh = 0;
  /** For counting each glyph once per record (`#useGlyphs`). */
  #stamp = 0;
  readonly #seen = new Map<number, number>();
  #version = -1;
  #generation = -1;
  #next = 1;
  readonly #handles = new Map<string, number>();
  /** What each emitted layer was encoded from (for transform-only patches and mask changes). */
  readonly #nodes = new Map<string, NodeRecord>();
  readonly #kids = new Map<string, Set<string>>();
  readonly #imagesOf = new Map<string, Set<string>>();
  /** The image refs each layer's record paints. */
  readonly #imagesBy = new Map<string, readonly string[]>();
  readonly #imageReach = new Map<string, number>();
  /** Cached per-version image demand descriptors to avoid per-frame bounds/matrix recomputation. */
  #imageDemandCache: {
    readonly version: number;
    readonly hidden: ReadonlySet<string>;
    readonly entries: readonly {
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
      readonly reach: number;
      readonly box: Size;
      readonly scale: Size;
      readonly fills: readonly {
        readonly ref: string;
        readonly scaleMode: ScaleMode;
        readonly crop: CropRect | undefined;
      }[];
    }[];
  } | null = null;
  readonly #texts = new Set<string>();
  /** Text using a fallback: a face that arrives late can replace it. */
  readonly #pendingText = new Set<string>();
  /** Parents precede their children, even when opening spans several messages. */
  #opening: OpeningLevel[] | null = null;
  /**
   * Text to encode whole a few at a time: sent provisional when a page opened (`build`'s
   * `deferText`), or waiting for faces that have since arrived. `#queue` is the order they were
   * queued in, sent from `#at` on once what's in view is sent.
   *
   * What's in view is found by a scan of the queue from `#scanAt`, a slice at a time within the
   * text's budget (`update`), started again when the view moves: never a sort of the whole queue
   * on a camera change. Found, it's in `#shown` (to send first) and `#visible`.
   */
  readonly #deferred = new Set<string>();
  #queue: string[] = [];
  #at = 0;
  #scanAt = 0;
  #shown: string[] = [];
  /** Of `#deferred`, what the scan found in view and isn't sent yet. */
  readonly #visible = new Set<string>();
  /** Page bounds of queued text, found once (`Scene.bounds`) and dropped when the page changes. */
  readonly #bounds = new Map<
    string,
    { x: number; y: number; width: number; height: number } | null
  >();
  /** The page rectangle in view (`setView`), for ordering the queue. */
  #view: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Layers whose frame is provisional and the faces each encoded layer depends on. */
  readonly #waits = new Set<string>();
  readonly #dependencies = new Map<string, readonly string[]>();
  readonly #waitingOn = new Map<string, Set<string>>();
  /** The measurer's face generation (`TextMeasurer.faceGeneration`) text was last encoded at. */
  #faceGeneration = 0;
  readonly #extra = new Set<string>();
  #glyphs = new Map<string, number>();
  /** Each glyph handle's path data, while it's defined. */
  #glyphData = new Map<number, string>();
  /** Records using each glyph handle (once per record), and the handles each layer's record uses. */
  #glyphRefs = new Map<number, number>();
  readonly #glyphsOf = new Map<string, readonly number[]>();
  /** Glyphs whose last record let go of them in this message: freed at its end unless used again. */
  readonly #unused = new Set<number>();
  /** Shaped glyphs by identity: hashing an outline's path data costs more than the rest of a glyph. */
  #shaped = new WeakMap<object, number>();
  #nextGlyph = 1;
  #newGlyphs: Array<[number, string]> = [];
  #hidden: ReadonlySet<string> = new Set();
  #whole: string | null = null;
  /** Layers on the page with unsupported features or text fallback notes. */
  readonly unsupported = new Map<string, number>();
  readonly #refused = new Set<string>();
  stats: BuildStats = {
    records: 0,
    transforms: 0,
    removed: 0,
    glyphs: 0,
    bytes: 0,
    ms: 0,
    fresh: true,
  };

  constructor(scene: Scene, measurer: TextMeasurer, options: DisplayListOptions = {}) {
    this.#scene = scene;
    this.#measurer = measurer;
    this.#image = options.image ?? (() => null);
  }

  get pageId(): string | null {
    return this.#page;
  }

  get opening(): boolean {
    return this.#opening !== null;
  }

  /** True while `openSlice` still has unvisited subtrees intersecting the current view. */
  get openingVisible(): boolean {
    const stack = this.#opening;
    if (!stack || stack.length === 0) return false;
    for (let i = 0; i < stack.length; i++) {
      const level = stack[i] as OpeningLevel;
      if (level.next < level.ids.length || level.nextBranch < level.nearby.length) return true;
      if (level.nextBranch > level.nearby.length) return false;
    }
    return false;
  }

  /** The revision the engine holds once it has applied every message written so far. */
  get revision(): number {
    return this.#revision;
  }

  /**
   * What the engine did with the last message: applied, or refused while holding
   * `engineRevision`. After a refusal the builder's picture of the engine is wrong, so its next
   * message is a fresh list, for a revision past the engine's.
   */
  acknowledge(applied: boolean, engineRevision: number): void {
    if (applied) return;
    this.#revision = Math.max(this.#revision, engineRevision);
    this.#stale = true;
  }

  /** A layer's engine handle, if it's in the list. */
  handle(id: string): number | undefined {
    return this.#handles.get(id);
  }

  /** Whether every shown layer on the page (not hidden) is something the engine draws. */
  get supported(): boolean {
    if (this.#refused.size === 0) return true;
    const doc = this.#scene.doc;
    for (const id of this.#refused) {
      let cur: string | undefined = id;
      let isHidden = false;
      while (cur && cur !== this.#page) {
        const node = doc.get(cur);
        if (!node) break;
        if (node.props.visible === false || this.#hidden.has(cur)) {
          isHidden = true;
          break;
        }
        cur = node.parent;
      }
      if (!isHidden) return false;
    }
    return true;
  }

  /** Layers hidden while dragged, and the text being edited: their records change with these. */
  setEditorState(state: { hidden?: ReadonlySet<string>; whole?: string | null }): void {
    if (state.hidden) {
      for (const id of this.#hidden) if (!state.hidden.has(id)) this.#extra.add(id);
      for (const id of state.hidden) if (!this.#hidden.has(id)) this.#extra.add(id);
      this.#hidden = new Set(state.hidden);
    }
    if (state.whole !== undefined && state.whole !== this.#whole) {
      if (this.#whole) this.#extra.add(this.#whole);
      if (state.whole) this.#extra.add(state.whole);
      this.#whole = state.whole;
    }
  }

  /** An image's pixels reached the engine: the layers painting it are encoded again. */
  imageReady(ref: string): void {
    for (const id of this.#imagesOf.get(ref) ?? []) this.#extra.add(id);
  }

  #context(deferText = false, detailScale?: number): LayerContext {
    const glyph = (d: string) => {
      let g = this.#glyphs.get(d);
      if (g === undefined) {
        g = this.#nextGlyph++;
        this.#glyphs.set(d, g);
        this.#glyphData.set(g, d);
        this.#newGlyphs.push([g, d]);
      }
      return g;
    };
    return {
      scene: this.#scene,
      measurer: this.#measurer,
      image: (ref) => this.#image(ref),
      glyph,
      shapedGlyph: (g) => {
        let h = this.#shaped.get(g);
        // A handle freed since is gone: intern the outline again.
        if (h === undefined || !this.#glyphData.has(h)) {
          h = glyph(g.d);
          this.#shaped.set(g, h);
        }
        return h;
      },
      whole: this.#whole,
      hidden: this.#hidden,
      deferText,
      ...(detailScale !== undefined && detailScale > 0 ? { detailScale } : {}),
    };
  }

  /** True when a node's painted extent is sub-pixel at `detailScale`. */
  #isSubpixelExtent(node: NodeRecord, detailScale: number): boolean {
    const bounds = this.#scene.extent(node.id) ?? this.#scene.bounds(node.id);
    return !!bounds && bounds.width * detailScale < 0.75 && bounds.height * detailScale < 0.75;
  }

  /** Sub-pixel specks skipped during thumbnail level-of-detail builds (never during exports). */
  #isThumbnailSpeck(
    node: NodeRecord,
    detailScale: number,
    parentHasMask: (parentId: string) => boolean,
  ): boolean {
    if (node.type === "page" || node.type === "group") return false;
    // Never cull a mask, nor a clipped frame that ends a sibling mask's scope.
    const candidate: NodeRecord | undefined = node;
    if (isActiveMask(candidate) || getProp(node.props, "isMask")) return false;
    if (endsMask(node) && parentHasMask(node.parent)) return false;
    // Unclipped frames with children may have larger descendants: keep the container and cull leaves.
    if (
      node.type === "frame" &&
      !getProp(node.props, "clipContent") &&
      this.#scene.doc.childIds(node.id).length > 0
    ) {
      return false;
    }
    return this.#isSubpixelExtent(node, detailScale);
  }

  #encode(node: NodeRecord, ctx: LayerContext): WireRecord {
    const e = encodeLayer(node, ctx);
    this.#useGlyphs(node.id, e.record);
    this.#nodes.set(node.id, node);
    if (node.type === "text") this.#texts.add(node.id);
    if (e.textPending) this.#pendingText.add(node.id);
    else this.#pendingText.delete(node.id);
    if (e.deferred) this.#defer(node.id);
    else {
      this.#deferred.delete(node.id);
      this.#visible.delete(node.id);
    }
    if (e.waiting.length) this.#waits.add(node.id);
    else this.#waits.delete(node.id);
    this.#watchFaces(node.id, [...new Set([...e.waiting, ...e.faceDependencies])]);
    this.#useImages(node.id, e.images);
    if (e.images.length) this.#imageReach.set(node.id, e.record.reach);
    if (e.record.unsupported) this.unsupported.set(node.id, e.record.unsupported);
    else this.unsupported.delete(node.id);
    if (refusingBits(e.record.unsupported)) this.#refused.add(node.id);
    else this.#refused.delete(node.id);
    return e.record;
  }

  /** Queues a layer's text to be encoded whole (`update`, a few milliseconds at a time). */
  #defer(id: string): void {
    if (this.#deferred.has(id)) return;
    this.#deferred.add(id);
    this.#queue.push(id);
  }

  /** Indexes faces that can change a layer's shaping, including late replacements. */
  #watchFaces(id: string, faces: readonly string[]): void {
    for (const face of this.#dependencies.get(id) ?? []) {
      const ids = this.#waitingOn.get(face);
      ids?.delete(id);
      if (ids?.size === 0) this.#waitingOn.delete(face);
    }
    if (faces.length === 0) {
      this.#dependencies.delete(id);
      return;
    }
    this.#dependencies.set(id, faces);
    for (const face of faces) {
      const ids = this.#waitingOn.get(face) ?? new Set<string>();
      this.#waitingOn.set(face, ids);
      ids.add(id);
    }
  }

  /** Starts the scan for what's in view again: the view moved, or the page changed. */
  #rescan(): void {
    this.#scanAt = this.#at;
    this.#shown = [];
    this.#visible.clear();
  }

  /** Whether the scan has been through the whole queue for the current view. */
  get #scanned(): boolean {
    return this.#scanAt >= this.#queue.length;
  }

  /**
   * Scans more of the queue for text in view, until `until` (`performance.now()`): what it finds
   * goes in `#shown`. Answers whether it's been through the whole queue.
   */
  #scan(until: number): boolean {
    const view = this.#view;
    if (!view) {
      this.#scanAt = this.#queue.length;
      return true;
    }
    let n = 0;
    while (this.#scanAt < this.#queue.length) {
      if ((++n & 63) === 0 && performance.now() >= until) return false;
      const id = this.#queue[this.#scanAt++] as string;
      if (!this.#deferred.has(id) || this.#visible.has(id)) continue;
      let b = this.#bounds.get(id);
      if (b === undefined) {
        b = this.#scene.bounds(id);
        this.#bounds.set(id, b);
      }
      if (
        b !== null &&
        b.x < view.x1 &&
        b.x + b.width > view.x0 &&
        b.y < view.y1 &&
        b.y + b.height > view.y0
      ) {
        this.#shown.push(id);
        this.#visible.add(id);
      }
    }
    return true;
  }

  /**
   * The page rectangle in view: text still to be encoded whole is encoded there first. A view
   * that moved reorders what's left.
   */
  setView(view: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const v = this.#view;
    if (
      v === view ||
      (v && view && v.x0 === view.x0 && v.y0 === view.y0 && v.x1 === view.x1 && v.y1 === view.y1)
    )
      return;
    this.#view = view;
    if (this.#deferred.size > 0) this.#rescan();
  }

  /** Notes the images a layer's record paints now, forgetting those it painted before. */
  #useImages(id: string, refs: readonly string[]): void {
    for (const ref of this.#imagesBy.get(id) ?? []) {
      const set = this.#imagesOf.get(ref);
      set?.delete(id);
      if (set?.size === 0) this.#imagesOf.delete(ref);
    }
    for (const ref of refs) {
      const set = this.#imagesOf.get(ref) ?? new Set<string>();
      this.#imagesOf.set(ref, set);
      set.add(id);
    }
    if (refs.length > 0) this.#imagesBy.set(id, refs);
    else {
      this.#imagesBy.delete(id);
      this.#imageReach.delete(id);
    }
    this.#imageDemandCache = null;
  }

  /** The image refs the page's records paint now: the engine may let the others go. */
  imagesInUse(): ReadonlySet<string> {
    return new Set(this.#imagesOf.keys());
  }

  /**
   * Image uses on or near the view. A null span requests metadata before a layer
   * can be encoded. The image's full transform matters for zoom, including crop and repeat.
   */
  *imageDemands(view: Rect, margin: number): Iterable<ImageDemand> {
    const scene = this.#scene;
    const version = scene.doc.version;
    let cache = this.#imageDemandCache;
    if (!cache || cache.version !== version || cache.hidden !== this.#hidden) {
      const entries: {
        readonly x0: number;
        readonly y0: number;
        readonly x1: number;
        readonly y1: number;
        readonly reach: number;
        readonly box: Size;
        readonly scale: Size;
        readonly fills: readonly {
          readonly ref: string;
          readonly scaleMode: ScaleMode;
          readonly crop: CropRect | undefined;
        }[];
      }[] = [];
      for (const [id, refs] of this.#imagesBy) {
        if (this.#hidden.has(id) || !scene.isVisible(id)) continue;
        const b = scene.bounds(id);
        const layer = this.#nodes.get(id);
        if (!b || !layer || layer.type === "page" || layer.type === "group") continue;
        const fills: {
          readonly ref: string;
          readonly scaleMode: ScaleMode;
          readonly crop: CropRect | undefined;
        }[] = [];
        for (const paint of getProp(layer.props, "fills")) {
          if (
            paint.type !== "image" ||
            !refs.includes(paint.ref) ||
            paint.visible === false ||
            paint.opacity === 0
          )
            continue;
          fills.push({ ref: paint.ref, scaleMode: paint.scaleMode, crop: paint.crop });
        }
        if (fills.length === 0) continue;
        const matrix = scene.worldMatrix(id);
        entries.push({
          x0: b.x,
          y0: b.y,
          x1: b.x + b.width,
          y1: b.y + b.height,
          reach: this.#imageReach.get(id) ?? 0,
          box: boxOf(layer),
          scale: {
            width: Math.hypot(matrix[0], matrix[1]),
            height: Math.hypot(matrix[2], matrix[3]),
          },
          fills,
        });
      }
      cache = { version, hidden: this.#hidden, entries };
      this.#imageDemandCache = cache;
    }
    const vx0 = view.x;
    const vy0 = view.y;
    const vx1 = view.x + view.width;
    const vy1 = view.y + view.height;
    const vcx = (vx0 + vx1) * 0.5;
    const vcy = (vy0 + vy1) * 0.5;
    for (const entry of cache.entries) {
      const distance =
        Math.max(vx0 - entry.x1, entry.x0 - vx1, vy0 - entry.y1, entry.y0 - vy1) - entry.reach;
      if (distance > margin) continue;
      const visible = distance <= 0;
      const centerDistance = Math.hypot(
        (entry.x0 + entry.x1) * 0.5 - vcx,
        (entry.y0 + entry.y1) * 0.5 - vcy,
      );
      for (const fill of entry.fills) {
        const meta = this.#image(fill.ref);
        const span = meta
          ? imageDrawnSize(fill.scaleMode, entry.box, meta, entry.scale, fill.crop)
          : null;
        if (span) {
          yield { ref: fill.ref, visible, span, hint: span, centerDistance };
        } else {
          const cropW = fill.crop ? Math.max(0.05, fill.crop.width) : 1;
          const cropH = fill.crop ? Math.max(0.05, fill.crop.height) : 1;
          yield {
            ref: fill.ref,
            visible,
            span: null,
            hint: {
              width: (entry.box.width * entry.scale.width) / cropW,
              height: (entry.box.height * entry.scale.height) / cropH,
            },
            centerDistance,
          };
        }
      }
    }
  }

  /** Counts the glyphs a layer's new record uses, and lets go of those its old one did. */
  #useGlyphs(id: string, record: WireRecord | null): void {
    // Each glyph once per record: marked with this call's stamp as it's seen.
    const now: number[] = [];
    if (record) {
      const stamp = ++this.#stamp;
      for (const p of record.paths)
        if (p.kind === "glyphs")
          for (let i = 0; i < p.glyphs.length; i += 3) {
            const g = p.glyphs[i] as number;
            if (this.#seen.get(g) === stamp) continue;
            this.#seen.set(g, stamp);
            now.push(g);
          }
    }
    for (const g of now) this.#glyphRefs.set(g, (this.#glyphRefs.get(g) ?? 0) + 1);
    for (const g of this.#glyphsOf.get(id) ?? []) {
      const n = (this.#glyphRefs.get(g) ?? 1) - 1;
      if (n > 0) this.#glyphRefs.set(g, n);
      else {
        this.#glyphRefs.delete(g);
        this.#unused.add(g);
      }
    }
    if (now.length > 0) this.#glyphsOf.set(id, now);
    else this.#glyphsOf.delete(id);
  }

  /** Frees the glyphs no record uses any more (after the commands that let them go). */
  #freeGlyphs(w: ListWriter): void {
    for (const g of this.#unused) {
      const d = this.#glyphData.get(g);
      if (this.#glyphRefs.has(g) || d === undefined) continue;
      w.glyphFree(g);
      this.#glyphData.delete(g);
      if (this.#glyphs.get(d) === g) this.#glyphs.delete(d);
    }
    this.#unused.clear();
  }

  #handleOf(id: string): number {
    let h = this.#handles.get(id);
    if (h === undefined) {
      h = this.#next++;
      this.#handles.set(id, h);
    }
    return h;
  }

  #parentHandle(node: NodeRecord): number {
    return node.parent === this.#page ? ROOT : (this.#handles.get(node.parent) ?? ROOT);
  }

  /** Defines the glyphs interned since the last call (before the records that use them). */
  #writeGlyphs(w: ListWriter): number {
    const n = this.#newGlyphs.length;
    for (const [g, d] of this.#newGlyphs) w.glyph(g, glyphPath(d));
    this.#newGlyphs = [];
    return n;
  }

  /**
   * A fresh list of just `ids` and everything in them, each placed on the page (an export's
   * list: the layers drawn alone, as `CanvasRenderer.renderNodes` draws them). With
   * `options.context`, exports holding backdrop readers include the page prefix beneath them
   * flagged with `FLAG.context` (decision 0039). Not patched afterwards: `build` or
   * `buildLayers` again.
   */
  buildLayers(
    ids: readonly string[],
    options?: {
      readonly context?: boolean | undefined;
      readonly detailScale?: number | undefined;
    },
  ): Uint8Array {
    return this.planLayers(ids, options).build();
  }

  /** Plans the selected layers and their reader context before a headless host loads their assets. */
  planLayers(
    ids: readonly string[],
    options?: {
      readonly context?: boolean | undefined;
      readonly detailScale?: number | undefined;
    },
  ) {
    const doc = this.#scene.doc;
    const first = ids.map((id) => doc.get(id)).find((n) => n !== undefined);
    const pageId = first ? this.#pageOf(first.id) : null;
    const detailScale =
      options?.detailScale !== undefined && options.detailScale > 0
        ? options.detailScale
        : undefined;
    const maskedParents = new Map<string, boolean>();
    const parentHasMask = (parentId: string): boolean => {
      let has = maskedParents.get(parentId);
      if (has === undefined) {
        has = hasMask(doc, parentId);
        maskedParents.set(parentId, has);
      }
      return has;
    };
    const isSpeck =
      detailScale !== undefined
        ? (node: NodeRecord) => this.#isThumbnailSpeck(node, detailScale, parentHasMask)
        : null;
    const isSubpixel =
      detailScale !== undefined
        ? (node: NodeRecord) => this.#isSubpixelExtent(node, detailScale)
        : null;
    const parts = options?.context && pageId ? this.#readerContextParts(ids) : [];
    const context = pageId && parts.length > 0 ? this.#contextPrefix(pageId, ids, parts) : null;
    return {
      *visibleNodes(): IterableIterator<NodeRecord> {
        const seen = new Set<string>();
        const stack = [...ids];
        while (stack.length > 0) {
          const id = stack.pop() as string;
          const node = doc.get(id);
          if (!node || node.props.visible === false || seen.has(id)) continue;
          if (isSpeck?.(node)) continue;
          seen.add(id);
          yield node;
          // A kept sub-pixel clipped frame only stays for `endsMask`: its clipped kids can't show.
          if (isSubpixel && endsMask(node) && isSubpixel(node)) {
            continue;
          }
          for (const child of doc.childIds(id)) stack.push(child);
        }
        for (const id of context ?? []) {
          const node = doc.get(id);
          if (node && node.props.visible !== false && !seen.has(id)) yield node;
        }
      },
      build: () => {
        const list =
          context && pageId
            ? this.#buildWithContext(pageId, ids, context)
            : this.build(pageId ?? "", ids, detailScale !== undefined ? { detailScale } : {});
        this.#page = null;
        return list;
      },
    };
  }

  /**
   * Computes a single reader layer's conservative page-space read rectangle (grown by its reach
   * and intersected with clipping ancestors), or null if the layer has no visible reader.
   */
  #readerReachRect(id: string, onlyBackdropWriters = false): Rect | null {
    const doc = this.#scene.doc;
    const node = doc.get(id);
    if (!node || node.props.visible === false || node.type === "group") return null;
    let pad = 0;
    for (const e of getProp(node.props, "effects")) {
      if (e.visible === false) continue;
      if (e.type === "glass" && !onlyBackdropWriters) {
        const p = glassParams(e, 1);
        pad = Math.max(pad, p.margin + Math.ceil(3 * p.sigma) + 4);
      } else if (e.type === "background-blur") {
        const maxR = Math.max(e.radius, (e as { startRadius?: number }).startRadius ?? 0);
        pad = Math.max(pad, Math.ceil(blurSigma(maxR) * 3.5) + 8);
      }
    }
    if (pad <= 0) return null;
    const b = this.#scene.bounds(id);
    if (!b) return null;
    const m = this.#scene.worldMatrix(id);
    const s = Math.max(1, Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
    const grow = pad * s;
    let r: Rect = {
      x: b.x - grow,
      y: b.y - grow,
      width: b.width + grow * 2,
      height: b.height + grow * 2,
    };
    // A reader inside a clipping frame cannot read pixels outside that frame.
    for (let a = doc.get(node.parent); a && a.type !== "page"; a = doc.get(a.parent)) {
      if (a.type !== "frame" || !getProp(a.props, "clipContent")) continue;
      const ab = this.#scene.bounds(a.id);
      if (!ab) continue;
      const x0 = Math.max(r.x, ab.x);
      const y0 = Math.max(r.y, ab.y);
      const x1 = Math.min(r.x + r.width, ab.x + ab.width);
      const y1 = Math.min(r.y + r.height, ab.y + ab.height);
      r = {
        x: x0,
        y: y0,
        width: Math.max(0, x1 - x0),
        height: Math.max(0, y1 - y0),
      };
    }
    return r.width > 0 && r.height > 0 ? r : null;
  }

  /**
   * Page-space regions that backdrop readers inside `ids` read (each grown by its conservative
   * reach and intersected with any clipping ancestors). Empty when `ids` hold no visible readers.
   */
  #readerContextParts(ids: readonly string[]): Rect[] {
    const doc = this.#scene.doc;
    const parts: Rect[] = [];
    const visit = (id: string) => {
      const node = doc.get(id);
      if (!node || node.props.visible === false) return;
      const r = this.#readerReachRect(id, false);
      if (r) parts.push(r);
      for (const c of doc.childIds(id)) visit(c);
    };
    for (const id of ids) visit(id);
    return parts;
  }

  /**
   * Finds the page prefix feeding the selected layers' readers, including ancestor clips and
   * transforms (decision 0039). Reverse paint order lets an earlier blur pull in its own inputs.
   */
  #contextPrefix(
    pageId: string,
    ids: readonly string[],
    initialParts: readonly Rect[],
  ): ReadonlySet<string> {
    const doc = this.#scene.doc;
    const exported = new Set(ids);
    const remaining = new Set(ids);
    const ancestors = new Set<string>();
    for (const id of ids) {
      for (let p = doc.get(id)?.parent; p && p !== pageId; p = doc.get(p)?.parent) {
        ancestors.add(p);
      }
    }

    // 1. Collect visible prefix nodes in paint order up to the last exported root.
    const prefixOrder: string[] = [];
    const collectPrefix = (id: string, inExported: boolean) => {
      if (!inExported && remaining.size === 0) return;
      const node = doc.get(id);
      if (!node) return;
      const isExportRoot = exported.has(id);
      const nextExported = inExported || isExportRoot;
      if (!nextExported) {
        if (!ancestors.has(id) && node.props.visible === false) return;
        prefixOrder.push(id);
      }
      for (const c of doc.childIds(id)) collectPrefix(c, nextExported);
      if (isExportRoot) remaining.delete(id);
    };
    for (const c of doc.childIds(pageId)) collectPrefix(c, false);

    // 2. Reverse paint-order transitive closure: any prefix layer overlapping `needParts` is kept,
    //    and if it writes to the backdrop via background blur, its own reach expands `needParts`
    //    for all earlier layers beneath it.
    const needParts: Rect[] = [...initialParts];
    const keptContext = new Set<string>(ancestors);
    const overlapsAny = (id: string): boolean => {
      const raw = this.#scene.extent(id) ?? this.#scene.bounds(id);
      if (!raw) return true;
      let bx0 = raw.x;
      let by0 = raw.y;
      let bx1 = raw.x + raw.width;
      let by1 = raw.y + raw.height;
      // A layer inside a clipping frame cannot paint outside that frame.
      for (
        let a = doc.get(doc.get(id)?.parent ?? "");
        a && a.type !== "page";
        a = doc.get(a.parent)
      ) {
        if (a.type !== "frame" || !getProp(a.props, "clipContent")) continue;
        const ab = this.#scene.bounds(a.id);
        if (!ab) continue;
        bx0 = Math.max(bx0, ab.x);
        by0 = Math.max(by0, ab.y);
        bx1 = Math.min(bx1, ab.x + ab.width);
        by1 = Math.min(by1, ab.y + ab.height);
        if (bx1 <= bx0 || by1 <= by0) return false;
      }
      for (const r of needParts) {
        if (bx0 < r.x + r.width && r.x < bx1 && by0 < r.y + r.height && r.y < by1) {
          return true;
        }
      }
      return false;
    };
    for (let i = prefixOrder.length - 1; i >= 0; i--) {
      const id = prefixOrder[i] as string;
      const node = doc.get(id);
      if (!node) continue;
      if (keptContext.has(id) || overlapsAny(id)) {
        keptContext.add(id);
        for (let p: string | undefined = node.parent; p && p !== pageId; p = doc.get(p)?.parent) {
          keptContext.add(p);
        }
        // Only backdrop-writing readers (background-blur / progressive-blur) pull in earlier
        // inputs transitively; glass writes only to output (decision 0007).
        const blurReach = this.#readerReachRect(id, true);
        if (blurReach) needParts.push(blurReach);
      }
    }
    return keptContext;
  }

  #buildWithContext(
    pageId: string,
    ids: readonly string[],
    keptContext: ReadonlySet<string>,
  ): Uint8Array {
    const t0 = performance.now();
    const doc = this.#scene.doc;
    this.#resetState(pageId);
    const ctx = this.#context();
    const revision = this.#revision + 1;
    const w = new ListWriter(
      ANY_REVISION,
      revision,
      Math.max(1 << 20, Math.ceil(this.#lastFresh * 1.1)),
    );
    w.reset();
    const exported = new Set(ids);
    // Emit kept context nodes (flagged `FLAG.context`) and exported nodes in paint order.
    let records = 0;
    let glyphs = 0;
    const emitRemaining = new Set(ids);
    const emit = (id: string, inExported: boolean) => {
      if (!inExported && emitRemaining.size === 0) return;
      const node = doc.get(id);
      if (!node) return;
      const isExportRoot = exported.has(id);
      const nextExported = inExported || isExportRoot;
      if (!nextExported && !keptContext.has(id)) return;
      let record = this.#encode(node, ctx);
      if (!nextExported) record = { ...record, flags: record.flags | FLAG.context };
      const parent = this.#parentHandle(node);
      glyphs += this.#writeGlyphs(w);
      w.set(this.#handleOf(id), parent, record);
      records++;
      this.#kid(node.parent, id);
      for (const c of doc.childIds(id)) emit(c, nextExported);
      if (isExportRoot) emitRemaining.delete(id);
    };
    for (const c of doc.childIds(pageId)) emit(c, false);
    this.#revision = revision;
    const bytes = w.finish();
    this.#lastFresh = bytes.length;
    this.stats = {
      records,
      transforms: 0,
      removed: 0,
      glyphs,
      bytes: bytes.length,
      ms: performance.now() - t0,
      fresh: true,
    };
    return bytes;
  }

  #resetState(pageId: string): void {
    const doc = this.#scene.doc;
    this.#page = pageId;
    this.#version = doc.version;
    this.#generation = this.#measurer.generation ?? 0;
    this.#faceGeneration = this.#measurer.faceGeneration ?? 0;
    this.#glyphTable = glyphTable(doc).version;
    this.#stale = false;
    this.#opening = null;
    this.#handles.clear();
    this.#nodes.clear();
    this.#kids.clear();
    this.#imagesOf.clear();
    this.#imagesBy.clear();
    this.#imageReach.clear();
    this.#imageDemandCache = null;
    this.#texts.clear();
    this.#pendingText.clear();
    this.#deferred.clear();
    this.#queue = [];
    this.#at = 0;
    this.#rescan();
    this.#bounds.clear();
    this.#waits.clear();
    this.#dependencies.clear();
    this.#waitingOn.clear();
    this.#extra.clear();
    this.unsupported.clear();
    this.#refused.clear();
    this.#glyphs = new Map();
    this.#glyphData = new Map();
    this.#glyphRefs = new Map();
    this.#glyphsOf.clear();
    this.#unused.clear();
    this.#seen.clear();
    this.#shaped = new WeakMap();
    this.#newGlyphs = [];
    this.#nextGlyph = 1;
  }

  #openingPageChanged(pageId: string): boolean {
    const changes = this.#scene.doc.changesSince(this.#version);
    if (!changes) return true;
    const onPage = (id: string) => this.#nodes.has(id) || this.#pageOf(id) === pageId;
    return changes.some((change) => {
      if (change.reset) return true;
      for (const id of change.ids) if (onPage(id)) return true;
      for (const id of change.parents) if (onPage(id)) return true;
      return false;
    });
  }

  /**
   * Opens a live page a slice at a time. Each message is valid on its own. A page switch,
   * edit to the opening page or refusal starts a new generation rather than mixing two snapshots.
   */
  openSlice(pageId: string, budgetMs = OPEN_LIST_MS): Uint8Array {
    const t0 = performance.now();
    const doc = this.#scene.doc;
    const previous = this.#opening;
    const continuing =
      previous !== null &&
      this.#page === pageId &&
      !this.#stale &&
      !this.#openingPageChanged(pageId);
    if (!continuing) this.#resetState(pageId);
    else this.#version = doc.version;
    const stack = continuing ? previous : [openingLevel(doc.childIds(pageId))];
    const revision = this.#revision + 1;
    const w = new ListWriter(continuing ? this.#revision : ANY_REVISION, revision, 64 << 10);
    if (!continuing) w.reset();
    const ctx = this.#context(true);
    const until = t0 + budgetMs;
    let records = 0;
    let glyphs = 0;
    while (stack.length > 0 && (records === 0 || performance.now() < until)) {
      const level = stack[stack.length - 1] as OpeningLevel;
      const id = level.ids[level.next];
      if (id === undefined) {
        const branch = level.nextBranch++;
        const kids =
          branch < level.nearby.length
            ? level.nearby[branch]
            : level.distant[branch - level.nearby.length];
        if (kids) stack.push(openingLevel(kids));
        else stack.pop();
        continue;
      }
      level.next++;
      const node = doc.get(id);
      if (!node) continue;
      glyphs += this.#writePageRecord(w, node, ctx);
      records++;
      const kids = doc.childIds(id);
      if (kids.length === 0) continue;
      // Emit each set of siblings in paint order. Their descendants can arrive in view order
      // because they belong to separate parent records.
      (this.#nearOpeningView(node) ? level.nearby : level.distant).push(kids);
    }
    this.#opening = stack.length === 0 ? null : stack;
    this.#revision = revision;
    const bytes = w.finish();
    this.stats = {
      records,
      transforms: 0,
      removed: 0,
      glyphs,
      bytes: bytes.length,
      ms: performance.now() - t0,
      fresh: !continuing,
    };
    return bytes;
  }

  #nearOpeningView(node: NodeRecord): boolean {
    const view = this.#view;
    if (!view || node.type === "group") return true;
    const bounds = this.#scene.bounds(node.id);
    return (
      !bounds ||
      (bounds.x <= view.x1 &&
        bounds.x + bounds.width >= view.x0 &&
        bounds.y <= view.y1 &&
        bounds.y + bounds.height >= view.y0)
    );
  }

  #writePageRecord(w: ListWriter, node: NodeRecord, ctx: LayerContext, root = false): number {
    const parent = root ? ROOT : this.#parentHandle(node);
    let record = this.#encode(node, ctx);
    // An export's top layers hang from the page directly, at their page positions.
    if (root)
      record = {
        ...record,
        transform:
          node.type === "group"
            ? this.#scene.spaceMatrix(node.parent)
            : this.#scene.worldMatrix(node.id),
      };
    const glyphs = this.#writeGlyphs(w);
    w.set(this.#handleOf(node.id), parent, record);
    this.#kid(node.parent, node.id);
    return glyphs;
  }

  /**
   * A fresh list of every layer on `pageId` (or of just `roots` on it, placed on the page),
   * written as it's walked: each record goes into the message as it's encoded, after the glyphs
   * it brings, so the page is never held as records too.
   */
  build(
    pageId: string,
    roots?: readonly string[],
    options: { readonly deferText?: boolean; readonly detailScale?: number | undefined } = {},
  ): Uint8Array {
    const t0 = performance.now();
    const doc = this.#scene.doc;
    this.#resetState(pageId);
    const detailScale =
      options.detailScale !== undefined && options.detailScale > 0
        ? options.detailScale
        : undefined;
    const ctx = this.#context(options.deferText ?? false, detailScale);
    const revision = this.#revision + 1;
    // Sized for the last fresh list (a page reopened, a reset), so the buffer rarely grows.
    const w = new ListWriter(
      ANY_REVISION,
      revision,
      Math.max(1 << 20, Math.ceil(this.#lastFresh * 1.1)),
    );
    w.reset();
    const maskedParents = new Map<string, boolean>();
    const parentHasMask = (parentId: string): boolean => {
      let has = maskedParents.get(parentId);
      if (has === undefined) {
        has = hasMask(doc, parentId);
        maskedParents.set(parentId, has);
      }
      return has;
    };
    const stack = [...(roots ?? doc.childIds(pageId))].reverse();
    const top = roots ? new Set(roots) : null;
    let records = 0;
    let glyphs = 0;
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = doc.get(id);
      if (!node) continue;
      if (detailScale !== undefined) {
        if (
          node.props.visible === false ||
          this.#isThumbnailSpeck(node, detailScale, parentHasMask)
        ) {
          continue;
        }
      }
      glyphs += this.#writePageRecord(w, node, ctx, top?.has(id));
      records++;
      // Keep a sub-pixel clipped frame's record for `endsMask`, without encoding clipped kids.
      if (
        detailScale !== undefined &&
        endsMask(node) &&
        this.#isSubpixelExtent(node, detailScale)
      ) {
        continue;
      }
      const kids = doc.childIds(id);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
    }
    this.#revision = revision;
    const bytes = w.finish();
    this.#lastFresh = bytes.length;
    this.stats = {
      records,
      transforms: 0,
      removed: 0,
      glyphs,
      bytes: bytes.length,
      ms: performance.now() - t0,
      fresh: true,
    };
    return bytes;
  }

  #kid(parent: string, id: string): void {
    const set = this.#kids.get(parent) ?? new Set<string>();
    this.#kids.set(parent, set);
    set.add(id);
  }

  /** The page a layer is on, walking up (null when it's on no page). */
  #pageOf(id: string): string | null {
    const doc = this.#scene.doc;
    for (let node = doc.get(id); node; node = doc.get(node.parent))
      if (node.type === "page") return node.id;
    return null;
  }

  #depth(id: string): number {
    const doc = this.#scene.doc;
    let d = 0;
    for (let node = doc.get(id); node && node.type !== "page"; node = doc.get(node.parent)) d++;
    return d;
  }

  /** Forgets a removed layer and everything under it. */
  #forget(id: string): void {
    const stack = [id];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      this.#handles.delete(at);
      const node = this.#nodes.get(at);
      if (node) this.#kids.get(node.parent)?.delete(at);
      this.#nodes.delete(at);
      this.#texts.delete(at);
      this.#pendingText.delete(at);
      this.#deferred.delete(at);
      this.#visible.delete(at);
      this.#waits.delete(at);
      this.#watchFaces(at, []);
      this.unsupported.delete(at);
      this.#refused.delete(at);
      this.#useGlyphs(at, null);
      this.#useImages(at, []);
      const kids = this.#kids.get(at);
      if (kids) stack.push(...kids);
      this.#kids.delete(at);
    }
  }

  /** Text sent provisional and not yet encoded whole: updates go on sending it while any is left. */
  get pending(): number {
    return this.#deferred.size;
  }

  /**
   * Of `pending`, what's in view (as of the last `setView`): sent before anything else. While
   * the scan for it isn't through the queue, at least 1 (it may be). Finds nothing itself.
   */
  get pendingVisible(): number {
    return this.#visible.size + (this.#deferred.size > 0 && !this.#scanned ? 1 : 0);
  }

  /** Layers whose text waits for faces still loading (sent provisional meanwhile). */
  get waiting(): number {
    return this.#waits.size;
  }

  /** Font requests the encoded text is currently waiting on. */
  waitingFaces(): Iterable<string> {
    return this.#waitingOn.keys();
  }

  /**
   * A patch since the last message, or null when nothing on the page changed. Text still to be
   * encoded whole (`pending`) is, for at most `textMs` (at least one record), what's in view first.
   */
  update(textMs = DEFER_MS, sliceFresh = false): Uint8Array | null {
    const page = this.#page;
    if (!page) return null;
    const t0 = performance.now();
    const doc = this.#scene.doc;
    const changes = doc.changesSince(this.#version);
    if (this.#stale || !changes || changes.some((c) => c.reset) || !doc.get(page))
      return sliceFresh ? this.openSlice(page) : this.build(page);
    const touched = new Set<string>();
    const parents = new Set<string>();
    for (const c of changes) {
      for (const id of c.ids) touched.add(id);
      for (const p of c.parents) parents.add(p);
    }
    // Layers whose records change for reasons outside their own props (editor state, an image
    // arriving, faces, saved outlines): encoded again whatever else changed, never patched as a
    // move even when their place changed too.
    const forced = new Set<string>(this.#extra);
    this.#extra.clear();
    const generation = this.#measurer.generation ?? 0;
    const faces = this.#measurer.faceGeneration ?? 0;
    if (generation !== this.#generation) {
      if (generation - faces === this.#generation - this.#faceGeneration) {
        // Only faces arrived (or turned out unavailable): what waited for them is encoded again,
        // a few at a time, what's in view first; nothing else's layout depended on them.
        for (const [face, ids] of this.#waitingOn)
          if (
            this.#measurer.faceRevision
              ? this.#measurer.faceRevision(face) > this.#faceGeneration
              : this.#measurer.faceStatus?.(face) !== "loading"
          ) {
            for (const id of ids) this.#defer(id);
          }
        for (const id of this.#pendingText) this.#defer(id);
      } else {
        // Fonts, aliases or the catalog changed: every text's layout may have moved. Encoded
        // again a few at a time, what's in view first (`pendingVisible`: a frame isn't exact
        // until what's in view is), never all in one long frame.
        for (const id of this.#texts) this.#defer(id);
      }
      this.#generation = generation;
      this.#faceGeneration = faces;
    }
    // A glyph set changed (a file's saved outlines): text drawn from them may draw differently.
    const table = glyphTable(doc).version;
    if (table !== this.#glyphTable) {
      for (const id of this.#texts) forced.add(id);
      this.#glyphTable = table;
    }
    for (const id of forced) touched.add(id);
    this.#version = doc.version;
    if (touched.size === 0 && parents.size === 0 && this.#deferred.size === 0) return null;
    // The page changed: where queued text is may have too.
    if (changes.length > 0 && this.#deferred.size > 0) {
      this.#bounds.clear();
      this.#rescan();
    }

    const sets = new Set<string>();
    const moves = new Set<string>();
    const removes = new Set<string>();
    const orders = new Set<string>();
    for (const id of touched) {
      const node = doc.get(id);
      const on = node !== undefined && this.#pageOf(id) === page;
      if (!on) {
        if (this.#handles.has(id)) removes.add(id);
        continue;
      }
      const old = this.#nodes.get(id);
      if (!old || !this.#handles.has(id)) {
        // New on this page (made here, or moved in): it and everything under it.
        const stack = [id];
        while (stack.length > 0) {
          const at = stack.pop() as string;
          sets.add(at);
          const kids = doc.childIds(at);
          // Records are appended as they're set: say each container's order outright.
          if (kids.length > 0) orders.add(at);
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as string);
        }
        orders.add(node.parent);
        continue;
      }
      if (old.parent !== node.parent) orders.add(node.parent);
      // A layer becoming a mask (or no longer one) changes what its parent draws.
      if (isActiveMask(old) !== isActiveMask(node) && node.parent !== page) sets.add(node.parent);
      if (old !== node && !forced.has(id) && onlyMoved(old, node)) moves.add(id);
      else sets.add(id);
    }
    for (const p of parents) {
      if (p !== page && (!this.#handles.has(p) || this.#pageOf(p) !== page)) continue;
      orders.add(p);
      // How many children it has decides whether it fades as one, and whether it masks.
      if (p !== page) sets.add(p);
    }
    for (const id of sets) moves.delete(id);

    const ctx = this.#context();
    const ordered = [...sets]
      .map((id) => [this.#depth(id), id] as const)
      .sort((a, b) => a[0] - b[0]);
    const records: Array<[number, number, WireRecord]> = [];
    for (const [, id] of ordered) {
      const node = doc.get(id);
      if (!node) continue;
      const before = this.#nodes.get(id);
      if (before && before.parent !== node.parent) this.#kids.get(before.parent)?.delete(id);
      records.push([this.#handleOf(id), this.#parentHandle(node), this.#encode(node, ctx)]);
      this.#kid(node.parent, id);
    }
    // Text sent provisional: encoded whole, a few milliseconds' worth (finding what's in view
    // included), what's in view first, at least one record or a slice of the scan.
    if (this.#deferred.size > 0) {
      const until = performance.now() + textMs;
      let sent = 0;
      const send = (id: string) => {
        if (!this.#deferred.has(id)) return;
        this.#deferred.delete(id);
        this.#visible.delete(id);
        const node = doc.get(id);
        if (!node || !this.#handles.has(id) || this.#pageOf(id) !== page) return;
        records.push([this.#handleOf(id), this.#parentHandle(node), this.#encode(node, ctx)]);
        sent++;
      };
      const more = () => sent === 0 || performance.now() < until;
      for (;;) {
        while (this.#shown.length > 0 && more()) send(this.#shown.pop() as string);
        // Out of time, or nothing more can be in view.
        if (this.#shown.length > 0 || !more() || this.#scanned) break;
        // Spent scanning without finding any: the next slice goes on from there.
        if (!this.#scan(until) && this.#shown.length === 0) break;
      }
      // Then the rest, in the order it was queued, once nothing more can be in view.
      if (this.#scanned && this.#shown.length === 0)
        while (this.#at < this.#queue.length && more()) send(this.#queue[this.#at++] as string);
      if (this.#at >= this.#queue.length && this.#shown.length === 0) {
        this.#queue = [];
        this.#at = 0;
        this.#scanAt = 0;
        this.#bounds.clear();
      }
    }
    const revision = this.#revision + 1;
    const w = new ListWriter(this.#revision, revision);
    const glyphs = this.#writeGlyphs(w);
    for (const [h, p, r] of records) w.set(h, p, r);
    for (const id of moves) {
      const node = doc.get(id);
      const h = this.#handles.get(id);
      if (!node || h === undefined) continue;
      this.#nodes.set(id, node);
      w.transform(h, localTransform(node));
    }
    // Removals after sets (a layer moved out of a removed one is safe in its new parent), and
    // only the topmost of a removed subtree.
    let removed = 0;
    for (const id of removes) {
      const parent = this.#nodes.get(id)?.parent;
      if (parent !== undefined && removes.has(parent)) {
        this.#forget(id);
        continue;
      }
      const h = this.#handles.get(id);
      if (h !== undefined) {
        w.remove(h);
        removed++;
      }
      this.#forget(id);
    }
    for (const p of orders) {
      if (p !== page && !this.#handles.has(p)) continue;
      const ids: number[] = [];
      for (const c of doc.childIds(p)) {
        const h = this.#handles.get(c);
        if (h !== undefined) ids.push(h);
      }
      w.order(p === page ? ROOT : (this.#handles.get(p) as number), ids);
    }
    this.#freeGlyphs(w);
    if (w.commands === 0) return null;
    this.#revision = revision;
    const bytes = w.finish();
    this.stats = {
      glyphs,
      records: records.length,
      transforms: moves.size,
      removed,
      bytes: bytes.length,
      ms: performance.now() - t0,
      fresh: false,
    };
    return bytes;
  }

  /** How many layers of each unsupported feature the page has. */
  unsupportedCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const bits of this.unsupported.values())
      for (let b = 0; b < 16; b++) if (bits & (1 << b)) out[b] = (out[b] ?? 0) + 1;
    return out;
  }
}
