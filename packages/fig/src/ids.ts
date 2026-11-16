/**
 * REST ids for the scene graph's layers. A layer saved in the file keeps
 * its record's guid ("12:34"). A layer an instance builds from its component
 * (a .fig saves instances without their layers) gets the id REST gives it,
 * `I<instance>;<layer it copies>`, nesting for instances in instances, so
 * the converter's `mirroredId` finds the component's own layer it copies.
 */
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";

const core = (id: string) => (id.startsWith("I") ? id.slice(1) : id);

export class RestIds {
  readonly #graph: SceneGraph;
  /** Graph id → record guid, for every layer that is a record. */
  readonly #record = new Map<string, string>();
  /** Graph id of a layer inside an instance → graph id of the component layer it copies. */
  readonly #copies = new Map<string, string>();
  readonly #ids = new Map<string, string>();
  readonly #sources = new Map<string, string | null>();

  constructor(graph: SceneGraph, records: ReadonlyMap<string, string>) {
    this.#graph = graph;
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

  /** The graph id of the layer `node` copies, when it's inside an instance. */
  copiedLayer(node: SceneNode): string | null {
    if (this.#record.has(node.id)) return null;
    const listed = this.#copies.get(node.id);
    if (listed) return listed;
    // A copied layer that isn't an instance names the layer it copies itself.
    return node.type !== "INSTANCE" ? node.componentId : null;
  }

  #copiedGuid(node: SceneNode): string | null {
    const listed = this.#copies.get(node.id);
    const guid =
      (listed ? this.#record.get(listed) : undefined) ??
      (node.type !== "INSTANCE" && node.componentId
        ? this.#record.get(node.componentId)
        : undefined);
    if (guid) return guid;
    // Otherwise the copied layer is the sibling at the same saved position under the layer
    // the parent copies (or, under the instance itself, under its main component).
    const parent = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
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

  /** The nearest instance above `node`, or null. */
  #instanceAbove(node: SceneNode): SceneNode | null {
    let at = node.parentId ? this.#graph.getNode(node.parentId) : undefined;
    while (at && at.type !== "INSTANCE")
      at = at.parentId ? this.#graph.getNode(at.parentId) : undefined;
    return at ?? null;
  }

  /** The layer's REST id. */
  of(node: SceneNode): string {
    const known = this.#ids.get(node.id);
    if (known) return known;
    let id = this.#record.get(node.id);
    if (!id) {
      const instance = this.#instanceAbove(node);
      // A layer with no known source still gets a stable, unique id from its graph id.
      const copied = this.sourceGuid(node) ?? `x${node.id}`;
      id = instance ? `I${core(this.of(instance))};${copied}` : copied;
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
