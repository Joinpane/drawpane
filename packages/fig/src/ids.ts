/**
 * REST ids for the scene graph's layers. A layer saved in the file keeps
 * its record's guid ("12:34"). A layer an instance builds from its component
 * (a .fig saves instances without their layers) gets the id REST gives it,
 * `I<instance>;<layer it copies>`, nesting for instances in instances, so
 * the converter's `mirroredId` finds the component's own layer it copies.
 * What an instance put in a slot is named as REST names it, usually under
 * the slot: `I<instance>;<slot>;<content layer>` (see slots.ts).
 */
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";
import type { RawRecord } from "./raw";
import { type ChildIndex, pathNames, slotContent, slotProperty } from "./slots";

const core = (id: string) => (id.startsWith("I") ? id.slice(1) : id);

/** The saved records, for what slots hold: by guid, and their children by position. */
export interface SavedRecords {
  readonly records: ReadonlyMap<string, RawRecord>;
  readonly children: ChildIndex;
}

export class RestIds {
  readonly #graph: SceneGraph;
  readonly #saved: SavedRecords | null;
  /** Graph id → record guid, for every layer that is a record. */
  readonly #record = new Map<string, string>();
  /** Graph id of a layer inside an instance → graph id of the component layer it copies. */
  readonly #copies = new Map<string, string>();
  readonly #ids = new Map<string, string>();
  readonly #sources = new Map<string, string | null>();
  /** Graph id → the saved record its children are read from, for slots and slot content. */
  readonly #content = new Map<string, string | null>();
  /** Graph ids of slots whose content is named under them (see slots.ts). */
  readonly #slotScopes = new Set<string>();

  constructor(
    graph: SceneGraph,
    records: ReadonlyMap<string, string>,
    saved: SavedRecords | null = null,
  ) {
    this.#graph = graph;
    this.#saved = saved;
    for (const [guid, graphId] of records) this.#record.set(graphId, guid);
    // Each instance lists the layers it built with the component layer each one copies.
    for (const node of graph.getAllNodes())
      if (node.type === "INSTANCE")
        for (const [layer, fields] of node.instanceOverrides.descendants) {
          const source = fields.get("sourceComponentId");
          if (typeof source === "string" && !this.#copies.has(layer))
            this.#copies.set(layer, source);
        }
  }

  /** The record a layer is, or the guid of the component layer it copies (null when unknown). */
  sourceGuid(node: SceneNode): string | null {
    const known = this.#sources.get(node.id);
    if (known !== undefined) return known;
    const guid = this.#record.get(node.id) ?? this.#copiedGuid(node);
    this.#sources.set(node.id, guid);
    return guid;
  }

  /**
   * A field as Figma saved it for a layer: from the outermost instance
   * override that names the layer, else from the record it is or copies.
   * Open Pencil keeps some fields only in its own units (letter spacing in
   * pixels), so what Figma meant is read here.
   */
  savedField(node: SceneNode, field: string): unknown {
    const records = this.#saved?.records;
    if (!records) return undefined;
    const guid = this.sourceGuid(node);
    const own = guid ? records.get(guid) : undefined;
    if (!own) return undefined;
    const read = (fields: object) => (fields as Record<string, unknown>)[field];
    if (this.#record.has(node.id)) return read(own);
    // The instances around the layer, outermost first, and the record it copies last.
    const chain: RawRecord[] = [own];
    for (let at = this.#instanceAbove(node); at; at = this.#instanceAbove(at)) {
      const g = this.sourceGuid(at);
      const record = g ? records.get(g) : undefined;
      if (!record) break;
      chain.unshift(record);
    }
    for (let i = 0; i < chain.length - 1; i++) {
      const below = chain.slice(i + 1);
      for (const o of (chain[i] as RawRecord).symbolData?.symbolOverrides ?? []) {
        if (!pathNames(o.guidPath?.guids, below)) continue;
        const value = read(o);
        if (value !== undefined) return value;
      }
    }
    return read(own);
  }

  /** The graph id of the layer `node` copies, when it's inside an instance. */
  copiedLayer(node: SceneNode): string | null {
    if (this.#record.has(node.id)) return null;
    const listed = this.#copies.get(node.id);
    if (listed) return listed;
    // A copied layer that isn't an instance names the layer it copies itself.
    return node.type !== "INSTANCE" ? node.componentId : null;
  }

  #copiedGuid(node: SceneNode): string | null {
    const parent = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
    // In a slot an instance filled, the layer is the content's record at the same position.
    const content = parent ? this.#contentOf(parent) : null;
    if (content) {
      const guid = this.#contentAt(content, node);
      if (guid) return guid;
    }
    const listed = this.#copies.get(node.id);
    if (listed) {
      if (this.#record.has(listed)) return this.#record.get(listed) as string;
      // The layer it copies is a copy itself (in a main's own nested instance): its source.
      const copied = this.#graph.getNode(listed);
      const guid = copied ? this.sourceGuid(copied) : null;
      if (guid) return guid;
    }
    const guid =
      node.type !== "INSTANCE" && node.componentId ? this.#record.get(node.componentId) : undefined;
    if (guid) return guid;
    // Otherwise the copied layer is the sibling at the same saved position under the layer
    // the parent copies (or, under the instance itself, under its main component).
    if (!parent) return null;
    const parentSource = parent.type === "INSTANCE" ? parent.componentId : this.copiedLayer(parent);
    const under = parentSource ? this.#graph.getNode(parentSource) : undefined;
    for (const id of under?.childIds ?? []) {
      const sibling = this.#graph.getNode(id);
      if (sibling && sibling.source.orderKey === node.source.orderKey)
        return this.#record.get(sibling.id) ?? null;
    }
    return null;
  }

  /** The saved child of `content` at the node's position, if it has one. */
  #contentAt(content: string, node: SceneNode): string | null {
    const position = node.source.orderKey;
    return (position && this.#saved?.children.get(content)?.get(position)) ?? null;
  }

  /**
   * The saved record a layer's children come from when they're slot content: for a slot in
   * an instance, the content frame the instance assigned it; for a layer of slot content (not
   * an instance), its own record. Null for anything else.
   */
  #contentOf(node: SceneNode): string | null {
    const known = this.#content.get(node.id);
    if (known !== undefined) return known;
    let content: string | null = null;
    if (this.#saved && !this.#record.has(node.id) && node.type !== "INSTANCE") {
      const parent = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
      const parentContent = parent ? this.#contentOf(parent) : null;
      if (parentContent) content = this.#contentAt(parentContent, node);
      else {
        const guid = this.sourceGuid(node);
        const property = slotProperty(guid ? this.#saved.records.get(guid) : undefined);
        const assigned = property ? this.#assigned(node, property) : null;
        if (assigned) {
          content = assigned.content;
          // Content a saved instance assigned is named under the slot; a copy's, without it.
          if (this.#record.has(assigned.by.id) || this.#isContent(assigned.by))
            this.#slotScopes.add(node.id);
        }
      }
    }
    this.#content.set(node.id, content);
    return content;
  }

  /**
   * The content frame assigned to a slot's property by the instances around the slot, and
   * the instance that assigned it.
   */
  #assigned(
    slot: SceneNode,
    property: string,
  ): { readonly content: string; readonly by: SceneNode } | null {
    const saved = this.#saved;
    if (!saved) return null;
    // The instances around the slot, outermost first, and the records they are or copy.
    const nodes: SceneNode[] = [];
    const records: RawRecord[] = [];
    for (let at = this.#instanceAbove(slot); at; at = this.#instanceAbove(at)) {
      const guid = this.sourceGuid(at);
      const record = guid ? saved.records.get(guid) : undefined;
      if (!record) break;
      nodes.unshift(at);
      records.unshift(record);
    }
    const assigned = records.length > 0 ? slotContent(property, records) : null;
    const by = assigned ? nodes[assigned.by] : undefined;
    return assigned && by && saved.children.has(assigned.content)
      ? { content: assigned.content, by }
      : null;
  }

  /** Whether a layer is slot content: its parent's children come from a saved content frame. */
  #isContent(node: SceneNode): boolean {
    const parent = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
    return !!parent && this.#contentOf(parent) !== null;
  }

  /** The nearest instance above `node`, or null. */
  #instanceAbove(node: SceneNode): SceneNode | null {
    let at = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
    while (at && at.type !== "INSTANCE")
      at = at.parentId ? this.#graph.getNode(at.parentId) : undefined;
    return at ?? null;
  }

  /** What a layer's id is named under: the nearest instance, or slot naming its content, above it. */
  #scopeAbove(node: SceneNode): SceneNode | null {
    let at = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
    while (at && at.type !== "INSTANCE") {
      // Asking for the slot's content first is what tells whether it names it.
      if (this.#contentOf(at) && this.#slotScopes.has(at.id)) return at;
      at = at.parentId ? this.#graph.getNode(at.parentId) : undefined;
    }
    return at ?? null;
  }

  /** The layer's REST id. */
  of(node: SceneNode): string {
    const known = this.#ids.get(node.id);
    if (known) return known;
    let id = this.#record.get(node.id);
    if (!id) {
      const scope = this.#scopeAbove(node);
      // A layer with no known source still gets a stable, unique id from its graph id.
      const copied = this.sourceGuid(node) ?? `x${node.id}`;
      id = scope ? `I${core(this.of(scope))};${copied}` : copied;
    }
    this.#ids.set(node.id, id);
    return id;
  }
}

/** What Open Pencil keeps of a component it built: the occurrence tree and the layer each became. */
interface BuiltComponent {
  readonly occurrence: Occurrence;
  readonly materialized: {
    readonly root: { readonly id: string };
    readonly nodes: ReadonlyMap<Occurrence, { readonly id: string }>;
  };
}
interface Occurrence {
  readonly sourceId: string;
  readonly mainComponentId: string | null;
  readonly children: readonly Occurrence[];
}

/**
 * The layer each record became, by record guid: layers saved in the file,
 * and the layers of components (which Open Pencil builds as occurrences of
 * their records) down to the instances they nest, whose contents aren't
 * records. As Open Pencil's `figCheckpointRecords` works it out for a
 * document session.
 */
export function recordLayers(state: {
  readonly sources: ReadonlyMap<string, string>;
  readonly components: ReadonlyMap<string, BuiltComponent>;
}): Map<string, string> {
  const records = new Map(state.sources);
  for (const [componentId, component] of state.components) {
    records.set(componentId, component.materialized.root.id);
    const visit = (occurrence: Occurrence, top: boolean) => {
      const node = component.materialized.nodes.get(occurrence);
      if (!top && node) records.set(occurrence.sourceId, node.id);
      // An instance's contents are its component's layers, not records of their own.
      if (!top && occurrence.mainComponentId !== null) return;
      for (const child of occurrence.children) visit(child, false);
    };
    visit(component.occurrence, true);
  }
  return records;
}
