/**
 * A `.fig` file's variables, styles and bindings, in the shapes Figma's REST
 * API gives them (decision 0034), so `@drawpane/figma` converts them as it
 * would a file read by link.
 *
 * - Collections and variables come from Open Pencil's graph, which reads
 *   their records with their metadata. Soft-deleted ones (Figma keeps them
 *   for undo) are left out, as Figma's API leaves them out.
 * - A layer's own bound fields come from the graph's `boundVariables`, which
 *   applies instance overrides; paints' colours from it too.
 * - Effects' and gradient stops' bindings, which Open Pencil doesn't keep,
 *   come from the records (`xVar`, `yVar`, `radiusVar`, `spreadVar`,
 *   `colorVar`, `stopsVar`).
 */
import type { Figma } from "@drawpane/figma";
import type { SceneGraph, SceneNode } from "@open-pencil/scene-graph";
import type { RawRecord } from "./raw";

type Guid = { sessionID: number; localID: number };
const guidKey = (g: Guid) => `${g.sessionID}:${g.localID}`;
const isGuid = (v: unknown): v is Guid =>
  !!v && typeof v === "object" && typeof (v as Guid).sessionID === "number";

/** A variable's REST id from Open Pencil's. */
export const restVariableId = (id: string) => `VariableID:${id}`;
/** A collection's REST id from Open Pencil's. */
export const restCollectionId = (id: string) => `VariableCollectionId:${id}`;

/** Turns what a record or the graph says a field is bound to into REST's alias, when it's a variable the file has. */
export type AliasOf = (data: unknown) => Figma.VariableAlias | undefined;

/** Reading variable references, in the record's form (guid or library key) or the graph's (an id). */
export function aliasReader(graph: SceneGraph, records: ReadonlyMap<string, RawRecord>): AliasOf {
  const byKey = new Map<string, string>();
  for (const v of graph.variables.values()) if (v.key) byKey.set(v.key, v.id);
  const known = (id: string | undefined) => {
    if (!id || !graph.variables.has(id)) return undefined;
    if ((records.get(id) as { isSoftDeleted?: boolean } | undefined)?.isSoftDeleted)
      return undefined;
    return { type: "VARIABLE_ALIAS" as const, id: restVariableId(id) };
  };
  return (data) => {
    if (typeof data === "string") return known(data);
    const alias = (data as { value?: { alias?: { guid?: unknown; assetRef?: { key?: string } } } })
      ?.value?.alias;
    if (!alias) return undefined;
    if (isGuid(alias.guid)) return known(guidKey(alias.guid));
    const key = alias.assetRef?.key;
    return key ? known(byKey.get(key)) : undefined;
  };
}

const TYPES = { COLOR: "COLOR", FLOAT: "FLOAT", STRING: "STRING", BOOLEAN: "BOOLEAN" } as const;

/** The file's collections and variables, as GET /v1/files/:key/variables/local returns them. */
export function restVariables(
  graph: SceneGraph,
  records: ReadonlyMap<string, RawRecord>,
): Figma.LocalVariables {
  const soft = (id: string) =>
    !!(records.get(id) as { isSoftDeleted?: boolean } | undefined)?.isSoftDeleted;
  const variableCollections: Record<string, Figma.VariableCollection> = {};
  const variables: Record<string, Figma.Variable> = {};
  for (const c of graph.variableCollections.values()) {
    if (soft(c.id)) continue;
    const ids = c.variableIds.filter((id) => graph.variables.has(id) && !soft(id));
    variableCollections[restCollectionId(c.id)] = {
      id: restCollectionId(c.id),
      name: c.name,
      ...(c.key ? { key: c.key, remote: true } : {}),
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      defaultModeId: c.defaultModeId,
      variableIds: ids.map(restVariableId),
    };
  }
  for (const v of graph.variables.values()) {
    if (soft(v.id) || !variableCollections[restCollectionId(v.collectionId)]) continue;
    const resolvedType = TYPES[v.type as keyof typeof TYPES];
    if (!resolvedType) continue;
    const valuesByMode: Record<string, Figma.VariableModeValue> = {};
    for (const [mode, value] of Object.entries(v.valuesByMode)) {
      if (value && typeof value === "object" && "aliasId" in value) {
        const opacity = (value as { opacity?: unknown }).opacity;
        valuesByMode[mode] = {
          type: "VARIABLE_ALIAS",
          id: restVariableId(value.aliasId),
          ...(typeof opacity === "number" ? { opacity } : {}),
        };
      } else if (value && typeof value === "object" && "r" in value) {
        const c = value as { r: number; g: number; b: number; a?: number };
        valuesByMode[mode] = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
      } else if (value !== undefined && value !== null)
        valuesByMode[mode] = value as number | string | boolean;
    }
    variables[restVariableId(v.id)] = {
      id: restVariableId(v.id),
      name: v.name,
      ...(v.key ? { key: v.key, remote: true } : {}),
      variableCollectionId: restCollectionId(v.collectionId),
      resolvedType,
      valuesByMode,
      ...(v.description ? { description: v.description } : {}),
      ...(v.hiddenFromPublishing ? { hiddenFromPublishing: true } : {}),
      ...(v.scopes ? { scopes: [...v.scopes] } : {}),
      ...(v.codeSyntax ? { codeSyntax: { ...v.codeSyntax } } : {}),
    };
  }
  return { variableCollections, variables };
}

/** Open Pencil's names for a layer's bound fields that REST spells otherwise. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  borderTopWeight: "strokeTopWeight",
  borderRightWeight: "strokeRightWeight",
  borderBottomWeight: "strokeBottomWeight",
  borderLeftWeight: "strokeLeftWeight",
  text: "characters",
};
/** Bound fields that aren't brought: where the layer is is decided by layout and the file. */
const NOT_BROUGHT = new Set(["x", "y", "rotation"]);
/** The units Open Pencil keeps a binding in when it's as Figma wrote it (a percentage for opacity). */
const UNIT: Readonly<Record<string, number>> = { opacity: 0.01 };

/**
 * A layer's own bound fields in REST's shape, from the graph: paints'
 * colours aside (`paintColor`). One Open Pencil scaled (a copy scaled as a
 * whole) is left out: the layer keeps the value Figma saved for it.
 */
export function layerBoundVariables(
  n: SceneNode,
  aliasOf: AliasOf,
): Record<string, Figma.VariableAlias> | undefined {
  const out: Record<string, Figma.VariableAlias> = {};
  for (const [field, id] of Object.entries(n.boundVariables)) {
    if (field.includes("/") || NOT_BROUGHT.has(field)) continue;
    const scale = n.variableBindingScales?.[field];
    if (scale !== undefined && Math.abs(scale - (UNIT[field] ?? 1)) > 1e-9) continue;
    const alias = aliasOf(id);
    if (alias) out[FIELD_NAMES[field] ?? field] = alias;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The variable a paint's colour is bound to (`fills/0/color`), as REST's
 * alias. Which variable comes from provenance (decision 0034): the layer's
 * own binding, or, for a nested instance swapped to another variant, the one
 * `applySwappedLooks` carried over from the component now chosen. The
 * colour Figma saved isn't evidence against it (a copy in another mode
 * saves another colour): `differs`, when given, is told when the binding
 * resolves at the layer to another colour than the one saved, as a
 * diagnostic only.
 */
export function paintColor(
  n: SceneNode,
  list: "fills" | "strokes",
  index: number,
  aliasOf: AliasOf,
  graph: SceneGraph,
  differs?: (resolved: Figma.RGBA, saved: Figma.RGBA) => void,
): Figma.VariableAlias | undefined {
  const id = n.boundVariables[`${list}/${index}/color`];
  if (!id) return undefined;
  const alias = aliasOf(id);
  if (alias && differs) {
    const paint = (list === "fills" ? n.fills : n.strokes)[index];
    const color = graph.resolveColorVariableForNode(n.id, id);
    if (paint?.type === "SOLID" && paint.color && color) {
      const near = (a: number, b: number) => Math.abs(a - b) <= 1.5 / 255;
      const alpha = (paint.opacity ?? 1) * (paint.color.a ?? 1);
      if (
        !near(paint.color.r, color.r) ||
        !near(paint.color.g, color.g) ||
        !near(paint.color.b, color.b) ||
        !near(alpha, color.a ?? 1)
      )
        differs(
          { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 },
          { ...paint.color, a: alpha },
        );
    }
  }
  return alias;
}

/** The modes a layer sets, by REST collection ids, for collections the file has. */
export function explicitModes(n: SceneNode, graph: SceneGraph): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [collection, mode] of Object.entries(n.variableModes ?? {}))
    if (graph.variableCollections.has(collection) && mode) out[restCollectionId(collection)] = mode;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Finds style records by guid or library key, as a layer's links name them. */
export function styleFinder(
  records: ReadonlyMap<string, RawRecord>,
): (link: unknown) => string | undefined {
  const byKey = new Map<string, string>();
  for (const [id, r] of records) {
    const rec = r as { styleType?: unknown; key?: unknown; version?: unknown };
    if (!rec.styleType || typeof rec.key !== "string") continue;
    byKey.set(rec.key, id);
    if (typeof rec.version === "string") byKey.set(`${rec.key}@${rec.version}`, id);
  }
  const style = (id: string | undefined) => {
    const r = id
      ? (records.get(id) as { styleType?: unknown; isSoftDeleted?: boolean })
      : undefined;
    return r?.styleType && !r.isSoftDeleted ? id : undefined;
  };
  return (link) => {
    if (typeof link === "string") return style(link);
    const { guid, assetRef } = (link ?? {}) as {
      guid?: unknown;
      assetRef?: { key?: string; version?: string };
    };
    if (isGuid(guid)) return style(guidKey(guid));
    if (!assetRef?.key) return undefined;
    return style(
      (assetRef.version ? byKey.get(`${assetRef.key}@${assetRef.version}`) : undefined) ??
        byKey.get(assetRef.key),
    );
  };
}

const LINK_FIELDS = [
  ["fillStyleId", "styleIdForFill", "fill"],
  ["strokeStyleId", "styleIdForStrokeFill", "stroke"],
  ["effectStyleId", "styleIdForEffect", "effect"],
  ["textStyleId", "styleIdForText", "text"],
  ["gridStyleId", "styleIdForGrid", "grid"],
] as const;

/**
 * The styles a layer links, by REST style ids (the style records' guids):
 * the graph's link where it has one (instance overrides applied), else the
 * record's (a library style named by key, which the graph doesn't follow).
 */
export function styleLinks(
  n: SceneNode,
  raw: RawRecord | undefined,
  find: (link: unknown) => string | undefined,
): Figma.Node["styles"] | undefined {
  const out: Record<string, string> = {};
  for (const [graphField, recordField, kind] of LINK_FIELDS) {
    const id =
      find((n as unknown as Record<string, unknown>)[graphField]) ??
      find((raw as Record<string, unknown> | undefined)?.[recordField]);
    if (id) out[kind] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
