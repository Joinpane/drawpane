/**
 * Every committed sample, read and converted as the import does, must pass
 * the checks the server runs on an import, and keep what makes it that
 * file: its pages, instances linked to their components, images, text runs.
 */
import { readFileSync } from "node:fs";
import { convertFile, drawpaneId, type Figma, mirroredId } from "@drawpane/figma";
import { applyTransaction, MemoryStore, type NodeRecord, type Op, ROOT_ID } from "@drawpane/model";
import { parseFigBuffer } from "@open-pencil/fig";
import { describe, expect, it } from "vitest";
import { type FigFile, readFig } from "../src";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Creates the nodes in a store the way the room does, parents first: throws on anything invalid. */
export function validate(nodes: readonly NodeRecord[]): MemoryStore {
  const store = new MemoryStore([]);
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of nodes) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  const ops: Op[] = [];
  const queue = [...(byParent.get(ROOT_ID) ?? [])];
  for (let n = queue.shift(); n; n = queue.shift()) {
    ops.push({
      op: "create",
      id: n.id,
      type: n.type,
      parent: n.parent,
      key: n.key,
      props: n.props,
    });
    queue.push(...(byParent.get(n.id) ?? []));
  }
  expect(ops).toHaveLength(nodes.length);
  applyTransaction(store, ops, { rollback: false });
  return store;
}

/** Every node of a REST file, depth first. */
function* walk(node: Figma.Node): Generator<Figma.Node> {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

const read: Record<string, Promise<FigFile>> = {};
const sample = (name: string) => {
  read[name] ??= readFig(fixture(name), { fileName: name });
  return read[name];
};
/** Converts as the import does, with every image "uploaded". */
const convert = (fig: FigFile) =>
  convertFile(fig.file, { images: (ref) => (fig.images.has(ref) ? "a".repeat(64) : null) });

// Reading a real file takes a few seconds, more while the rest of the repo's tests run alongside.
describe.each(["pattern.fig", "tailwind-ecklf.fig", "medianova.fig"])(
  "%s",
  { timeout: 60_000 },
  (name) => {
    it("converts to nodes the server accepts", async () => {
      const fig = await sample(name);
      const { nodes } = convert(fig);
      expect(nodes.filter((n) => n.type === "page").length).toBe(fig.pages);
      expect(nodes.length).toBeGreaterThan(fig.pages);
      validate(nodes);
    });

    it("reads the same a page at a time as all at once", async () => {
      const whole = await sample(name);
      const paged = await readFig(fixture(name), { fileName: name, pageAtATime: true });
      expect(paged.file).toEqual(whole.file);
      expect(paged.notes.lines()).toEqual(whole.notes.lines());
    });

    it("gives every layer its own id, and every copied layer the main's layer it copies", async () => {
      const fig = await sample(name);
      const ids = new Set<string>();
      for (const n of walk(fig.file.document)) {
        expect(ids.has(n.id), n.id).toBe(false);
        ids.add(n.id);
      }
      // A copied layer names a layer of its main, unless its instance was swapped to another
      // component (REST's ids can't name those either) or its main is a library's.
      const byId = new Map([...walk(fig.file.document)].map((n) => [n.id, n]));
      const parentOf = new Map<string, Figma.Node>();
      for (const n of byId.values()) for (const c of n.children ?? []) parentOf.set(c.id, n);
      let checked = 0;
      for (const [id, node] of byId) {
        if (!id.startsWith("I")) continue;
        let instance = parentOf.get(id);
        while (instance && instance.type !== "INSTANCE") instance = parentOf.get(instance.id);
        if (!instance?.componentId || !byId.has(instance.componentId)) continue;
        const parts = instance.id.slice(1).split(";");
        const original = parts.length > 1 ? byId.get(mirroredId(instance.id) ?? "") : instance;
        // A nested instance: the main's own copy of it must be here (not in a library's main)
        // and of the same component (not swapped).
        if (!original || original.componentId !== instance.componentId) continue;
        checked++;
        expect(byId.has(mirroredId(id) ?? ""), `${id} (${node.name})`).toBe(true);
      }
      if (name !== "pattern.fig") expect(checked).toBeGreaterThan(50);
    });
  },
);

describe("what each sample keeps", () => {
  it("pattern (zip, v95): every page, in order", async () => {
    const fig = await sample("pattern.fig");
    expect(fig.version).toBe(95);
    expect(fig.file.document.children?.map((p) => p.name)).toEqual([
      "Logo",
      "Information + License",
      "=== DEFINITIONS ===",
      "Colors",
      "Grids",
      "Spacing & Sizing",
      "Typography",
      "=== MOLECULES ===",
      "Buttons",
      "Selectables",
    ]);
    const { nodes } = convert(fig);
    expect(nodes.filter((n) => n.props.isComponent === true).length).toBeGreaterThan(40);
  });

  it("tailwind (raw, v4): instances linked to their mains, legacy styles resolved", async () => {
    const fig = await sample("tailwind-ecklf.fig");
    expect(fig.version).toBe(4);
    const { nodes } = convert(fig);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const instances = nodes.filter((n) => typeof n.props.instanceOf === "string");
    expect(instances.length).toBeGreaterThan(150);
    for (const i of instances)
      expect(byId.get(i.props.instanceOf as string)?.props.isComponent).toBe(true);
    const mirrors = nodes.filter((n) => typeof n.props.mirrors === "string");
    expect(mirrors.length).toBeGreaterThan(150);
    for (const m of mirrors) expect(byId.has(m.props.mirrors as string)).toBe(true);
    // Layers whose fill comes from a style (older files link one by guid): Figma left stale
    // fills on most of them in this file. Each takes its style's colour, as Figma shows it.
    const buffer = fixture("tailwind-ecklf.fig").buffer as ArrayBuffer;
    const records = parseFigBuffer(buffer, undefined, {
      NodeChange: ["guid", "type", "fillPaints", "inheritFillStyleID", "styleType"],
    }).nodeChanges;
    const guid = (g: { sessionID?: number; localID?: number } | undefined) =>
      g ? `${g.sessionID}:${g.localID}` : "";
    const byGuid = new Map(records.map((r) => [guid(r.guid), r]));
    const hex = (c: { r: number; g: number; b: number } | undefined) =>
      c
        ? `#${[c.r, c.g, c.b]
            .map((v) =>
              Math.round(v * 255)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")}`
        : "";
    let linked = 0;
    let stale = 0;
    let matches = 0;
    for (const r of records) {
      const style = r.inheritFillStyleID ? byGuid.get(guid(r.inheritFillStyleID)) : undefined;
      const colour = style?.fillPaints?.[0]?.color;
      const node = byId.get(drawpaneId(guid(r.guid)));
      if (!colour || !node || style?.fillPaints?.length !== 1) continue;
      linked++;
      if (hex(r.fillPaints?.[0]?.color) !== hex(colour)) stale++;
      if (JSON.stringify(node.props.fills).includes(`"${hex(colour)}`)) matches++;
    }
    expect(linked).toBeGreaterThan(300);
    expect(stale / linked).toBeGreaterThan(0.5);
    expect(matches / linked).toBeGreaterThan(0.95);
  });

  it("medianova (zip, v52): images come with the file", async () => {
    const fig = await sample("medianova.fig");
    expect(fig.images.size).toBeGreaterThan(10);
    for (const image of fig.images.values()) expect(image.mime).toMatch(/^image\/(png|jpeg)$/);
    const { nodes, notes } = convert(fig);
    const imageFills = nodes.filter((n) =>
      JSON.stringify(n.props.fills ?? []).includes('"type":"image"'),
    );
    // Most of its images sit in DesignCompose widgets, which aren't imported (as from the API).
    expect(imageFills.length).toBeGreaterThanOrEqual(3);
    expect(notes.lines()).toContain("7 layers of unsupported kinds were skipped");
    expect(notes.lines().join("\n")).not.toContain("couldn't be fetched");
  });
});
