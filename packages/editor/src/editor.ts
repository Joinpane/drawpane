/**
 * The editor: one object that owns the document, sync, history, scene and UI
 * state, and exposes every editing command. The React shell renders from it;
 * the command bar, shortcuts, menus and agents all call the same methods.
 */

import type { Peer } from "@drawpane/model";
import {
  type BindingKey,
  defaultOf,
  getProp,
  keyBetween,
  keysBetween,
  type LayerType,
  type NodeRecord,
  type NodeType,
  newId,
  type Op,
  type PropName,
  type Props,
  propAllowed,
  ROOT_ID,
  type RulerGuide,
  type VariableValue,
} from "@drawpane/model";
import { Camera, type Insets, NO_INSETS } from "./camera";
import {
  componentSetOf,
  detachOps,
  findVariant,
  instanceRootOf,
  instantiateOps,
  isInsideInstance,
  isMainComponent,
  overrideOps,
  propagationOps,
  resetOverridesOps,
  swapInstanceOps,
  syncInstanceOps,
  variantProperties,
  variantsOf,
  wouldCycle,
} from "./components";
import { constraintOps } from "./constraints";
import { Doc } from "./doc";
import { dependsOn, parseDtcg } from "./dtcg";
import {
  apply,
  boxOf,
  invert,
  multiply,
  normalizeDegrees,
  normalizeRect,
  type Point,
  type Rect,
  rectsIntersect,
  rotationOf,
  round2,
  unionRects,
} from "./geometry";
import { withGuide } from "./grids";
import { applyBestEffort, History } from "./history";
import { hitAll } from "./hit";
import { layoutImageRow } from "./images";
import { layoutOps } from "./layout";
import { Scene } from "./scene";
import type { Guide } from "./snap";
import { Store } from "./store";
import { type ConnectionStatus, SyncEngine } from "./sync";
import { autoSize, type TextMeasurer } from "./text";
import {
  BINDING_TARGETS,
  unbindOps,
  type VariableType,
  variableFixupOps,
  variablesIn,
} from "./variables";

import type { BooleanEngine, BooleanEngineLoader, BooleanOp } from "./vector/boolean";
import * as vector from "./vector/commands";
import { pathResizeOps } from "./vector/node";
import type { VectorPath } from "./vector/path";
import { loadPathKitEngine } from "./vector/pathkit";

export type ToolId =
  | "select"
  | "hand"
  | "frame"
  | "rect"
  | "ellipse"
  | "polygon"
  | "star"
  | "line"
  /** Draws a line with an arrow at its end (⇧L). */
  | "arrow"
  | "text"
  | "pen"
  /** Drops comment pins. The web app handles its clicks; the canvas interaction ignores them. */
  | "comment";

/** Editing a path's anchors: which path, and which anchors ("subpath:index") are selected. */
export interface VectorEditState {
  readonly id: string;
  readonly anchors: readonly string[];
}

export interface EditorState {
  readonly pageId: string | null;
  readonly selection: readonly string[];
  readonly hover: string | null;
  readonly tool: ToolId;
  readonly camera: Camera;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Parts of the viewport covered by floating panels; fitting and revealing avoid them. */
  readonly insets: Insets;
  readonly editingText: string | null;
  readonly marquee: Rect | null;
  readonly guides: readonly Guide[];
  /** True while a pointer gesture (move, resize, draw) is in progress. */
  readonly gesture: boolean;
  /** Layout X-ray: overlay padding and gaps (hold Alt). */
  readonly xray: boolean;
  /** Hide other people's cursors and selections. */
  readonly focusMode: boolean;
  readonly status: ConnectionStatus;
  readonly role: "owner" | "editor" | "viewer";
  readonly peers: ReadonlyMap<string, Peer>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Last message worth telling the user (a rejected edit, a desync, a restore). */
  readonly notice: Notice | null;
  /** Vector edit mode on a path, or null. */
  readonly vectorEdit: VectorEditState | null;
  /** The pointer in page coordinates while the pen or vector edit draws live feedback. */
  readonly vectorPointer: Point | null;
  /** The Prototype tab is open: the canvas shows connections and connection handles. */
  readonly prototyping: boolean;
  /** A connection being dragged from a layer's handle, or null. */
  readonly connecting: ConnectionDrag | null;
  /** Rulers along the canvas edges (⇧R). Guides show either way. */
  readonly rulers: boolean;
  /** Frames' layout grids on the canvas (⇧G). */
  readonly layoutGrids: boolean;
  /** A guide being dragged (from a ruler, or an existing one), drawn live and committed on drop. */
  readonly guideDraft: GuideDraft | null;
  /** The guide under the pointer, highlighted so it reads as grabbable. */
  readonly hoverGuide: { readonly owner: string; readonly index: number } | null;
}

export interface GuideDraft {
  readonly axis: "x" | "y";
  /** Page coordinate of the line. */
  readonly at: number;
  /** The guide being moved, or null for a new one. */
  readonly from: { readonly owner: string; readonly index: number } | null;
  /** Where it lands in its owner's coordinates (a frame's, or the page's): the label shows this. */
  readonly offset: number;
  /** True while the pointer is back over the ruler: dropping removes the guide. */
  readonly removing: boolean;
}

export interface Notice {
  readonly id: number;
  readonly text: string;
  /** One follow-up the message offers, such as "Undo" or "Show". */
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface ConnectionDrag {
  readonly from: string;
  /** The pointer in page coordinates. */
  readonly pointer: Point;
  /** The screen it would connect to if dropped now. */
  readonly target: string | null;
}

export interface CommitOptions {
  /**
   * Record edits to layers inside instances as overrides (the default, for
   * anything a person does). Off for writes derived from the main component.
   */
  readonly overrides?: boolean;
  /**
   * Move and size the children of resized frames by their constraints (the
   * default). Off while ⌘ is held during a resize, like Figma.
   */
  readonly constraints?: boolean;
}

export interface EditorOptions {
  readonly clientId?: string;
  readonly measurer: TextMeasurer;
  /** Loads the boolean geometry engine on first use (defaults to PathKit). */
  readonly booleanEngine?: BooleanEngineLoader;
}

/** "State=Hover, Size=Large": how variant layers are named, like Figma. */
export function formatVariantName(props: Readonly<Record<string, string>>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** The longest shared start of several names, trimmed at a separator ("Button/Primary", "Button/Ghost" → "Button"). */
function commonPrefix(names: readonly string[]): string {
  if (names.length < 2) return "";
  let prefix = names[0] ?? "";
  for (const name of names.slice(1)) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.replace(/[\s/·,=-]+$/, "").trim();
}

/** Bound on derived-write rounds (sync, text, layout) per commit; real files settle in two or three. */
const MAX_FIXUP_ROUNDS = 8;

const ALIGN_EDGES = ["left", "center", "right", "top", "middle", "bottom"] as const;
export type AlignEdge = (typeof ALIGN_EDGES)[number];

export class Editor {
  readonly doc = new Doc();
  readonly scene = new Scene(this.doc);
  readonly history = new History();
  readonly sync: SyncEngine;
  readonly measurer: TextMeasurer;
  readonly state = new Store<EditorState>({
    pageId: null,
    selection: [],
    hover: null,
    tool: "select",
    camera: new Camera(),
    viewport: { width: 0, height: 0 },
    insets: NO_INSETS,
    editingText: null,
    marquee: null,
    guides: [],
    gesture: false,
    xray: false,
    focusMode: false,
    status: "connecting",
    role: "viewer",
    peers: new Map(),
    canUndo: false,
    canRedo: false,
    notice: null,
    vectorEdit: null,
    vectorPointer: null,
    prototyping: false,
    connecting: null,
    rulers: false,
    layoutGrids: true,
    guideDraft: null,
    hoverGuide: null,
  });
  #noticeId = 0;
  readonly #cameras = new Map<string, Camera>();
  #booleanLoader: BooleanEngineLoader;
  #booleanEngine: Promise<BooleanEngine> | null = null;

  constructor(options: EditorOptions) {
    this.measurer = options.measurer;
    this.#booleanLoader = options.booleanEngine ?? (() => loadPathKitEngine());
    this.sync = new SyncEngine(this.doc, { clientId: options.clientId ?? newId() });
    this.sync.on("status", (status) => this.state.set({ status }));
    this.sync.on("role", (role) => this.state.set({ role }));
    this.sync.on("peers", (peers) => this.state.set({ peers: new Map(peers) }));
    this.sync.on("rejected", (_code, message) =>
      this.notify(`Couldn't apply that change: ${message}`),
    );
    this.sync.on("desync", () => this.notify("Reloading the latest version of this file."));
    this.history.subscribe(() =>
      this.state.set({ canUndo: this.history.canUndo, canRedo: this.history.canRedo }),
    );
    this.doc.subscribe(() => this.#reconcile());
    // Leave vector edit when its path goes away or the selection or tool moves on.
    this.state.subscribe(() => vector.reconcileVectorEdit(this));
    this.doc.subscribe(() => vector.reconcileVectorEdit(this));
  }

  get s(): EditorState {
    return this.state.get();
  }

  get canEdit(): boolean {
    return this.s.role !== "viewer";
  }

  /**
   * Shows a fixed document that never syncs, such as a saved version. The
   * editor is read-only and already live; the page and selection carry over
   * where the new document still has them.
   */
  loadStatic(nodes: Iterable<NodeRecord>): void {
    this.state.set({ status: "live", role: "viewer", editingText: null, vectorEdit: null });
    this.doc.reset(nodes);
  }

  notify(text: string, action?: Notice["action"]): void {
    this.state.set({ notice: { id: ++this.#noticeId, text, ...(action ? { action } : {}) } });
  }

  /** Keeps UI state valid after the document changes (remote deletes, page removal). */
  #reconcile(): void {
    const { pageId, selection, hover, editingText } = this.s;
    const pages = this.doc.pageIds();
    const patch: { -readonly [K in keyof EditorState]?: EditorState[K] } = {};
    if (!pageId || !this.doc.has(pageId)) patch.pageId = pages[0] ?? null;
    const alive = selection.filter((id) => this.doc.has(id));
    if (alive.length !== selection.length) patch.selection = alive;
    if (hover && !this.doc.has(hover)) patch.hover = null;
    if (editingText && !this.doc.has(editingText)) patch.editingText = null;
    if (Object.keys(patch).length > 0) this.state.set(patch);
  }

  // -------------------------------------------------------------------------
  // Committing

  /**
   * Applies operations as you, with derived fix-ups (text auto-size, auto
   * layout) in the same transaction, and records one undo step. Returns false
   * when the edit is invalid or you can only view.
   */
  commit(ops: readonly Op[], label = "Edit", options: CommitOptions = {}): boolean {
    if (!this.canEdit || ops.length === 0) return false;
    let inverse: Op[];
    try {
      inverse = this.#commitWithFixups(ops, options.overrides ?? true, options.constraints ?? true);
    } catch (error) {
      if (error instanceof Error && error.name === "ModelError") {
        this.notify(error.message);
        return false;
      }
      throw error;
    }
    this.history.record(label, inverse, this.s.selection);
    return true;
  }

  #commitWithFixups(ops: readonly Op[], recordOverrides = true, constrain = true): Op[] {
    return this.doc.batch(() => {
      // A person's edit inside an instance records an override, and setting a
      // bound property by hand detaches its variable; both before the derived
      // writes below, so those leave the edited properties alone.
      const marks = recordOverrides
        ? [...overrideOps(this.doc, ops), ...unbindOps(this.doc, ops)]
        : [];
      // Resizing a frame moves its children by their constraints; resizing a
      // path (handles, inspector, constraints) scales its path data with its box.
      const constrained = constrain ? constraintOps(this.doc, ops) : [];
      const pathOps = pathResizeOps(this.doc, [...ops, ...constrained]);
      const extra = [...marks, ...constrained, ...pathOps];
      const first = extra.length > 0 ? [...ops, ...extra] : ops;
      let inverse = this.sync.commit(first);
      let touched = this.#touchedBy(ops, inverse);
      let lastOps: readonly Op[] = first;
      // Derived writes until nothing changes: instances follow their main
      // component, bound properties follow their variables, text sizes to its
      // content, auto layout places children. Each can feed the next.
      for (let round = 0; round < MAX_FIXUP_ROUNDS && touched.size > 0; round++) {
        const live = [...touched].filter((id) => this.doc.has(id));
        const synced = propagationOps(this.doc, live);
        let roundInverse: Op[] = synced.length > 0 ? this.sync.commit(synced) : [];
        const resolved = variableFixupOps(this.doc, [...lastOps, ...synced]);
        if (resolved.length > 0) roundInverse = [...this.sync.commit(resolved), ...roundInverse];
        const derivedSoFar = [...synced, ...resolved];
        const text = this.#textFixups([...live, ...derivedSoFar.map((o) => o.id)]);
        if (text.length > 0) roundInverse = [...this.sync.commit(text), ...roundInverse];
        const derived = [...derivedSoFar, ...text];
        const afterSync =
          derived.length > 0 ? this.#touchedBy(derived, roundInverse) : new Set<string>();
        const layoutTargets = [...new Set([...live, ...afterSync])].filter((id) =>
          this.doc.has(id),
        );
        const layout = layoutOps(this.doc, layoutTargets);
        layout.push(...constraintOps(this.doc, layout));
        layout.push(...pathResizeOps(this.doc, layout));
        const layoutInverse = layout.length > 0 ? this.sync.commit(layout) : [];
        inverse = [...layoutInverse, ...roundInverse, ...inverse];
        touched = new Set([...afterSync, ...this.#touchedBy(layout, layoutInverse)]);
        lastOps = [...derived, ...layout];
      }
      return inverse;
    });
  }

  /** Node ids an applied batch changed, plus the parents whose children changed. */
  #touchedBy(ops: readonly Op[], inverse: readonly Op[]): Set<string> {
    const touched = new Set<string>();
    for (const op of ops) {
      touched.add(op.id);
      if (op.op === "move" || op.op === "create") touched.add(op.parent);
    }
    // Removed or moved nodes leave a gap in their old parent's layout.
    for (const op of inverse) if (op.op === "create" || op.op === "move") touched.add(op.parent);
    return touched;
  }

  #textFixups(ids: Iterable<string>): Op[] {
    const ops: Op[] = [];
    for (const id of ids) {
      const node = this.doc.get(id);
      if (node?.type !== "text") continue;
      const size = autoSize(node, this.measurer);
      if (!size) continue;
      const width = round2(size.width);
      const height = round2(size.height);
      if (width !== round2(getProp(node.props, "width")))
        ops.push({ op: "set", id, prop: "width", value: width });
      if (height !== round2(getProp(node.props, "height")))
        ops.push({ op: "set", id, prop: "height", value: height });
    }
    return ops;
  }

  /** Groups every commit until `endGesture` into one undo step (a drag, a scrub, typing). */
  beginGesture(label: string): void {
    this.history.begin(label, this.s.selection);
    this.state.set({ gesture: true });
  }

  endGesture(): void {
    this.history.end();
    this.state.set({ gesture: false, guides: [] });
  }

  undo(): void {
    if (!this.canEdit) return;
    const selection = this.history.undo(
      (ops) => this.#commitWithFixups(ops, false),
      this.s.selection,
    );
    if (selection) this.select(selection.filter((id) => this.doc.has(id)));
  }

  redo(): void {
    if (!this.canEdit) return;
    const selection = this.history.redo(
      (ops) => this.#commitWithFixups(ops, false),
      this.s.selection,
    );
    if (selection) this.select(selection.filter((id) => this.doc.has(id)));
  }

  // -------------------------------------------------------------------------
  // Pages, selection, camera, tools

  setPage(pageId: string): void {
    const { pageId: current, camera } = this.s;
    if (current) this.#cameras.set(current, camera);
    this.state.set({
      pageId,
      selection: [],
      hover: null,
      editingText: null,
      camera: this.#cameras.get(pageId) ?? new Camera(),
    });
  }

  select(ids: readonly string[]): void {
    const unique = [...new Set(ids)].filter((id) => this.doc.has(id));
    const same =
      unique.length === this.s.selection.length &&
      unique.every((id, i) => id === this.s.selection[i]);
    if (!same) this.state.set({ selection: unique });
  }

  selectAll(): void {
    const { selection, pageId } = this.s;
    const first = selection[0] && this.doc.get(selection[0]);
    const container = first ? first.parent : pageId;
    if (!container) return;
    this.select(
      this.doc
        .childIds(container)
        .filter((id) => !this.scene.isLocked(id) && this.scene.isVisible(id)),
    );
  }

  setTool(tool: ToolId): void {
    this.state.set({ tool, editingText: null });
  }

  setCamera(camera: Camera): void {
    this.state.set({ camera });
  }

  setViewport(width: number, height: number): void {
    this.state.set({ viewport: { width, height } });
  }

  zoomBy(factor: number, at?: { x: number; y: number }): void {
    const { camera, viewport } = this.s;
    this.setCamera(
      camera.zoomAt(at ?? { x: viewport.width / 2, y: viewport.height / 2 }, camera.zoom * factor),
    );
  }

  zoomTo(zoom: number): void {
    const { camera, viewport, insets } = this.s;
    const centre = {
      x: insets.left + (viewport.width - insets.left - insets.right) / 2,
      y: insets.top + (viewport.height - insets.top - insets.bottom) / 2,
    };
    this.setCamera(camera.zoomAt(centre, zoom));
  }

  zoomToFit(): void {
    const { pageId, viewport, insets } = this.s;
    if (!pageId) return;
    const bounds = this.scene.unionBounds(this.doc.childIds(pageId));
    if (bounds) this.setCamera(this.s.camera.fit(bounds, viewport, 64, 1, insets));
  }

  /** Pans (or zooms out) just enough to bring the selection into the visible part of the canvas. */
  revealSelection(): void {
    const bounds = this.scene.unionBounds(this.s.selection);
    if (!bounds) return;
    const { camera, viewport, insets } = this.s;
    const margin = 96;
    const areaW = viewport.width - insets.left - insets.right;
    const areaH = viewport.height - insets.top - insets.bottom;
    const fits =
      bounds.width * camera.zoom <= areaW - margin * 2 &&
      bounds.height * camera.zoom <= areaH - margin * 2;
    if (fits) {
      const centre = camera.toScreen({
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      });
      this.setCamera(
        camera.pan(insets.left + areaW / 2 - centre.x, insets.top + areaH / 2 - centre.y),
      );
    } else {
      this.setCamera(camera.fit(bounds, viewport, margin, camera.zoom, insets));
    }
  }

  zoomToSelection(): void {
    const bounds = this.scene.unionBounds(this.s.selection);
    if (bounds) this.setCamera(this.s.camera.fit(bounds, this.s.viewport, 64, 8, this.s.insets));
  }

  insertionParent(): string | null {
    const { selection, pageId } = this.s;
    const first = selection.length === 1 ? this.doc.get(selection[0] as string) : undefined;
    if (!first) return pageId;
    // An instance's structure comes from its main component: insert beside it instead.
    const instance = instanceRootOf(this.doc, first.id);
    if (instance) return instance.parent;
    if (first.type === "frame") return first.id;
    return first.parent;
  }

  /** The frame (or page) under a page point that would receive a new or moved layer. */
  dropTarget(p: { x: number; y: number }, exclude: ReadonlySet<string> = new Set()): string | null {
    const pageId = this.s.pageId;
    if (!pageId) return null;
    const visit = (parent: string): string | null => {
      const children = this.doc.childIds(parent);
      for (let i = children.length - 1; i >= 0; i--) {
        const id = children[i] as string;
        const node = this.doc.get(id);
        if (!node || exclude.has(id) || node.props.visible === false || node.props.locked === true)
          continue;
        if (node.type === "group") {
          const hit = visit(id);
          if (hit) return hit;
          continue;
        }
        if (node.type !== "frame" || getProp(node.props, "instanceOf") !== null) continue;
        const local = this.scene.toLocal(id, p);
        const w = getProp(node.props, "width");
        const h = getProp(node.props, "height");
        if (local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h) return visit(id) ?? id;
      }
      return null;
    };
    return visit(pageId) ?? pageId;
  }

  // -------------------------------------------------------------------------
  // Creating and changing layers

  /** A key that places a new child last (on top) in `parent`. */
  topKey(parent: string): string {
    const last = this.doc.childIds(parent).at(-1);
    return keyBetween(last ? (this.doc.get(last)?.key ?? null) : null, null);
  }

  defaultName(type: LayerType): string {
    const base = {
      frame: "Frame",
      group: "Group",
      rect: "Rectangle",
      ellipse: "Ellipse",
      polygon: "Polygon",
      star: "Star",
      line: "Line",
      path: "Vector",
      text: "Text",
    }[type];
    let max = 0;
    for (const node of this.doc.nodes()) {
      const m = node.props.name?.match(new RegExp(`^${base} (\\d+)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${base} ${max + 1}`;
  }

  /** Default look for a new layer of each type, using the file's reserved tokens later. */
  defaultProps(type: LayerType): Props {
    switch (type) {
      case "frame":
        return { fills: [{ type: "solid", color: "#ffffff" }] };
      case "rect":
      case "ellipse":
      case "polygon":
        return { fills: [{ type: "solid", color: "#d9d9d6" }] };
      case "star":
        // Polygons start as triangles (the property's default); stars with five points.
        return { fills: [{ type: "solid", color: "#d9d9d6" }], pointCount: 5 };
      case "line":
        return { strokes: [{ type: "solid", color: "#1c1b1a" }], strokeWeight: 1 };
      case "text":
        return {
          fills: [{ type: "solid", color: "#1c1b1a" }],
          characters: "",
          textAutoResize: "width",
        };
      default:
        return {};
    }
  }

  /**
   * Adds a frame of a preset size, named after the preset: centred in view,
   * or beside the page's top-level layers when that spot is taken, so it never
   * lands on top of work. Selects it, shows it and goes back to Move.
   */
  insertFramePreset(preset: { name: string; width: number; height: number }): string | null {
    const { pageId, viewport, insets, camera } = this.s;
    if (!pageId) return null;
    const centre = camera.toPage({
      x: insets.left + (viewport.width - insets.left - insets.right) / 2,
      y: insets.top + (viewport.height - insets.top - insets.bottom) / 2,
    });
    let rect: Rect = {
      x: round2(centre.x - preset.width / 2),
      y: round2(centre.y - preset.height / 2),
      width: preset.width,
      height: preset.height,
    };
    const taken = this.doc
      .childIds(pageId)
      .filter((id) => this.doc.get(id)?.props.visible !== false)
      .map((id) => this.scene.bounds(id))
      .filter((b): b is Rect => b !== null);
    if (taken.some((b) => rectsIntersect(b, rect))) {
      const all = unionRects(taken) as Rect;
      rect = { ...rect, x: round2(all.x + all.width + 100), y: round2(all.y) };
    }
    const id = this.createLayer("frame", rect, pageId, { name: preset.name });
    if (!id) return null;
    this.select([id]);
    this.setTool("select");
    this.revealSelection();
    return id;
  }

  /** Creates a layer from a rectangle in page coordinates. Returns its id. */
  createLayer(type: LayerType, rect: Rect, parent: string, props: Props = {}): string | null {
    const id = newId();
    const origin = this.scene.toSpace(parent, { x: rect.x, y: rect.y });
    const ok = this.commit(
      [
        {
          op: "create",
          id,
          type,
          parent,
          key: this.topKey(parent),
          props: {
            name: this.defaultName(type),
            ...this.defaultProps(type),
            x: round2(origin.x),
            y: round2(origin.y),
            width: round2(rect.width),
            height: round2(rect.height),
            ...props,
          },
        },
      ],
      `Create ${type}`,
    );
    return ok ? id : null;
  }

  /**
   * Places images as rectangles with an image fill: each at its natural size,
   * scaled down to fit the viewport, side by side and centred on `at` (page
   * coordinates; the viewport centre by default), inside the frame under that
   * point. Selects the new layers and returns their ids, in order.
   */
  insertImages(
    images: readonly { ref: string; width: number; height: number; name: string }[],
    at?: Point,
  ): string[] {
    const { camera, viewport, pageId } = this.s;
    if (images.length === 0 || !pageId) return [];
    const center = at ?? camera.toPage({ x: viewport.width / 2, y: viewport.height / 2 });
    const fit = (px: number) => (px > 0 ? (px * 0.8) / camera.zoom : Number.POSITIVE_INFINITY);
    const rects = layoutImageRow(images, center, {
      width: fit(viewport.width),
      height: fit(viewport.height),
    });
    const parent = this.dropTarget(center) ?? pageId;
    const last = this.doc.childIds(parent).at(-1);
    const keys = keysBetween(last ? (this.doc.get(last)?.key ?? null) : null, null, images.length);
    const ids: string[] = [];
    const ops: Op[] = images.map((image, i) => {
      const id = newId();
      ids.push(id);
      const rect = rects[i] as Rect;
      const origin = this.scene.toSpace(parent, { x: rect.x, y: rect.y });
      return {
        op: "create",
        id,
        type: "rect",
        parent,
        key: keys[i] as string,
        props: {
          name: image.name.trim().slice(0, 256) || "Image",
          x: round2(origin.x),
          y: round2(origin.y),
          width: rect.width,
          height: rect.height,
          fills: [{ type: "image", ref: image.ref, scaleMode: "fill" }],
        },
      };
    });
    if (!this.commit(ops, images.length === 1 ? "Place image" : "Place images")) return [];
    this.select(ids);
    return ids;
  }

  /** Sets one property on several layers, skipping layers the property doesn't apply to. */
  setProp(ids: readonly string[], prop: PropName, value: unknown, label = "Change property"): void {
    const ops: Op[] = [];
    for (const id of ids) {
      const node = this.doc.get(id);
      if (!node) continue;
      if (JSON.stringify(node.props[prop] ?? null) === JSON.stringify(value ?? null)) continue;
      ops.push({ op: "set", id, prop, value });
    }
    if (ops.length > 0) this.commit(ops, label);
  }

  /**
   * Sets width or height on several layers. Layers with a locked aspect ratio
   * change the other side too, and typing a size makes that axis fixed.
   */
  resize(ids: readonly string[], prop: "width" | "height", value: number, label = "Resize"): void {
    const ops: Op[] = [];
    const other = prop === "width" ? "height" : "width";
    for (const id of ids) {
      const node = this.doc.get(id);
      if (!node || node.type === "group" || node.type === "page") continue;
      const now = getProp(node.props, prop);
      const v = round2(Math.max(0, value));
      if (v === round2(now)) continue;
      ops.push({ op: "set", id, prop, value: v });
      if (getProp(node.props, "lockAspect") && now > 0) {
        const o = round2((getProp(node.props, other) * v) / now);
        if (o !== round2(getProp(node.props, other)))
          ops.push({ op: "set", id, prop: other, value: o });
      }
      const sizing = prop === "width" ? "sizingH" : "sizingV";
      if (getProp(node.props, sizing) !== "fixed")
        ops.push({ op: "set", id, prop: sizing, value: "fixed" });
    }
    if (ops.length > 0) this.commit(ops, label);
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.setProp([id], "name", trimmed, "Rename");
  }

  deleteSelection(): void {
    const all = this.#topmost(this.s.selection);
    const ids = all.filter((id) => !isInsideInstance(this.doc, id));
    if (ids.length < all.length) {
      this.notify(
        "Layers inside an instance come from its main component. Hide them instead, or detach the instance.",
      );
    }
    if (ids.length === 0) return;
    if (
      this.commit(
        ids.map((id) => ({ op: "delete", id })),
        "Delete",
      )
    )
      this.select([]);
  }

  /** Drops ids whose ancestor is also in the list, so subtree ops aren't doubled. */
  #topmost(ids: readonly string[]): string[] {
    const set = new Set(ids);
    return ids.filter(
      (id) => this.doc.has(id) && !this.doc.ancestors(id).some((a) => set.has(a.id)),
    );
  }

  /** Re-creates a subtree under new ids. Returns the create operations, parents first. */
  cloneOps(
    id: string,
    parent: string,
    key: string,
    offset = { x: 0, y: 0 },
  ): { ops: Op[]; rootId: string } {
    const ids = new Map<string, string>();
    const ops: Op[] = [];
    const visit = (nodeId: string, parentId: string, nodeKey: string, isRoot: boolean) => {
      const node = this.doc.get(nodeId);
      if (!node) return;
      const copyId = newId();
      ids.set(nodeId, copyId);
      const props: Record<string, unknown> = { ...node.props };
      // Groups and pages have no position of their own.
      if (isRoot && propAllowed(node.type, "x")) {
        props.x = round2(getProp(node.props, "x") + offset.x);
        props.y = round2(getProp(node.props, "y") + offset.y);
      }
      ops.push({
        op: "create",
        id: copyId,
        type: node.type,
        parent: parentId,
        key: nodeKey,
        props,
      });
      for (const child of this.doc.childIds(nodeId)) {
        const c = this.doc.get(child);
        if (c) visit(child, copyId, c.key, false);
      }
      if (isRoot && node.type === "group" && (offset.x !== 0 || offset.y !== 0)) {
        // Groups have no position: shift their geometry-owning descendants instead.
        for (const op of ops) {
          if (
            op.op === "create" &&
            op.id !== copyId &&
            op.type !== "group" &&
            this.#directGeometryChild(op, ops, copyId)
          ) {
            const p = op.props as Record<string, number>;
            (op.props as Record<string, unknown>).x = round2((p.x ?? 0) + offset.x);
            (op.props as Record<string, unknown>).y = round2((p.y ?? 0) + offset.y);
          }
        }
      }
    };
    visit(id, parent, key, true);
    return { ops, rootId: ids.get(id) ?? id };
  }

  /** True when `op`'s node sits in the same coordinate space as the group `groupId` (only groups between). */
  #directGeometryChild(op: Extract<Op, { op: "create" }>, ops: Op[], groupId: string): boolean {
    let parent = op.parent;
    for (;;) {
      if (parent === groupId) return true;
      const p = ops.find(
        (o): o is Extract<Op, { op: "create" }> => o.op === "create" && o.id === parent,
      );
      if (p?.type !== "group") return false;
      parent = p.parent;
    }
  }

  duplicate(): void {
    const ids = this.#topmost(this.s.selection);
    if (ids.length === 0) return;
    const ops: Op[] = [];
    const created: string[] = [];
    for (const id of ids) {
      const node = this.doc.get(id);
      if (!node) continue;
      const siblings = this.doc.childIds(node.parent);
      const next = siblings[siblings.indexOf(id) + 1];
      const key = keyBetween(node.key, next ? (this.doc.get(next)?.key ?? null) : null);
      const inLayout = getProp(this.doc.get(node.parent)?.props ?? {}, "layoutMode") !== "none";
      if (isMainComponent(node)) {
        const offset = inLayout ? 0 : getProp(node.props, "width") + 40;
        const made = instantiateOps(this.doc, id, node.parent, key, {
          x: round2(getProp(node.props, "x") + offset),
          y: getProp(node.props, "y"),
        });
        if (made) {
          ops.push(...made.ops);
          created.push(made.rootId);
        }
        continue;
      }
      if (isInsideInstance(this.doc, id)) continue;
      const { ops: cloned, rootId } = this.cloneOps(
        id,
        node.parent,
        key,
        inLayout ? { x: 0, y: 0 } : { x: 16, y: 16 },
      );
      ops.push(...cloned);
      created.push(rootId);
    }
    if (this.commit(ops, "Duplicate")) this.select(created);
  }

  /**
   * Moves a node to a new parent and order key without moving it on screen:
   * its geometry converts into the new coordinate space. When the new parent
   * is created in the same commit (a new group), pass the existing node whose
   * coordinate space it will share as `spaceParent`.
   */
  reparentOps(id: string, parent: string, key: string, spaceParent = parent): Op[] {
    const node = this.doc.get(id);
    if (!node) return [];
    const ops: Op[] = [{ op: "move", id, parent, key }];
    const fromSpace = this.scene.spaceMatrix(this.scene.spaceOwner(node.parent));
    const toSpace = this.scene.spaceMatrix(this.scene.spaceOwner(spaceParent));
    const sameSpace = fromSpace.every((v, i) => Math.abs(v - (toSpace[i] as number)) < 1e-9);
    if (sameSpace) return ops;
    const convert = (n: NodeRecord) => {
      if (n.type === "group") {
        for (const child of this.doc.childIds(n.id)) {
          const c = this.doc.get(child);
          if (c) convert(c);
        }
        return;
      }
      const world = this.scene.worldMatrix(n.id);
      const local = multiply(invert(toSpace), world);
      const w = getProp(n.props, "width");
      const h = getProp(n.props, "height");
      const centre = apply(local, { x: w / 2, y: h / 2 });
      const flipped = getProp(n.props, "flipX") !== getProp(n.props, "flipY");
      const rotation = round2(rotationOf(local) + (flipped && getProp(n.props, "flipX") ? 180 : 0));
      ops.push(
        { op: "set", id: n.id, prop: "x", value: round2(centre.x - w / 2) },
        { op: "set", id: n.id, prop: "y", value: round2(centre.y - h / 2) },
      );
      if (rotation !== round2(getProp(n.props, "rotation")))
        ops.push({ op: "set", id: n.id, prop: "rotation", value: rotation });
    };
    convert(node);
    return ops;
  }

  /**
   * "Use as mask" (⌥⌘M), like Figma. One layer becomes a mask in place,
   * clipping the layers above it; several are grouped into a "Mask group"
   * whose bottom layer is the mask. When every selected layer is already a
   * mask, it stops being one.
   */
  toggleMask(): void {
    const ids = this.#ordered(this.#topmost(this.s.selection));
    if (ids.length === 0) return;
    const nodes = ids.map((id) => this.doc.get(id)).filter((n): n is NodeRecord => !!n);
    if (nodes.every((n) => getProp(n.props, "isMask"))) {
      this.setProp(ids, "isMask", null, "Remove mask");
      return;
    }
    const bottom = nodes[0] as NodeRecord;
    if (!propAllowed(bottom.type, "isMask")) {
      this.notify("A mask needs an outline: use a shape, frame or vector as the bottom layer.");
      return;
    }
    if (nodes.length === 1) {
      // On the page it would clip everything above it: ask for the layers it should clip.
      if (this.doc.get(bottom.parent)?.type === "page") {
        this.notify("Select the mask together with the layers it should clip.");
        return;
      }
      this.setProp([bottom.id], "isMask", true, "Use as mask");
      return;
    }
    if (this.#refuseInsideInstance()) return;
    this.beginGesture("Use as mask");
    try {
      this.group({ name: "Mask group" });
      this.setProp([bottom.id], "isMask", true);
    } finally {
      this.endGesture();
    }
  }

  group(options: { name?: string } = {}): void {
    if (this.#refuseInsideInstance()) return;
    const ids = this.#ordered(this.#topmost(this.s.selection));
    const first = ids[0] && this.doc.get(ids[0]);
    if (!first) return;
    const parent = first.parent;
    const last = this.doc.get(ids.at(-1) as string);
    const siblings = this.doc.childIds(parent);
    const after = siblings[siblings.indexOf(last?.id ?? "") + 1];
    const groupId = newId();
    const ops: Op[] = [
      {
        op: "create",
        id: groupId,
        type: "group",
        parent,
        key: keyBetween(last?.key ?? null, after ? (this.doc.get(after)?.key ?? null) : null),
        props: { name: options.name ?? this.defaultName("group") },
      },
    ];
    const keys = keysBetween(null, null, ids.length);
    for (const [i, id] of ids.entries())
      ops.push(...this.reparentOps(id, groupId, keys[i] as string, parent));
    if (this.commit(ops, "Group")) this.select([groupId]);
  }

  ungroup(): void {
    if (this.#refuseInsideInstance()) return;
    const ops: Op[] = [];
    const released: string[] = [];
    for (const id of this.s.selection) {
      const group = this.doc.get(id);
      if (group?.type !== "group" && !(group?.type === "frame" && this.doc.childIds(id).length > 0))
        continue;
      if (!group) continue;
      const siblings = this.doc.childIds(group.parent);
      const next = siblings[siblings.indexOf(id) + 1];
      const children = this.doc.childIds(id);
      const keys = keysBetween(
        group.key,
        next ? (this.doc.get(next)?.key ?? null) : null,
        children.length,
      );
      children.forEach((child, i) => {
        ops.push(...this.reparentOps(child, group.parent, keys[i] as string));
        released.push(child);
      });
      ops.push({ op: "delete", id });
    }
    if (this.commit(ops, "Ungroup")) this.select(released);
  }

  /** Wraps the selection in a new frame sized to it (⌥⌘G), or with auto layout (⇧A). */
  frameSelection(autoLayout = false): void {
    if (this.#refuseInsideInstance()) return;
    const ids = this.#ordered(this.#topmost(this.s.selection));
    const bounds = this.scene.unionBounds(ids);
    const first = ids[0] && this.doc.get(ids[0]);
    if (!first || !bounds) return;
    if (autoLayout && ids.length === 1 && first.type === "frame") {
      if (getProp(first.props, "layoutMode") === "none") {
        this.commit(
          [
            {
              op: "set",
              id: first.id,
              prop: "layoutMode",
              value: bounds.width >= bounds.height ? "row" : "column",
            },
            { op: "set", id: first.id, prop: "gap", value: 8 },
          ],
          "Add auto layout",
        );
      }
      return;
    }
    const parent = first.parent;
    const frameId = newId();
    const origin = this.scene.toSpace(parent, { x: bounds.x, y: bounds.y });
    const last = this.doc.get(ids.at(-1) as string);
    const siblings = this.doc.childIds(parent);
    const after = siblings[siblings.indexOf(last?.id ?? "") + 1];
    const horizontal = bounds.width >= bounds.height;
    const ops: Op[] = [
      {
        op: "create",
        id: frameId,
        type: "frame",
        parent,
        key: keyBetween(last?.key ?? null, after ? (this.doc.get(after)?.key ?? null) : null),
        props: {
          name: this.defaultName("frame"),
          x: round2(origin.x),
          y: round2(origin.y),
          width: round2(bounds.width),
          height: round2(bounds.height),
          ...(autoLayout
            ? { layoutMode: horizontal ? "row" : "column", gap: 8, sizingH: "hug", sizingV: "hug" }
            : {}),
        },
      },
    ];
    // Order children along the main axis for auto layout, keep z-order otherwise.
    const sorted = autoLayout
      ? [...ids].sort((a, b) => {
          const ba = this.scene.bounds(a);
          const bb = this.scene.bounds(b);
          return horizontal ? (ba?.x ?? 0) - (bb?.x ?? 0) : (ba?.y ?? 0) - (bb?.y ?? 0);
        })
      : ids;
    const keys = keysBetween(null, null, sorted.length);
    // The frame doesn't exist yet when reparentOps reads the scene, so compute
    // positions relative to its origin directly.
    sorted.forEach((id, i) => {
      ops.push({ op: "move", id, parent: frameId, key: keys[i] as string });
      const node = this.doc.get(id);
      if (!node) return;
      const shift = (n: NodeRecord) => {
        if (n.type === "group") {
          for (const c of this.doc.childIds(n.id)) {
            const child = this.doc.get(c);
            if (child) shift(child);
          }
          return;
        }
        ops.push(
          { op: "set", id: n.id, prop: "x", value: round2(getProp(n.props, "x") - origin.x) },
          { op: "set", id: n.id, prop: "y", value: round2(getProp(n.props, "y") - origin.y) },
        );
      };
      shift(node);
    });
    if (this.commit(ops, autoLayout ? "Add auto layout" : "Frame selection"))
      this.select([frameId]);
  }

  /** True (and tells the user) when the selection reaches inside an instance. */
  #refuseInsideInstance(): boolean {
    if (this.s.selection.some((id) => isInsideInstance(this.doc, id))) {
      this.notify(
        "An instance's layers follow its main component. Detach the instance to restructure it.",
      );
      return true;
    }
    return false;
  }

  /**
   * Turns the selection into a main component (⌥⌘K). A single frame or group
   * becomes the component; anything else is wrapped in a new frame first.
   */
  createComponent(): void {
    if (this.#refuseInsideInstance()) return;
    const ids = this.#ordered(this.#topmost(this.s.selection));
    const only = ids.length === 1 ? this.doc.get(ids[0] as string) : undefined;
    if (only && isMainComponent(only)) {
      this.notify("That's already a main component.");
      return;
    }
    if (only?.type === "frame") {
      const ops: Op[] = [{ op: "set", id: only.id, prop: "isComponent", value: true }];
      if (getProp(only.props, "instanceOf")) ops.push(...detachOps(this.doc, only.id));
      this.commit(ops, "Create component");
      return;
    }
    if (ids.length === 0) return;
    // Wrap in a frame, then mark it. One undo step for both.
    this.beginGesture("Create component");
    this.frameSelection(false);
    const frame = this.s.selection[0];
    if (frame && this.doc.get(frame)?.type === "frame") {
      const name = only
        ? getProp(only.props, "name")
        : this.defaultName("frame").replace("Frame", "Component");
      this.commit(
        [
          { op: "set", id: frame, prop: "isComponent", value: true },
          { op: "set", id: frame, prop: "name", value: name || "Component" },
          { op: "set", id: frame, prop: "fills", value: null },
        ],
        "Create component",
      );
    }
    this.endGesture();
  }

  /**
   * Places an instance of a main component. With a page point it lands there;
   * otherwise in the insertion parent, centred in the viewport.
   */
  insertInstance(componentId: string, at?: { x: number; y: number }): string | null {
    const main = this.doc.get(componentId);
    if (!isMainComponent(main) || !main) return null;
    const pageId = this.s.pageId;
    if (!pageId) return null;
    const { camera, viewport } = this.s;
    const centre = at ?? camera.toPage({ x: viewport.width / 2, y: viewport.height / 2 });
    const parent = at ? (this.dropTarget(centre) ?? pageId) : (this.insertionParent() ?? pageId);
    if (wouldCycle(this.doc, componentId, parent)) {
      this.notify("A component can't contain an instance of itself.");
      return null;
    }
    const w = getProp(main.props, "width");
    const h = getProp(main.props, "height");
    const origin = this.scene.toSpace(parent, { x: centre.x - w / 2, y: centre.y - h / 2 });
    const made = instantiateOps(this.doc, componentId, parent, this.topKey(parent), {
      x: round2(origin.x),
      y: round2(origin.y),
    });
    if (!made) return null;
    if (!this.commit(made.ops, "Insert instance")) return null;
    this.select([made.rootId]);
    return made.rootId;
  }

  /** Selects an instance's main component, switching page if needed (⌥⌘G on an instance). */
  goToMainComponent(id = this.s.selection[0]): void {
    const root = id ? instanceRootOf(this.doc, id) : undefined;
    const mainId = root ? getProp(root.props, "instanceOf") : null;
    const main = mainId ? this.doc.get(mainId) : undefined;
    if (!main) {
      this.notify("The main component was deleted. Detach the instance to keep it as a frame.");
      return;
    }
    const page = this.doc.pageOf(main.id);
    if (page && page.id !== this.s.pageId) this.setPage(page.id);
    this.select([main.id]);
    this.revealSelection();
  }

  /** Clears every change made to the selected instances, so they match their main again. */
  resetInstances(): void {
    const ops: Op[] = [];
    for (const id of this.s.selection) {
      const root = instanceRootOf(this.doc, id);
      if (root) ops.push(...resetOverridesOps(this.doc, root.id));
    }
    if (ops.length === 0) {
      this.notify("These instances already match their main component.");
      return;
    }
    // Clearing overrides, then syncing, as one undo step.
    this.beginGesture("Reset instance");
    this.commit(ops, "Reset instance");
    const roots = new Set(
      this.s.selection
        .map((id) => instanceRootOf(this.doc, id)?.id)
        .filter((id): id is string => !!id),
    );
    const sync = [...roots].flatMap((id) => syncInstanceOps(this.doc, id));
    if (sync.length > 0) this.commit(sync, "Reset instance", { overrides: false });
    this.endGesture();
  }

  /** Turns the selected instances into plain frames (⌥⌘B). */
  detachInstances(): void {
    const ops: Op[] = [];
    for (const id of this.s.selection) {
      const node = this.doc.get(id);
      if (node && getProp(node.props, "instanceOf") !== null && node.type === "frame")
        ops.push(...detachOps(this.doc, id));
    }
    if (ops.length > 0) this.commit(ops, "Detach instance");
  }

  // -------------------------------------------------------------------------
  // Variants

  /**
   * Wraps the selected main components in a component set, one variant each,
   * named "Property 1=…" from their layer names (⌥⌘V once components exist).
   */
  combineAsVariants(): void {
    const ids = this.#ordered(this.#topmost(this.s.selection));
    const nodes = ids.map((id) => this.doc.get(id)).filter((n): n is NodeRecord => !!n);
    if (nodes.length === 0 || !nodes.every((n) => isMainComponent(n))) {
      this.notify("Select one or more main components to combine them as variants.");
      return;
    }
    if (nodes.some((n) => componentSetOf(this.doc, n.id))) {
      this.notify("Some of these are already variants of a set.");
      return;
    }
    const names = nodes.map((n) => getProp(n.props, "name") || "Variant");
    const setName = commonPrefix(names) || names[0] || "Component";
    this.beginGesture("Combine as variants");
    this.state.set({ selection: ids });
    // Always wrap (frameSelection(true) would add auto layout to a lone frame instead).
    this.frameSelection(false);
    const setId = this.s.selection[0];
    if (setId && setId !== ids[0] && this.doc.get(setId)?.type === "frame") {
      const ops: Op[] = [
        { op: "set", id: setId, prop: "isComponentSet", value: true },
        { op: "set", id: setId, prop: "layoutMode", value: "row" },
        { op: "set", id: setId, prop: "sizingH", value: "hug" },
        { op: "set", id: setId, prop: "sizingV", value: "hug" },
        { op: "set", id: setId, prop: "fills", value: null },
        { op: "set", id: setId, prop: "name", value: setName },
        { op: "set", id: setId, prop: "layoutWrap", value: true },
        { op: "set", id: setId, prop: "gap", value: 16 },
        { op: "set", id: setId, prop: "rowGap", value: 16 },
        { op: "set", id: setId, prop: "paddingTop", value: 16 },
        { op: "set", id: setId, prop: "paddingRight", value: 16 },
        { op: "set", id: setId, prop: "paddingBottom", value: 16 },
        { op: "set", id: setId, prop: "paddingLeft", value: 16 },
      ];
      nodes.forEach((node, i) => {
        const value =
          (names[i] as string).slice(setName.length).replace(/^[\s/·,-]+/, "") ||
          (i === 0 ? "Default" : `Variant ${i + 1}`);
        ops.push(
          { op: "set", id: node.id, prop: "variantProps", value: { "Property 1": value } },
          { op: "set", id: node.id, prop: "name", value: `Property 1=${value}` },
        );
      });
      this.commit(ops, "Combine as variants");
    }
    this.endGesture();
  }

  /** Adds a copy of a variant to its set, with a new value for its last property. */
  addVariant(variantId: string): string | null {
    const set = componentSetOf(this.doc, variantId);
    const variant = this.doc.get(variantId);
    if (!set || !variant) return null;
    const props = { ...getProp(variant.props, "variantProps") };
    const names = Object.keys(props);
    const last = names.at(-1) ?? "Property 1";
    const used = new Set(
      variantProperties(this.doc, set.id).find((p) => p.name === last)?.values ?? [],
    );
    let n = used.size + 1;
    while (used.has(`Variant ${n}`)) n++;
    props[last] = `Variant ${n}`;
    const siblings = this.doc.childIds(set.id);
    const next = siblings[siblings.indexOf(variantId) + 1];
    const key = keyBetween(variant.key, next ? (this.doc.get(next)?.key ?? null) : null);
    const { ops, rootId } = this.cloneOps(variantId, set.id, key);
    const root = ops[0];
    if (root?.op === "create") {
      (root.props as Record<string, unknown>).variantProps = props;
      (root.props as Record<string, unknown>).name = formatVariantName(props);
    }
    if (!this.commit(ops, "Add variant")) return null;
    this.select([rootId]);
    return rootId;
  }

  /** Sets one property value on a variant (and keeps its layer name in step). */
  setVariantProp(variantId: string, name: string, value: string): void {
    const variant = this.doc.get(variantId);
    if (!variant || !componentSetOf(this.doc, variantId)) return;
    const props = { ...getProp(variant.props, "variantProps"), [name]: value.trim() || "Default" };
    this.commit(
      [
        { op: "set", id: variantId, prop: "variantProps", value: props },
        { op: "set", id: variantId, prop: "name", value: formatVariantName(props) },
      ],
      "Change variant",
    );
  }

  /** Renames a variant property across every variant in a set. */
  renameVariantProperty(setId: string, from: string, to: string): void {
    const name = to.trim();
    if (!name || name === from) return;
    const ops: Op[] = [];
    for (const variant of variantsOf(this.doc, setId)) {
      const props = getProp(variant.props, "variantProps");
      if (!(from in props)) continue;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) next[k === from ? name : k] = v;
      ops.push(
        { op: "set", id: variant.id, prop: "variantProps", value: next },
        { op: "set", id: variant.id, prop: "name", value: formatVariantName(next) },
      );
    }
    if (ops.length > 0) this.commit(ops, "Rename property");
  }

  /** Adds a property to every variant in a set, with `value` as everyone's starting value. */
  addVariantProperty(setId: string, value = "Default"): void {
    const existing = new Set(variantProperties(this.doc, setId).map((p) => p.name));
    let n = existing.size + 1;
    while (existing.has(`Property ${n}`)) n++;
    const name = `Property ${n}`;
    const ops: Op[] = [];
    for (const variant of variantsOf(this.doc, setId)) {
      const next = { ...getProp(variant.props, "variantProps"), [name]: value };
      ops.push(
        { op: "set", id: variant.id, prop: "variantProps", value: next },
        { op: "set", id: variant.id, prop: "name", value: formatVariantName(next) },
      );
    }
    if (ops.length > 0) this.commit(ops, "Add property");
  }

  /**
   * Switches an instance to the variant of its set that matches its current
   * properties with `name` set to `value`. Overrides carry over by layer name.
   */
  setInstanceVariant(instanceId: string, name: string, value: string): void {
    const instance = this.doc.get(instanceId);
    const mainId = instance ? getProp(instance.props, "instanceOf") : null;
    const set = mainId ? componentSetOf(this.doc, mainId) : undefined;
    const main = mainId ? this.doc.get(mainId) : undefined;
    if (!instance || !set || !main) return;
    const wanted = { ...getProp(main.props, "variantProps"), [name]: value };
    const target = findVariant(this.doc, set.id, wanted);
    if (!target || target.id === mainId) return;
    this.swapInstance(instanceId, target.id);
  }

  /** Replaces an instance's main component, keeping matching overrides (one undo step). */
  swapInstance(instanceId: string, componentId: string): void {
    const ops = swapInstanceOps(this.doc, instanceId, componentId);
    if (ops.length === 0) return;
    this.beginGesture("Swap instance");
    // The swap carries the person's overrides as-is; it records none of its own.
    this.commit(ops, "Swap instance", { overrides: false });
    const sync = syncInstanceOps(this.doc, instanceId);
    if (sync.length > 0) this.commit(sync, "Swap instance", { overrides: false });
    this.endGesture();
  }

  /** Clears one property override on one layer inside an instance, so it follows its main again. */
  resetOverride(id: string, prop: string): void {
    const node = this.doc.get(id);
    const root = node ? instanceRootOf(this.doc, id) : undefined;
    if (!node || !root) return;
    const remaining = getProp(node.props, "overrides").filter((p) => p !== prop);
    this.beginGesture("Reset override");
    this.commit(
      [{ op: "set", id, prop: "overrides", value: remaining.length > 0 ? remaining : null }],
      "Reset override",
    );
    const sync = syncInstanceOps(this.doc, root.id);
    if (sync.length > 0) this.commit(sync, "Reset override", { overrides: false });
    this.endGesture();
  }

  // -------------------------------------------------------------------------
  // Variables

  /** Creates a variable collection. Returns its id. */
  createCollection(name = "Tokens"): string | null {
    const id = newId();
    const last = this.doc.childIds(ROOT_ID).at(-1);
    const ok = this.commit(
      [
        {
          op: "create",
          id,
          type: "collection",
          parent: ROOT_ID,
          key: keyBetween(last ? (this.doc.get(last)?.key ?? null) : null, null),
          props: { name, modes: [{ id: newId(8), name: "Default" }] },
        },
      ],
      "New collection",
    );
    return ok ? id : null;
  }

  /** Adds a variable to a collection, with `value` in every mode. Returns its id. */
  createVariable(
    collectionId: string,
    name: string,
    type: VariableType,
    value: VariableValue,
  ): string | null {
    const collection = this.doc.get(collectionId);
    if (collection?.type !== "collection") return null;
    const modes = getProp(collection.props, "modes");
    const id = newId();
    const ok = this.commit(
      [
        {
          op: "create",
          id,
          type: "variable",
          parent: collectionId,
          key: this.topKey(collectionId),
          props: {
            name,
            variableType: type,
            values: Object.fromEntries(modes.map((m) => [m.id, value])),
          },
        },
      ],
      "New variable",
    );
    return ok ? id : null;
  }

  setVariableValue(variableId: string, modeId: string, value: VariableValue): void {
    const variable = this.doc.get(variableId);
    if (variable?.type !== "variable") return;
    if (typeof value === "object" && dependsOn(this.doc, value.alias, variableId)) {
      this.notify("A variable can't refer to itself, directly or through another variable.");
      return;
    }
    const values = { ...getProp(variable.props, "values"), [modeId]: value };
    this.commit([{ op: "set", id: variableId, prop: "values", value: values }], "Change variable");
  }

  addMode(collectionId: string, name: string): string | null {
    const collection = this.doc.get(collectionId);
    if (collection?.type !== "collection") return null;
    const modes = getProp(collection.props, "modes");
    if (modes.length >= 16) {
      this.notify("A collection can have up to 16 modes.");
      return null;
    }
    const mode = { id: newId(8), name };
    const ops: Op[] = [{ op: "set", id: collectionId, prop: "modes", value: [...modes, mode] }];
    // New modes start as a copy of the first one.
    const first = modes[0]?.id;
    for (const variable of variablesIn(this.doc, collectionId)) {
      const values = getProp(variable.props, "values");
      const seed = first ? values[first] : undefined;
      if (seed !== undefined)
        ops.push({
          op: "set",
          id: variable.id,
          prop: "values",
          value: { ...values, [mode.id]: seed },
        });
    }
    return this.commit(ops, "Add mode") ? mode.id : null;
  }

  renameMode(collectionId: string, modeId: string, name: string): void {
    const collection = this.doc.get(collectionId);
    if (collection?.type !== "collection" || !name.trim()) return;
    const modes = getProp(collection.props, "modes").map((m) =>
      m.id === modeId ? { ...m, name: name.trim() } : m,
    );
    this.commit([{ op: "set", id: collectionId, prop: "modes", value: modes }], "Rename mode");
  }

  removeMode(collectionId: string, modeId: string): void {
    const collection = this.doc.get(collectionId);
    if (collection?.type !== "collection") return;
    const modes = getProp(collection.props, "modes");
    if (modes.length <= 1) {
      this.notify("A collection needs at least one mode.");
      return;
    }
    const ops: Op[] = [
      { op: "set", id: collectionId, prop: "modes", value: modes.filter((m) => m.id !== modeId) },
    ];
    for (const variable of variablesIn(this.doc, collectionId)) {
      const values = { ...getProp(variable.props, "values") };
      if (modeId in values) {
        delete values[modeId];
        ops.push({ op: "set", id: variable.id, prop: "values", value: values });
      }
    }
    this.commit(ops, "Remove mode");
  }

  /** Binds a property of the given layers to a variable; the value updates in the same step. */
  bindVariable(ids: readonly string[], key: BindingKey, variableId: string): void {
    const variable = this.doc.get(variableId);
    if (variable?.type !== "variable") return;
    if (getProp(variable.props, "variableType") !== BINDING_TARGETS[key].type) {
      this.notify(
        `That variable holds a ${getProp(variable.props, "variableType")}, not a ${BINDING_TARGETS[key].type}.`,
      );
      return;
    }
    const ops: Op[] = [];
    for (const id of ids) {
      const node = this.doc.get(id);
      if (!node || !propAllowed(node.type, BINDING_TARGETS[key].prop)) continue;
      ops.push({
        op: "set",
        id,
        prop: "bindings",
        value: { ...getProp(node.props, "bindings"), [key]: variableId },
      });
    }
    if (ops.length > 0) this.commit(ops, `Use ${getProp(variable.props, "name")}`);
  }

  /** Detaches a variable from a property, keeping its current value. */
  unbindVariable(ids: readonly string[], key: BindingKey): void {
    const ops: Op[] = [];
    for (const id of ids) {
      const node = this.doc.get(id);
      const bindings = node ? getProp(node.props, "bindings") : {};
      if (!node || !bindings[key]) continue;
      const next = { ...bindings };
      delete next[key];
      ops.push({
        op: "set",
        id,
        prop: "bindings",
        value: Object.keys(next).length > 0 ? next : null,
      });
    }
    if (ops.length > 0) this.commit(ops, "Detach variable");
  }

  /** Sets which mode of a collection applies inside a frame or page (null inherits). */
  setVariableMode(id: string, collectionId: string, modeId: string | null): void {
    const node = this.doc.get(id);
    if (!node || (node.type !== "frame" && node.type !== "page")) return;
    const next = { ...getProp(node.props, "variableModes") };
    if (modeId) next[collectionId] = modeId;
    else delete next[collectionId];
    this.commit(
      [{ op: "set", id, prop: "variableModes", value: Object.keys(next).length > 0 ? next : null }],
      "Change mode",
    );
  }

  /** Imports W3C design tokens (DTCG JSON) as a new collection. Returns its id. */
  importTokens(json: unknown, name = "Imported tokens"): string | null {
    const parsed = parseDtcg(json);
    if (parsed.tokens.length === 0) {
      this.notify("That file has no design tokens Drawpane can read. It expects W3C (DTCG) JSON.");
      return null;
    }
    const collectionId = newId();
    const modeIds = new Map(parsed.modes.map((m) => [m, newId(8)]));
    const last = this.doc.childIds(ROOT_ID).at(-1);
    const ops: Op[] = [
      {
        op: "create",
        id: collectionId,
        type: "collection",
        parent: ROOT_ID,
        key: keyBetween(last ? (this.doc.get(last)?.key ?? null) : null, null),
        props: {
          name,
          modes: parsed.modes.map((m) => ({ id: modeIds.get(m) as string, name: m })),
        },
      },
    ];
    const ids = new Map(parsed.tokens.map((t) => [t.name, newId()]));
    const keys = keysBetween(null, null, parsed.tokens.length);
    parsed.tokens.forEach((token, i) => {
      const values: Record<string, VariableValue> = {};
      for (const [mode, raw] of Object.entries(token.values)) {
        const modeId = modeIds.get(mode);
        if (!modeId) continue;
        if (typeof raw === "object") {
          const target = ids.get(raw.alias);
          if (target) values[modeId] = { alias: target };
        } else {
          values[modeId] = raw;
        }
      }
      ops.push({
        op: "create",
        id: ids.get(token.name) as string,
        type: "variable",
        parent: collectionId,
        key: keys[i] as string,
        props: {
          name: token.name,
          variableType: token.type,
          values,
          ...(token.description ? { description: token.description } : {}),
        },
      });
    });
    return this.commit(ops, "Import tokens") ? collectionId : null;
  }

  /** Selection sorted by z-order (bottom first) within the document. */
  #ordered(ids: readonly string[]): string[] {
    const order = new Map<string, number>();
    let i = 0;
    const walk = (parent: string) => {
      for (const id of this.doc.childIds(parent)) {
        order.set(id, i++);
        walk(id);
      }
    };
    walk(ROOT_ID);
    return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  /** Moves the selection up or down the stack among its siblings. */
  reorder(direction: "forward" | "backward" | "front" | "back"): void {
    const ops: Op[] = [];
    for (const id of this.#ordered(this.s.selection)) {
      const node = this.doc.get(id);
      if (!node) continue;
      const siblings = this.doc.childIds(node.parent);
      const index = siblings.indexOf(id);
      const keyOf = (i: number) =>
        i >= 0 && i < siblings.length ? (this.doc.get(siblings[i] as string)?.key ?? null) : null;
      let key: string | null = null;
      if (direction === "front" && index < siblings.length - 1)
        key = keyBetween(keyOf(siblings.length - 1), null);
      if (direction === "back" && index > 0) key = keyBetween(null, keyOf(0));
      if (direction === "forward" && index < siblings.length - 1)
        key = keyBetween(keyOf(index + 1), keyOf(index + 2));
      if (direction === "backward" && index > 0)
        key = keyBetween(keyOf(index - 2), keyOf(index - 1));
      if (key) ops.push({ op: "move", id, parent: node.parent, key });
    }
    if (ops.length > 0) this.commit(ops, "Reorder");
  }

  /** Moves selected layers by a page-space delta (arrow keys). */
  nudge(dx: number, dy: number): void {
    const ops: Op[] = [];
    for (const id of this.#topmost(this.s.selection)) {
      if (this.doc.has(id) && !this.scene.isLocked(id)) ops.push(...this.#moveOps(id, dx, dy));
    }
    if (ops.length > 0) this.commit(ops, "Nudge");
  }

  /** Aligns selected layers to each other (or to their parent when one is selected). */
  align(edge: AlignEdge): void {
    const ids = this.#topmost(this.s.selection);
    if (ids.length === 0) return;
    let target: Rect | null;
    if (ids.length === 1) {
      const parent = this.doc.get(this.doc.get(ids[0] as string)?.parent ?? "");
      target = parent && parent.type !== "page" ? this.scene.bounds(parent.id) : null;
    } else {
      target = this.scene.unionBounds(ids);
    }
    if (!target) return;
    this.beginGesture("Align");
    for (const id of ids) {
      const b = this.scene.bounds(id);
      if (!b) continue;
      let dx = 0;
      let dy = 0;
      if (edge === "left") dx = target.x - b.x;
      if (edge === "center") dx = target.x + target.width / 2 - (b.x + b.width / 2);
      if (edge === "right") dx = target.x + target.width - (b.x + b.width);
      if (edge === "top") dy = target.y - b.y;
      if (edge === "middle") dy = target.y + target.height / 2 - (b.y + b.height / 2);
      if (edge === "bottom") dy = target.y + target.height - (b.y + b.height);
      const saved = this.s.selection;
      this.state.set({ selection: [id] });
      if (dx !== 0 || dy !== 0) this.nudge(dx, dy);
      this.state.set({ selection: saved });
    }
    this.endGesture();
  }

  /**
   * Spaces three or more selected layers evenly between the outermost two,
   * along one axis (Figma's "Distribute horizontal spacing").
   */
  distribute(axis: "horizontal" | "vertical"): void {
    const ids = this.#topmost(this.s.selection).filter((id) => !this.scene.isLocked(id));
    const items = ids
      .map((id) => ({ id, b: this.scene.bounds(id) }))
      .filter((i): i is { id: string; b: Rect } => i.b !== null);
    if (items.length < 3) return;
    const h = axis === "horizontal";
    const start = (r: Rect) => (h ? r.x : r.y);
    const size = (r: Rect) => (h ? r.width : r.height);
    items.sort((a, b) => start(a.b) - start(b.b) || a.id.localeCompare(b.id));
    const first = items[0] as (typeof items)[number];
    const last = items.at(-1) as (typeof items)[number];
    const span = start(last.b) + size(last.b) - start(first.b);
    const total = items.reduce((sum, i) => sum + size(i.b), 0);
    const gap = (span - total) / (items.length - 1);
    const ops: Op[] = [];
    let at = start(first.b);
    for (const item of items) {
      const d = at - start(item.b);
      if (Math.abs(d) > 0.005) ops.push(...this.#moveOps(item.id, h ? d : 0, h ? 0 : d));
      at += size(item.b) + gap;
    }
    if (ops.length > 0) this.commit(ops, "Distribute");
  }

  /**
   * Mirrors the selection across its centre (⇧H, ⇧V): each layer's position
   * mirrors inside the selection's bounds and its box flips, so groups and
   * several layers flip as one picture.
   */
  flip(axis: "horizontal" | "vertical"): void {
    const ids = this.#topmost(this.s.selection).filter((id) => !this.scene.isLocked(id));
    const pivot = this.scene.unionBounds(ids);
    if (!pivot) return;
    const h = axis === "horizontal";
    const cx = pivot.x + pivot.width / 2;
    const cy = pivot.y + pivot.height / 2;
    const ops: Op[] = [];
    const flipNode = (node: NodeRecord) => {
      if (node.type === "group") {
        for (const c of this.doc.childIds(node.id)) {
          const child = this.doc.get(c);
          if (child) flipNode(child);
        }
        return;
      }
      if (node.type === "page") return;
      const box = boxOf(node);
      const world = this.scene.worldMatrix(node.id);
      const centre = apply(world, { x: box.width / 2, y: box.height / 2 });
      const mirrored = h
        ? { x: 2 * cx - centre.x, y: centre.y }
        : { x: centre.x, y: 2 * cy - centre.y };
      const local = this.scene.toSpace(node.parent, mirrored);
      // A mirror turns rotation the other way: S·R(θ) = R(−θ)·S, in page space.
      const parentRotation = rotationOf(this.scene.spaceMatrix(this.scene.spaceOwner(node.parent)));
      const rotation = round2(-(box.rotation + parentRotation) - parentRotation);
      const inLayout =
        getProp(this.doc.get(node.parent)?.props ?? {}, "layoutMode") !== "none" &&
        getProp(node.props, "positioning") === "auto";
      if (!inLayout) {
        ops.push(
          { op: "set", id: node.id, prop: "x", value: round2(local.x - box.width / 2) },
          { op: "set", id: node.id, prop: "y", value: round2(local.y - box.height / 2) },
        );
      }
      const flipProp = h ? "flipX" : "flipY";
      ops.push({ op: "set", id: node.id, prop: flipProp, value: !getProp(node.props, flipProp) });
      if (rotation !== round2(box.rotation))
        ops.push({ op: "set", id: node.id, prop: "rotation", value: normalizeDegrees(rotation) });
    };
    for (const id of ids) {
      const node = this.doc.get(id);
      if (node) flipNode(node);
    }
    if (ops.length > 0) this.commit(ops, h ? "Flip horizontal" : "Flip vertical");
  }

  /**
   * Shrinks or grows frames to wrap their content exactly, leaving every
   * child where it is on the canvas (Figma's "Resize to fit"). Auto layout
   * frames hug instead, so they're skipped.
   */
  fitToContent(ids: readonly string[] = this.s.selection): void {
    const ops: Op[] = [];
    for (const id of ids) {
      const frame = this.doc.get(id);
      if (frame?.type !== "frame" || getProp(frame.props, "layoutMode") !== "none") continue;
      const children = this.doc.childIds(id);
      // Children live in the frame's own space: their union is the content box there.
      const local = unionRects(
        children
          .map((c) => this.scene.bounds(c))
          .filter((b): b is Rect => b !== null)
          .map((b) => {
            const a = this.scene.toSpace(id, { x: b.x, y: b.y });
            const z = this.scene.toSpace(id, { x: b.x + b.width, y: b.y + b.height });
            return normalizeRect(a, z);
          }),
      );
      if (!local || local.width <= 0 || local.height <= 0) continue;
      const dx = round2(local.x);
      const dy = round2(local.y);
      for (const childId of children) ops.push(...this.#shiftInSpace(childId, -dx, -dy));
      const origin = apply(this.scene.worldMatrix(id), { x: local.x, y: local.y });
      const inParent = this.scene.toSpace(frame.parent, origin);
      ops.push(
        { op: "set", id, prop: "x", value: round2(inParent.x) },
        { op: "set", id, prop: "y", value: round2(inParent.y) },
        { op: "set", id, prop: "width", value: round2(local.width) },
        { op: "set", id, prop: "height", value: round2(local.height) },
      );
    }
    if (ops.length > 0) this.commit(ops, "Resize to fit", { constraints: false });
  }

  /** Moves a layer (or a group's members) by a delta in its own coordinate space. */
  #shiftInSpace(id: string, dx: number, dy: number): Op[] {
    const node = this.doc.get(id);
    if (!node) return [];
    if (node.type === "group")
      return this.doc.childIds(id).flatMap((c) => this.#shiftInSpace(c, dx, dy));
    return [
      { op: "set", id, prop: "x", value: round2(getProp(node.props, "x") + dx) },
      { op: "set", id, prop: "y", value: round2(getProp(node.props, "y") + dy) },
    ];
  }

  /** Operations that move one layer (or a group's members) by a page-space delta. */
  #moveOps(id: string, dx: number, dy: number): Op[] {
    const ops: Op[] = [];
    const move = (n: NodeRecord) => {
      if (n.type === "group") {
        for (const c of this.doc.childIds(n.id)) {
          const child = this.doc.get(c);
          if (child) move(child);
        }
        return;
      }
      const inLayout =
        getProp(this.doc.get(n.parent)?.props ?? {}, "layoutMode") !== "none" &&
        getProp(n.props, "positioning") === "auto";
      if (inLayout) return;
      const inv = invert(this.scene.spaceMatrix(this.scene.spaceOwner(n.parent)));
      const d = { x: inv[0] * dx + inv[2] * dy, y: inv[1] * dx + inv[3] * dy };
      ops.push(
        { op: "set", id: n.id, prop: "x", value: round2(getProp(n.props, "x") + d.x) },
        { op: "set", id: n.id, prop: "y", value: round2(getProp(n.props, "y") + d.y) },
      );
    };
    const node = this.doc.get(id);
    if (node) move(node);
    return ops;
  }

  // -------------------------------------------------------------------------
  // Guides and layout grids

  /**
   * Adds, moves or removes a ruler guide on a page or frame: `index` null
   * adds `guide`; `guide` null removes the guide at `index`.
   */
  setGuide(owner: string, index: number | null, guide: RulerGuide | null): boolean {
    const node = this.doc.get(owner);
    if (!node || (node.type !== "page" && node.type !== "frame")) return false;
    const next = withGuide(getProp(node.props, "rulerGuides"), index, guide);
    const label = guide === null ? "Remove guide" : index === null ? "Add guide" : "Move guide";
    return this.commit(
      [{ op: "set", id: owner, prop: "rulerGuides", value: next.length > 0 ? next : null }],
      label,
    );
  }

  /** Removes every guide on the current page and its frames. */
  clearGuides(): boolean {
    const pageId = this.s.pageId;
    if (!pageId) return false;
    const ops: Op[] = [];
    for (const id of [pageId, ...this.doc.childIds(pageId)]) {
      const node = this.doc.get(id);
      if (node && getProp(node.props, "rulerGuides").length > 0)
        ops.push({ op: "set", id, prop: "rulerGuides", value: null });
    }
    return ops.length > 0 && this.commit(ops, "Remove guides");
  }

  /** How many guides the current page and its frames have. */
  guideCount(): number {
    const pageId = this.s.pageId;
    if (!pageId) return 0;
    return [pageId, ...this.doc.childIds(pageId)].reduce(
      (n, id) => n + getProp(this.doc.get(id)?.props ?? {}, "rulerGuides").length,
      0,
    );
  }

  toggleVisible(): void {
    const ids = this.s.selection;
    const anyVisible = ids.some((id) => this.doc.get(id)?.props.visible !== false);
    this.setProp(ids, "visible", anyVisible ? false : null, anyVisible ? "Hide" : "Show");
  }

  toggleLocked(): void {
    const ids = this.s.selection;
    const anyUnlocked = ids.some((id) => this.doc.get(id)?.props.locked !== true);
    this.setProp(ids, "locked", anyUnlocked ? true : null, anyUnlocked ? "Lock" : "Unlock");
    if (anyUnlocked) this.select([]);
  }

  addPage(): void {
    const pages = this.doc.pageIds();
    const id = newId();
    const last = pages.at(-1);
    if (
      this.commit(
        [
          {
            op: "create",
            id,
            type: "page",
            parent: ROOT_ID,
            key: keyBetween(last ? (this.doc.get(last)?.key ?? null) : null, null),
            props: { name: `Page ${pages.length + 1}` },
          },
        ],
        "Add page",
      )
    ) {
      this.setPage(id);
    }
  }

  /** Copies a page and everything on it, right after it, and opens the copy. */
  duplicatePage(id: string): string | null {
    const page = this.doc.get(id);
    if (page?.type !== "page") return null;
    const siblings = this.doc.childIds(ROOT_ID);
    const next = siblings[siblings.indexOf(id) + 1];
    const key = keyBetween(page.key, next ? (this.doc.get(next)?.key ?? null) : null);
    const { ops, rootId } = this.cloneOps(id, ROOT_ID, key);
    const root = ops[0];
    if (root?.op === "create")
      (root.props as Record<string, unknown>).name =
        `${getProp(page.props, "name") || "Page"} copy`;
    if (!this.commit(ops, "Duplicate page")) return null;
    this.setPage(rootId);
    return rootId;
  }

  deletePage(id: string): void {
    if (this.doc.pageIds().length <= 1) {
      this.notify("A file needs at least one page.");
      return;
    }
    this.commit([{ op: "delete", id }], "Delete page");
  }

  // -------------------------------------------------------------------------
  // Clipboard

  /** Serializes the selection for the clipboard. */
  copy(): string | null {
    const ids = this.#ordered(this.#topmost(this.s.selection));
    if (ids.length === 0) return null;
    const nodes: NodeRecord[] = [];
    for (const id of ids) {
      const stack = [id];
      while (stack.length > 0) {
        const current = stack.shift() as string;
        const node = this.doc.get(current);
        if (!node) continue;
        if (current === id) {
          // Store roots in page coordinates so they paste in place anywhere.
          const world = this.scene.bounds(current);
          nodes.push({
            ...node,
            parent: "",
            props: {
              ...node.props,
              ...(node.type !== "group" && world ? this.#pageGeometry(node) : {}),
            },
          });
        } else {
          nodes.push(node);
        }
        stack.push(...this.doc.childIds(current));
      }
    }
    return JSON.stringify({ format: "drawpane/nodes", version: 1, nodes });
  }

  #pageGeometry(node: NodeRecord): Props {
    const world = this.scene.worldMatrix(node.id);
    const w = getProp(node.props, "width");
    const h = getProp(node.props, "height");
    const centre = apply(world, { x: w / 2, y: h / 2 });
    return {
      x: round2(centre.x - w / 2),
      y: round2(centre.y - h / 2),
      rotation: round2(rotationOf(world)),
    };
  }

  cut(): string | null {
    const data = this.copy();
    if (data) this.deleteSelection();
    return data;
  }

  /** Pastes clipboard data into the selected frame or the page. Returns false when it isn't Drawpane data. */
  /**
   * Pastes copied layers: in place, into the selected frame (or beside the
   * selection), or with `at` centred on a page point inside whatever frame is
   * there ("Paste here"). One undo step either way.
   */
  paste(text: string, options: { at?: Point } = {}): boolean {
    let data: { format?: string; nodes?: NodeRecord[] };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return false;
    }
    if (data.format !== "drawpane/nodes" || !Array.isArray(data.nodes)) return false;
    const parent = options.at ? this.dropTarget(options.at) : this.insertionParent();
    if (!parent) return false;
    const target =
      this.doc.get(parent)?.type === "frame" || this.doc.get(parent)?.type === "page"
        ? parent
        : (this.doc.get(parent)?.parent ?? parent);
    const space = this.scene.spaceMatrix(this.scene.spaceOwner(target));
    const inv = invert(space);
    const idMap = new Map<string, string>();
    for (const n of data.nodes) idMap.set(n.id, newId());
    const roots = data.nodes.filter((n) => n.parent === "");
    const keys = keysBetween(
      this.doc.get(this.doc.childIds(target).at(-1) ?? "")?.key ?? null,
      null,
      roots.length,
    );
    const ops: Op[] = [];
    let r = 0;
    // Pasting a main component that still exists in this file makes an instance
    // of it (like Figma); its copied subtree is skipped.
    const liveMains = new Set(
      roots
        .filter((n) => getProp(n.props, "isComponent") && isMainComponent(this.doc.get(n.id)))
        .map((n) => n.id),
    );
    const underLiveMain = (n: NodeRecord): boolean => {
      for (let parentId = n.parent; parentId !== ""; ) {
        if (liveMains.has(parentId)) return true;
        parentId = data.nodes?.find((m) => m.id === parentId)?.parent ?? "";
      }
      return false;
    };
    for (const n of data.nodes) {
      const isRoot = n.parent === "";
      if (!isRoot && underLiveMain(n)) continue;
      if (isRoot && liveMains.has(n.id)) {
        const p = apply(inv, { x: getProp(n.props, "x"), y: getProp(n.props, "y") });
        const made = instantiateOps(this.doc, n.id, target, keys[r++] as string, {
          x: round2(p.x),
          y: round2(p.y),
        });
        if (made) {
          ops.push(...made.ops);
          idMap.set(n.id, made.rootId);
        }
        continue;
      }
      const props: Record<string, unknown> = { ...n.props };
      if (isRoot && n.type !== "group") {
        const p = apply(inv, { x: getProp(n.props, "x"), y: getProp(n.props, "y") });
        props.x = round2(p.x);
        props.y = round2(p.y);
      }
      ops.push({
        op: "create",
        id: idMap.get(n.id) as string,
        type: n.type,
        parent: isRoot ? target : (idMap.get(n.parent) ?? target),
        key: isRoot ? (keys[r++] as string) : n.key,
        props,
      });
    }
    const created = roots.map((n) => idMap.get(n.id) as string);
    const at = options.at;
    if (!at) {
      if (this.commit(ops, "Paste")) this.select(created);
      return true;
    }
    this.beginGesture("Paste here");
    try {
      if (!this.commit(ops, "Paste here")) return true;
      const bounds = this.scene.unionBounds(created);
      if (bounds) {
        const dx = at.x - (bounds.x + bounds.width / 2);
        const dy = at.y - (bounds.y + bounds.height / 2);
        const moves = created.flatMap((id) => this.#moveOps(id, dx, dy));
        if (moves.length > 0) this.commit(moves, "Paste here");
      }
      this.select(created);
    } finally {
      this.endGesture();
    }
    return true;
  }

  /** Style properties copied by "Copy properties": how a layer looks, not where it is. */
  static readonly STYLE_PROPS: readonly PropName[] = [
    "opacity",
    "blendMode",
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "strokeCap",
    "strokeJoin",
    "strokeDashes",
    "effects",
    "cornerRadius",
    "cornerRadii",
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textAlignVertical",
    "textDecoration",
    "textCase",
    "bindings",
  ];

  #styleClipboard: { type: NodeType; props: Props } | null = null;

  /** True after "Copy properties", so "Paste properties" can say whether it will do anything. */
  get hasCopiedProperties(): boolean {
    return this.#styleClipboard !== null;
  }

  /** Remembers the first selected layer's style (⌥⌘C). */
  copyProperties(): boolean {
    const node = this.doc.get(this.s.selection[0] ?? "");
    if (!node || node.type === "page" || node.type === "group") return false;
    const props: Record<string, unknown> = {};
    for (const prop of Editor.STYLE_PROPS) {
      if (propAllowed(node.type, prop)) props[prop] = getProp(node.props, prop);
    }
    this.#styleClipboard = { type: node.type, props: props as Props };
    return true;
  }

  /**
   * Applies the copied style to every selected layer (⌥⌘V), skipping
   * properties a layer can't have (text styles on a rectangle). Bindings
   * carry over only for properties that came along.
   */
  pasteProperties(): boolean {
    const copied = this.#styleClipboard;
    if (!copied) return false;
    const ops: Op[] = [];
    for (const id of this.s.selection) {
      const node = this.doc.get(id);
      if (!node || node.type === "page" || node.type === "group") continue;
      for (const [prop, value] of Object.entries(copied.props) as Array<[PropName, unknown]>) {
        if (!propAllowed(node.type, prop)) continue;
        let next = value;
        if (prop === "bindings") {
          const bindings = value as Record<string, string>;
          next = Object.fromEntries(
            Object.entries(bindings).filter(([key]) => {
              const target = BINDING_TARGETS[key as BindingKey];
              return target && propAllowed(node.type, target.prop as PropName);
            }),
          );
        }
        const isDefault = JSON.stringify(next) === JSON.stringify(defaultOf(prop));
        const current = node.props[prop];
        if (JSON.stringify(current ?? null) === JSON.stringify(isDefault ? null : next)) continue;
        ops.push({ op: "set", id, prop, value: isDefault ? null : next });
      }
    }
    if (ops.length === 0) return false;
    // Pasted style is applied by hand: overrides are recorded, as for any edit.
    return this.commit(ops, "Paste properties");
  }

  /** Every layer under a page point, topmost and deepest first ("Select layer"). */
  layersAt(p: Point): string[] {
    const pageId = this.s.pageId;
    if (!pageId) return [];
    return hitAll(this.scene, pageId, p, 2 / this.s.camera.zoom);
  }

  /**
   * Tidy up (⌃⌥T): arranges the selection into the grid it already roughly
   * forms, every cell the size of the largest layer, with the average gap
   * between them, starting where the selection starts. A single row or
   * column just gets even spacing.
   */
  tidyUp(): void {
    const items = this.#topmost(this.s.selection)
      .filter((id) => !this.scene.isLocked(id))
      .map((id) => ({ id, b: this.scene.bounds(id) }))
      .filter((i): i is { id: string; b: Rect } => i.b !== null);
    if (items.length < 2) return;
    // Rows: layers whose vertical centres fall inside a row's span.
    const sorted = [...items].sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
    const rows: Array<typeof items> = [];
    for (const item of sorted) {
      const cy = item.b.y + item.b.height / 2;
      const row = rows.find((r) => {
        const top = Math.min(...r.map((i) => i.b.y));
        const bottom = Math.max(...r.map((i) => i.b.y + i.b.height));
        return cy >= top && cy <= bottom;
      });
      if (row) row.push(item);
      else rows.push([item]);
    }
    for (const row of rows) row.sort((a, b) => a.b.x - b.b.x);
    const columns = Math.max(...rows.map((r) => r.length));
    const cellW = Math.max(...items.map((i) => i.b.width));
    const cellH = Math.max(...items.map((i) => i.b.height));
    // The average gap people left between neighbours, never negative.
    const average = (gaps: number[]) =>
      gaps.length ? Math.max(0, Math.round(gaps.reduce((sum, g) => sum + g, 0) / gaps.length)) : 0;
    const gapX = average(
      rows.flatMap((row) =>
        row.slice(1).map((it, i) => {
          const left = (row[i] as (typeof row)[number]).b;
          return it.b.x - (left.x + left.width);
        }),
      ),
    );
    const gapY = average(
      rows.slice(1).map((row, i) => {
        const above = rows[i] as typeof row;
        return (
          Math.min(...row.map((it) => it.b.y)) -
          Math.max(...above.map((it) => it.b.y + it.b.height))
        );
      }),
    );
    const originX = Math.min(...items.map((i) => i.b.x));
    const originY = Math.min(...items.map((i) => i.b.y));
    const single = rows.length === 1 || columns === 1;
    const ops: Op[] = [];
    if (single && rows.length === 1) {
      // One row: keep each layer's own width, even gaps, tops aligned.
      let x = originX;
      for (const it of rows[0] as typeof items) {
        ops.push(...this.#moveOps(it.id, x - it.b.x, originY - it.b.y));
        x += it.b.width + gapX;
      }
    } else if (single) {
      let y = originY;
      for (const row of rows) {
        const it = row[0] as (typeof items)[number];
        ops.push(...this.#moveOps(it.id, originX - it.b.x, y - it.b.y));
        y += it.b.height + gapY;
      }
    } else {
      rows.forEach((row, r) => {
        row.forEach((it, c) => {
          const x = originX + c * (cellW + gapX);
          const y = originY + r * (cellH + gapY);
          ops.push(...this.#moveOps(it.id, x - it.b.x, y - it.b.y));
        });
      });
    }
    const real = ops.filter((op) => {
      if (op.op !== "set") return true;
      const node = this.doc.get(op.id);
      return !node || round2(getProp(node.props, op.prop as "x")) !== op.value;
    });
    if (real.length > 0) this.commit(real, "Tidy up");
  }

  // -------------------------------------------------------------------------
  // Vectors: path editing, flatten, booleans (implemented in ./vector)

  /** A path node's geometry in its local box, or null for other nodes. */
  pathOf(id: string): VectorPath | null {
    return vector.pathOf(this, id);
  }

  /** Replaces a path's geometry (given in its current local box) and re-fits its box. */
  setPath(id: string, path: VectorPath, label = "Edit path"): boolean {
    return vector.setPath(this, id, path, label);
  }

  enterVectorEdit(id: string): boolean {
    return vector.enterVectorEdit(this, id);
  }

  exitVectorEdit(): void {
    if (this.s.vectorEdit) this.state.set({ vectorEdit: null });
  }

  selectAnchors(keys: readonly string[]): void {
    vector.setAnchorSelection(this, keys);
  }

  deleteSelectedAnchors(): boolean {
    return vector.deleteSelectedAnchors(this);
  }

  /** Moves the selected anchors by a page-space delta. */
  nudgeAnchors(dx: number, dy: number): boolean {
    return vector.nudgeAnchors(this, dx, dy);
  }

  toggleAnchorSmooth(key: string): boolean {
    return vector.toggleAnchorSmooth(this, key);
  }

  /** Converts rectangles, ellipses, lines and empty frames into equivalent paths (⌘E). */
  flatten(ids?: readonly string[]): boolean {
    return vector.flatten(this, ids);
  }

  /** True when the selection holds two or more shapes a boolean can combine. */
  canBoolean(): boolean {
    return vector.canBoolean(this);
  }

  /** Combines the selected shapes into one path. Loads the geometry engine on first use. */
  booleanOp(op: BooleanOp): Promise<boolean> {
    return vector.booleanSelection(this, op);
  }

  /** The boolean engine, loaded once. A failed load is retried next time. */
  booleanEngine(): Promise<BooleanEngine> {
    if (!this.#booleanEngine) {
      this.#booleanEngine = this.#booleanLoader().catch((error: unknown) => {
        this.#booleanEngine = null;
        throw error;
      });
    }
    return this.#booleanEngine;
  }

  setBooleanEngine(loader: BooleanEngineLoader): void {
    this.#booleanLoader = loader;
    this.#booleanEngine = null;
  }

  // -------------------------------------------------------------------------
  // Text editing

  startTextEdit(id: string): void {
    if (!this.canEdit) return;
    this.state.set({ editingText: id, selection: [id], tool: "select" });
    this.beginGesture("Edit text");
  }

  updateText(id: string, characters: string): void {
    const node = this.doc.get(id);
    if (node?.type !== "text") return;
    if (getProp(node.props, "characters") === characters) return;
    this.commit([{ op: "set", id, prop: "characters", value: characters }], "Edit text");
  }

  endTextEdit(): void {
    const id = this.s.editingText;
    if (!id) return;
    this.endGesture();
    this.state.set({ editingText: null });
    const node = this.doc.get(id);
    // An empty text layer has nothing to show: remove it, like every design tool.
    if (node && getProp(node.props, "characters").trim() === "") {
      applyBestEffort((ops) => this.#commitWithFixups(ops, false), [{ op: "delete", id }]);
      this.select([]);
    }
  }
}

export { ALIGN_EDGES };
