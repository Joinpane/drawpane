/**
 * A deterministic sample of a .fig's frames to compare, by Figma node id.
 *
 * Units are what a person looks at: each page's top-level frames, sections
 * opened up (they aren't drawn as frames), and anything too large to export
 * at the comparison's scale replaced by its children. Component sets also
 * offer their components. Each page gets an even share of the sample (pages
 * with fewer units give theirs to the rest), split evenly between frames,
 * component sets and components, picked at even intervals in Figma's order.
 * Then the frames built from the most instances are added, as screens.
 *
 * The same file and options always give the same sample.
 */

import { parseFigBuffer } from "@open-pencil/fig";
import type { NodeChange } from "@open-pencil/kiwi/fig/codec";

export interface SampleOptions {
  /** About how many units to pick, before screens are added. */
  readonly count?: number;
  /** The scale renders are compared at. */
  readonly scale?: number;
  /** A unit larger than this many pixels at `scale` is replaced by its children. */
  readonly maxPixels?: number;
  /** Or longer than this on a side at `scale`. */
  readonly maxSide?: number;
  /** Screens added: the frames built from the most instances, as a share of `count`. */
  readonly screens?: number;
}

export type UnitKind = "frame" | "component-set" | "component" | "screen";

export interface SampleEntry {
  /** Figma's node id, as the plugin and REST APIs spell it. */
  readonly id: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly name: string;
  /** Figma's node type. */
  readonly type: string;
  readonly kind: UnitKind;
  readonly width: number;
  readonly height: number;
  /** Saved instances inside it (not counting instances inside instances). */
  readonly instances: number;
}

export interface Sample {
  readonly createdWith: Required<SampleOptions>;
  readonly pages: number;
  readonly units: number;
  readonly frames: readonly SampleEntry[];
}

type Guid = { sessionID: number; localID: number };
const guid = (g: Guid | undefined) => (g ? `${g.sessionID}:${g.localID}` : null);

/** Figma's node type for a record, as Open Pencil resolves it. */
function figmaType(r: NodeChange): string {
  if (r.type === "SYMBOL") return "COMPONENT";
  if (r.type === "ROUNDED_RECTANGLE") return "RECTANGLE";
  if (r.type === "FRAME") {
    const defs = r.componentPropDefs as readonly { type?: string }[] | undefined;
    if (defs?.some((d) => d.type === "VARIANT")) return "COMPONENT_SET";
    if (r.resizeToFit === true && (r.stackMode === undefined || r.stackMode === "NONE"))
      return "GROUP";
  }
  return r.type ?? "UNKNOWN";
}

const CONTAINERS = new Set(["FRAME", "GROUP", "COMPONENT_SET", "SECTION"]);
const UNITS = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);

/** Indices of `k` items spread evenly over `n`. */
function evenly(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * n) / k));
}

/** Shares of `total` for groups of these sizes, as even as they allow (water-filling). */
export function shares(sizes: readonly number[], total: number): number[] {
  const out = sizes.map(() => 0);
  let left = Math.min(
    total,
    sizes.reduce((a, b) => a + b, 0),
  );
  while (left > 0) {
    const open = sizes.map((_, i) => i).filter((i) => (out[i] as number) < (sizes[i] as number));
    const each = Math.max(1, Math.floor(left / open.length));
    for (const i of open) {
      if (left === 0) break;
      const add = Math.min(each, (sizes[i] as number) - (out[i] as number), left);
      out[i] = (out[i] as number) + add;
      left -= add;
    }
  }
  return out;
}

export function sampleFig(bytes: Uint8Array, options: SampleOptions = {}): Sample {
  const opts: Required<SampleOptions> = {
    count: options.count ?? 400,
    scale: options.scale ?? 2,
    maxPixels: options.maxPixels ?? 24_000_000,
    maxSide: options.maxSide ?? 12_000,
    screens: options.screens ?? 0.05,
  };
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const records = parseFigBuffer(buffer).nodeChanges.filter((r) => r.phase !== "REMOVED");
  const children = new Map<string, NodeChange[]>();
  for (const r of records) {
    const parent = guid(r.parentIndex?.guid as Guid | undefined);
    if (!parent || !guid(r.guid as Guid | undefined)) continue;
    const list = children.get(parent);
    if (list) list.push(r);
    else children.set(parent, [r]);
  }
  const position = (r: NodeChange) => r.parentIndex?.position ?? "";
  for (const list of children.values())
    list.sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));
  const kids = (r: NodeChange) => children.get(guid(r.guid as Guid) as string) ?? [];

  const instanceCounts = new Map<string, number>();
  const instancesIn = (r: NodeChange): number => {
    const id = guid(r.guid as Guid) as string;
    const known = instanceCounts.get(id);
    if (known !== undefined) return known;
    let n = 0;
    for (const c of kids(r)) n += (c.type === "INSTANCE" ? 1 : 0) + instancesIn(c);
    instanceCounts.set(id, n);
    return n;
  };

  const pages = records
    .filter((r) => r.type === "CANVAS" && !r.internalOnly)
    .sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));

  type Unit = Omit<SampleEntry, "kind"> & { kind: Exclude<UnitKind, "screen"> };
  const perPage: { frames: Unit[]; sets: Unit[]; components: Unit[] }[] = [];
  const s = opts.scale;
  const tooLarge = (w: number, h: number) =>
    w * s > opts.maxSide || h * s > opts.maxSide || w * h * s * s > opts.maxPixels;

  for (const page of pages) {
    const pageId = guid(page.guid as Guid) as string;
    const groups = { frames: [] as Unit[], sets: [] as Unit[], components: [] as Unit[] };
    const unit = (r: NodeChange, kind: Unit["kind"]): Unit => ({
      id: guid(r.guid as Guid) as string,
      pageId,
      pageName: page.name ?? "",
      name: r.name ?? "",
      type: figmaType(r),
      kind,
      width: Math.round((r.size?.x ?? 0) * 100) / 100,
      height: Math.round((r.size?.y ?? 0) * 100) / 100,
      instances: instancesIn(r),
    });
    const visit = (r: NodeChange, depth: number) => {
      if (r.visible === false) return;
      const type = figmaType(r);
      const w = r.size?.x ?? 0;
      const h = r.size?.y ?? 0;
      if (type === "SECTION" || (CONTAINERS.has(type) && tooLarge(w, h))) {
        if (depth < 4) for (const c of kids(r)) visit(c, depth + 1);
        return;
      }
      if (!UNITS.has(type) || w < 1 || h < 1 || tooLarge(w, h)) return;
      if (type === "COMPONENT_SET") {
        groups.sets.push(unit(r, "component-set"));
        for (const c of kids(r)) {
          const cw = c.size?.x ?? 0;
          const ch = c.size?.y ?? 0;
          if (c.visible !== false && figmaType(c) === "COMPONENT" && cw >= 1 && ch >= 1)
            groups.components.push(unit(c, "component"));
        }
      } else if (type === "COMPONENT") groups.components.push(unit(r, "component"));
      else groups.frames.push(unit(r, "frame"));
    };
    for (const c of kids(page)) visit(c, 0);
    perPage.push(groups);
  }

  const sizes = perPage.map((g) => g.frames.length + g.sets.length + g.components.length);
  const quotas = shares(sizes, opts.count);
  const picked: SampleEntry[] = [];
  const chosen = new Set<string>();
  perPage.forEach((groups, i) => {
    const lists = [groups.frames, groups.sets, groups.components];
    const split = shares(
      lists.map((l) => l.length),
      quotas[i] as number,
    );
    lists.forEach((list, j) => {
      for (const at of evenly(list.length, split[j] as number)) {
        const u = list[at] as Unit;
        if (chosen.has(u.id)) continue;
        chosen.add(u.id);
        picked.push(u);
      }
    });
  });

  // Screens: the frames built from the most instances, wherever they are.
  const screens = perPage
    .flatMap((g) => g.frames)
    .filter((u) => !chosen.has(u.id) && u.instances >= 20)
    .sort((a, b) => b.instances - a.instances || (a.id < b.id ? -1 : 1))
    .slice(0, Math.ceil(opts.count * opts.screens));
  for (const u of screens) {
    chosen.add(u.id);
    picked.push({ ...u, kind: "screen" });
  }

  // In Figma's order: by page, then as the units were found.
  const pageOrder = new Map(pages.map((p, i) => [guid(p.guid as Guid) as string, i]));
  const found = new Map(
    perPage.flatMap((g) => [...g.frames, ...g.sets, ...g.components]).map((u, i) => [u.id, i]),
  );
  picked.sort(
    (a, b) =>
      (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) ||
      (found.get(a.id) ?? 0) - (found.get(b.id) ?? 0),
  );
  return {
    createdWith: opts,
    pages: pages.length,
    units: sizes.reduce((a, b) => a + b, 0),
    frames: picked,
  };
}
