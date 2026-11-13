/**
 * Derived scene data: world matrices and bounds for every node, cached per
 * document version. Everything here is recomputed lazily and only for nodes
 * that are asked about.
 */
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import type { Doc } from "./doc";
import {
  apply,
  boundsOfPoints,
  boxOf,
  IDENTITY,
  invert,
  localMatrix,
  type Matrix,
  multiply,
  type Point,
  type Rect,
  rectCorners,
  unionRects,
} from "./geometry";

export class Scene {
  readonly #doc: Doc;
  #version = -1;
  readonly #matrices = new Map<string, Matrix>();
  readonly #bounds = new Map<string, Rect | null>();

  constructor(doc: Doc) {
    this.#doc = doc;
  }

  get doc(): Doc {
    return this.#doc;
  }

  #sync(): void {
    if (this.#version === this.#doc.version) return;
    this.#version = this.#doc.version;
    this.#matrices.clear();
    this.#bounds.clear();
  }

  /** Matrix from a node's local box to page coordinates. Groups and pages return their space's matrix. */
  worldMatrix(id: string): Matrix {
    this.#sync();
    const cached = this.#matrices.get(id);
    if (cached) return cached;
    const node = this.#doc.get(id);
    let m: Matrix = IDENTITY;
    if (node && node.type !== "page") {
      const parentSpace = this.spaceMatrix(node.parent);
      m = node.type === "group" ? parentSpace : multiply(parentSpace, localMatrix(boxOf(node)));
    }
    this.#matrices.set(id, m);
    return m;
  }

  /** Matrix of the coordinate space that children of `id` live in. */
  spaceMatrix(id: string): Matrix {
    if (id === ROOT_ID) return IDENTITY;
    return this.worldMatrix(id);
  }

  /** The id whose coordinate space `id`'s children use: the nearest frame or page at or above it. */
  spaceOwner(id: string): string {
    let node = this.#doc.get(id);
    while (node && node.type === "group") node = this.#doc.get(node.parent);
    return node?.id ?? ROOT_ID;
  }

  /** The four corners of a node's box in page coordinates (rotation included). */
  corners(id: string): Point[] | null {
    const node = this.#doc.get(id);
    if (!node || node.type === "page") return null;
    if (node.type === "group") {
      const b = this.bounds(id);
      return b ? rectCorners(b) : null;
    }
    const box = boxOf(node);
    const m = this.worldMatrix(id);
    return rectCorners({ x: 0, y: 0, width: box.width, height: box.height }).map((p) =>
      apply(m, p),
    );
  }

  /** Axis-aligned bounds in page coordinates. A group's bounds wrap its visible children. */
  bounds(id: string): Rect | null {
    this.#sync();
    if (this.#bounds.has(id)) return this.#bounds.get(id) ?? null;
    const node = this.#doc.get(id);
    let result: Rect | null = null;
    if (node?.type === "group") {
      result = unionRects(
        this.#doc
          .childIds(id)
          .map((child) => this.bounds(child))
          .filter((r): r is Rect => r !== null),
      );
    } else if (node && node.type !== "page") {
      const corners = this.corners(id);
      result = corners ? boundsOfPoints(corners) : null;
    }
    this.#bounds.set(id, result);
    return result;
  }

  /** Bounds of several nodes together. */
  unionBounds(ids: Iterable<string>): Rect | null {
    const rects: Rect[] = [];
    for (const id of ids) {
      const b = this.bounds(id);
      if (b) rects.push(b);
    }
    return unionRects(rects);
  }

  /** Converts a page point into a node's local box coordinates. */
  toLocal(id: string, p: Point): Point {
    return apply(invert(this.worldMatrix(id)), p);
  }

  /** Converts a page point into the coordinate space children of `parent` use. */
  toSpace(parent: string, p: Point): Point {
    return apply(invert(this.spaceMatrix(this.spaceOwner(parent))), p);
  }

  /** True when the node and all its ancestors are visible. */
  isVisible(id: string): boolean {
    for (
      let node: NodeRecord | undefined = this.#doc.get(id);
      node;
      node = this.#doc.get(node.parent)
    ) {
      if (node.props.visible === false) return false;
      if (node.type === "page") return true;
    }
    return true;
  }

  /** True when the node or any ancestor is locked. */
  isLocked(id: string): boolean {
    for (
      let node: NodeRecord | undefined = this.#doc.get(id);
      node;
      node = this.#doc.get(node.parent)
    ) {
      if (node.props.locked === true) return true;
      if (node.type === "page") return false;
    }
    return false;
  }
}
