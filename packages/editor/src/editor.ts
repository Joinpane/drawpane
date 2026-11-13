/**
 * The editor: one object that owns the document, sync, history, scene and UI
 * state, and exposes every editing command. The React shell renders from it;
 * the command bar, shortcuts, menus and agents all call the same methods.
 */

import type { Peer } from "@drawpane/model";
import {
  getProp,
  keyBetween,
  keysBetween,
  type LayerType,
  type NodeRecord,
  newId,
  type Op,
  type PropName,
  type Props,
  ROOT_ID,
} from "@drawpane/model";
import { Camera } from "./camera";
import { Doc } from "./doc";
import { apply, invert, multiply, type Rect, rotationOf, round2 } from "./geometry";
import { applyBestEffort, History } from "./history";
import { layoutOps } from "./layout";
import { Scene } from "./scene";
import type { Guide } from "./snap";
import { Store } from "./store";
import { type ConnectionStatus, SyncEngine } from "./sync";
import { autoSize, type TextMeasurer } from "./text";

export type ToolId =
  | "select"
  | "hand"
  | "frame"
  | "rect"
  | "ellipse"
  | "line"
  | "text"
  /** Drops comment pins. The web app handles its clicks; the canvas interaction ignores them. */
  | "comment";

export interface EditorState {
  readonly pageId: string | null;
  readonly selection: readonly string[];
  readonly hover: string | null;
  readonly tool: ToolId;
  readonly camera: Camera;
  readonly viewport: { readonly width: number; readonly height: number };
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
  /** Last message worth telling the user (a rejected edit, a desync). */
  readonly notice: { readonly id: number; readonly text: string } | null;
}

export interface EditorOptions {
  readonly clientId?: string;
  readonly measurer: TextMeasurer;
}

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
  });
  #noticeId = 0;
  readonly #cameras = new Map<string, Camera>();

  constructor(options: EditorOptions) {
    this.measurer = options.measurer;
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
  }

  get s(): EditorState {
    return this.state.get();
  }

  get canEdit(): boolean {
    return this.s.role !== "viewer";
  }

  notify(text: string): void {
    this.state.set({ notice: { id: ++this.#noticeId, text } });
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
  commit(ops: readonly Op[], label = "Edit"): boolean {
    if (!this.canEdit || ops.length === 0) return false;
    let inverse: Op[];
    try {
      inverse = this.#commitWithFixups(ops);
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

  #commitWithFixups(ops: readonly Op[]): Op[] {
    return this.doc.batch(() => {
      let inverse = this.sync.commit(ops);
      const touched = new Set<string>();
      for (const op of ops) {
        touched.add(op.id);
        if (op.op === "move" || op.op === "create") touched.add(op.parent);
      }
      // Removed nodes leave a gap in their old parent's layout.
      for (const op of inverse) if (op.op === "create" || op.op === "move") touched.add(op.parent);
      const textOps = this.#textFixups(touched);
      if (textOps.length > 0) inverse = [...this.sync.commit(textOps), ...inverse];
      const live = [...touched].filter((id) => this.doc.has(id));
      const layout = layoutOps(this.doc, live);
      if (layout.length > 0) inverse = [...this.sync.commit(layout), ...inverse];
      return inverse;
    });
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
    const selection = this.history.undo((ops) => this.#commitWithFixups(ops), this.s.selection);
    if (selection) this.select(selection.filter((id) => this.doc.has(id)));
  }

  redo(): void {
    if (!this.canEdit) return;
    const selection = this.history.redo((ops) => this.#commitWithFixups(ops), this.s.selection);
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
    const { camera, viewport } = this.s;
    this.setCamera(camera.zoomAt({ x: viewport.width / 2, y: viewport.height / 2 }, zoom));
  }

  zoomToFit(): void {
    const { pageId, viewport } = this.s;
    if (!pageId) return;
    const bounds = this.scene.unionBounds(this.doc.childIds(pageId));
    if (bounds) this.setCamera(this.s.camera.fit(bounds, viewport, 80, 1));
  }

  zoomToSelection(): void {
    const bounds = this.scene.unionBounds(this.s.selection);
    if (bounds) this.setCamera(this.s.camera.fit(bounds, this.s.viewport, 80, 8));
  }

  /** Where new layers go: inside the selected frame, else beside the selection, else on the page. */
  insertionParent(): string | null {
    const { selection, pageId } = this.s;
    const first = selection.length === 1 ? this.doc.get(selection[0] as string) : undefined;
    if (first?.type === "frame") return first.id;
    if (first) return first.parent;
    return pageId;
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
        if (node.type !== "frame") continue;
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
        return { fills: [{ type: "solid", color: "#d9d9d6" }] };
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

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.setProp([id], "name", trimmed, "Rename");
  }

  deleteSelection(): void {
    const ids = this.#topmost(this.s.selection);
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
      if (isRoot && node.type !== "group") {
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
   * its geometry converts into the new coordinate space.
   */
  reparentOps(id: string, parent: string, key: string): Op[] {
    const node = this.doc.get(id);
    if (!node) return [];
    const ops: Op[] = [{ op: "move", id, parent, key }];
    const fromSpace = this.scene.spaceMatrix(this.scene.spaceOwner(node.parent));
    const toSpace = this.scene.spaceMatrix(this.scene.spaceOwner(parent));
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

  group(): void {
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
        props: { name: this.defaultName("group") },
      },
    ];
    const keys = keysBetween(null, null, ids.length);
    for (const [i, id] of ids.entries())
      ops.push(...this.reparentOps(id, groupId, keys[i] as string));
    if (this.commit(ops, "Group")) this.select([groupId]);
  }

  ungroup(): void {
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
      // Convert the page delta into the node's parent space (frames may be rotated).
      const space = this.scene.spaceMatrix(this.scene.spaceOwner(n.parent));
      const inv = invert(space);
      const d = { x: inv[0] * dx + inv[2] * dy, y: inv[1] * dx + inv[3] * dy };
      ops.push(
        { op: "set", id: n.id, prop: "x", value: round2(getProp(n.props, "x") + d.x) },
        { op: "set", id: n.id, prop: "y", value: round2(getProp(n.props, "y") + d.y) },
      );
    };
    for (const id of this.#topmost(this.s.selection)) {
      const node = this.doc.get(id);
      if (node && !this.scene.isLocked(id)) move(node);
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
  paste(text: string): boolean {
    let data: { format?: string; nodes?: NodeRecord[] };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return false;
    }
    if (data.format !== "drawpane/nodes" || !Array.isArray(data.nodes)) return false;
    const parent = this.insertionParent();
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
    for (const n of data.nodes) {
      const isRoot = n.parent === "";
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
    if (this.commit(ops, "Paste")) this.select(created);
    return true;
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
      applyBestEffort((ops) => this.#commitWithFixups(ops), [{ op: "delete", id }]);
      this.select([]);
    }
  }
}

export { ALIGN_EDGES };
