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
  ListWriter,
  type PathData,
  ROOT,
  type WireRecord,
} from "@drawpane/engine/wire";
import type { NodeRecord } from "@drawpane/model";
import { isActiveMask } from "../masks";
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

export interface DisplayListOptions {
  /** An image's engine handle and natural size, once the engine holds its pixels; else null. */
  readonly image?: (ref: string) => EngineImage | null;
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

export class DisplayListBuilder {
  readonly #scene: Scene;
  readonly #measurer: TextMeasurer;
  readonly #image: (ref: string) => EngineImage | null;
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
  readonly #texts = new Set<string>();
  readonly #pendingText = new Set<string>();
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
  /** Layers on the page whose features the engine doesn't draw, with their bits. */
  readonly unsupported = new Map<string, number>();
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

  /** Whether everything on the page is something the engine draws. */
  get supported(): boolean {
    return this.unsupported.size === 0;
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

  #context(): LayerContext {
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
    };
  }

  #encode(node: NodeRecord, ctx: LayerContext): WireRecord {
    const e = encodeLayer(node, ctx);
    this.#useGlyphs(node.id, e.record);
    this.#nodes.set(node.id, node);
    if (node.type === "text") this.#texts.add(node.id);
    if (e.textPending) this.#pendingText.add(node.id);
    else this.#pendingText.delete(node.id);
    this.#useImages(node.id, e.images);
    if (e.record.unsupported) this.unsupported.set(node.id, e.record.unsupported);
    else this.unsupported.delete(node.id);
    return e.record;
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
    else this.#imagesBy.delete(id);
  }

  /** The image refs the page's records paint now: the engine may let the others go. */
  imagesInUse(): ReadonlySet<string> {
    return new Set(this.#imagesOf.keys());
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
   * list: the layers drawn alone, as `CanvasRenderer.renderNodes` draws them). Not patched
   * afterwards: `build` or `buildLayers` again.
   */
  buildLayers(ids: readonly string[]): Uint8Array {
    const doc = this.#scene.doc;
    const first = ids.map((id) => doc.get(id)).find((n) => n !== undefined);
    const pageId = first ? this.#pageOf(first.id) : null;
    const list = this.build(pageId ?? "", ids);
    this.#page = null;
    return list;
  }

  /**
   * A fresh list of every layer on `pageId` (or of just `roots` on it, placed on the page),
   * written as it's walked: each record goes into the message as it's encoded, after the glyphs
   * it brings, so the page is never held as records too.
   */
  build(pageId: string, roots?: readonly string[]): Uint8Array {
    const t0 = performance.now();
    const doc = this.#scene.doc;
    this.#page = pageId;
    this.#version = doc.version;
    this.#generation = this.#measurer.generation ?? 0;
    this.#glyphTable = glyphTable(doc).version;
    this.#stale = false;
    this.#handles.clear();
    this.#nodes.clear();
    this.#kids.clear();
    this.#imagesOf.clear();
    this.#imagesBy.clear();
    this.#texts.clear();
    this.#pendingText.clear();
    this.#extra.clear();
    this.unsupported.clear();
    this.#glyphs = new Map();
    this.#glyphData = new Map();
    this.#glyphRefs = new Map();
    this.#glyphsOf.clear();
    this.#unused.clear();
    this.#seen.clear();
    this.#shaped = new WeakMap();
    this.#newGlyphs = [];
    this.#nextGlyph = 1;
    const ctx = this.#context();
    const revision = this.#revision + 1;
    // Sized for the last fresh list (a page reopened, a reset), so the buffer rarely grows.
    const w = new ListWriter(
      ANY_REVISION,
      revision,
      Math.max(1 << 20, Math.ceil(this.#lastFresh * 1.1)),
    );
    w.reset();
    let records = 0;
    let glyphs = 0;
    const top = new Set(roots ?? []);
    const stack = [...(roots ?? doc.childIds(pageId))].reverse();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = doc.get(id);
      if (!node) continue;
      const parent = top.has(id) ? ROOT : this.#parentHandle(node);
      let record = this.#encode(node, ctx);
      // An export's top layers hang from the page directly: placed where they are on it.
      if (top.has(id))
        record = {
          ...record,
          transform:
            node.type === "group"
              ? this.#scene.spaceMatrix(node.parent)
              : this.#scene.worldMatrix(id),
        };
      glyphs += this.#writeGlyphs(w);
      w.set(this.#handleOf(id), parent, record);
      records++;
      this.#kid(node.parent, id);
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
      this.unsupported.delete(at);
      this.#useGlyphs(at, null);
      this.#useImages(at, []);
      const kids = this.#kids.get(at);
      if (kids) stack.push(...kids);
      this.#kids.delete(at);
    }
  }

  /** A patch since the last message, or null when nothing on the page changed. */
  update(): Uint8Array | null {
    const page = this.#page;
    if (!page) return null;
    const t0 = performance.now();
    const doc = this.#scene.doc;
    const changes = doc.changesSince(this.#version);
    if (this.#stale || !changes || changes.some((c) => c.reset) || !doc.get(page))
      return this.build(page);
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
    if (generation !== this.#generation) {
      // Fonts or faces arrived: every text's layout may have moved.
      for (const id of this.#texts) forced.add(id);
      this.#generation = generation;
    } else for (const id of this.#pendingText) forced.add(id);
    // A glyph set changed (a file's saved outlines): text drawn from them may draw differently.
    const table = glyphTable(doc).version;
    if (table !== this.#glyphTable) {
      for (const id of this.#texts) forced.add(id);
      this.#glyphTable = table;
    }
    for (const id of forced) touched.add(id);
    this.#version = doc.version;
    if (touched.size === 0 && parents.size === 0) return null;

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
