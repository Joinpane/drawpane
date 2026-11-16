/**
 * Compact copies (decision 0029) are the same document: for every file in
 * today's materialized form, building every copy from the converted file
 * gives it back, ids mapped. Checked on generated kits, the committed `.fig`
 * samples and the Penpot fixtures, each as the import saves it
 * (`pinInstances`). A failure names the first node and property that differ.
 */
import { readFileSync } from "node:fs";
import { compactCopiesDefault, pinInstances, setCompactCopiesDefault } from "@drawpane/editor";
import { readFig } from "@drawpane/fig";
import { convertFile as convertFigma } from "@drawpane/figma";
import {
  applyTransaction,
  compact,
  expand,
  firstDifference,
  MemoryStore,
  type NodeRecord,
  type Op,
  ROOT_ID,
  renameIds,
  samePropValue,
} from "@drawpane/model";
import { convertFile as convertPenpot, readPenpot } from "@drawpane/penpot";
import { describe, expect, it } from "vitest";
import { generateKit } from "../src";

/** Creates the nodes as the room would, parents first: throws on anything it would refuse. */
function validate(nodes: readonly NodeRecord[]): void {
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parent);
    if (list) list.push(n);
    else byParent.set(n.parent, [n]);
  }
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
  applyTransaction(new MemoryStore([]), ops, { rollback: false });
}

interface Checked {
  readonly layers: number;
  readonly stored: number;
  readonly records: number;
  readonly bytes: { readonly before: number; readonly after: number };
}

/** Converts, validates the stored form, builds it back and compares. */
function equivalent(materialized: readonly NodeRecord[]): Checked {
  const result = compact(materialized);
  expect(result.detached, "instances whose layers aren't their main's").toEqual([]);
  validate(result.nodes);
  const difference = firstDifference(renameIds(materialized, result.ids), expand(result.nodes));
  expect(difference).toBeNull();
  // Canonical: the stored form of the built document is the stored form.
  expect(firstDifference(result.nodes, compact(expand(result.nodes)).nodes)).toBeNull();
  return {
    layers: materialized.length,
    stored: result.nodes.length,
    records: result.nodes.filter((n) => n.type === "override").length,
    bytes: {
      before: JSON.stringify(materialized).length,
      after: JSON.stringify(result.nodes).length,
    },
  };
}

const report = (name: string, c: Checked) =>
  console.log(
    `${name}: ${c.layers} nodes → ${c.stored} stored (${c.records} override records), ` +
      `${(c.bytes.before / 1048576).toFixed(1)} MB → ${(c.bytes.after / 1048576).toFixed(1)} MB`,
  );

describe("compact copies on generated kits", { timeout: 120_000 }, () => {
  it.each([
    [3_000, 1],
    [3_000, 2],
    [20_000, 7],
    [60_000, 3],
  ])("%i layers, seed %i", (layers, seed) => {
    const kit = generateKit({ layers, seed });
    const checked = equivalent(kit.nodes);
    report(`kit ${layers}/${seed}`, checked);
    // Mostly copies that equal their main: about a fifth of the size stored.
    expect(checked.stored / checked.layers).toBeLessThan(0.4);
  });
});

/** The first difference between two documents compared as trees (ids aside), or null. */
function treeDifference(a: readonly NodeRecord[], b: readonly NodeRecord[]): string | null {
  const kids = (nodes: readonly NodeRecord[]) => {
    const map = new Map<string, NodeRecord[]>();
    for (const n of nodes) map.set(n.parent, [...(map.get(n.parent) ?? []), n]);
    for (const list of map.values())
      list.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id < y.id ? -1 : 1));
    return map;
  };
  const ka = kids(a);
  const kb = kids(b);
  const map = new Map<string, string>();
  const pairs: [NodeRecord, NodeRecord][] = [];
  const walk = (pa: string, pb: string): string | null => {
    const la = ka.get(pa) ?? [];
    const lb = kb.get(pb) ?? [];
    if (la.length !== lb.length) return `${pa}: ${lb.length} layers, expected ${la.length}`;
    for (let i = 0; i < la.length; i++) {
      const na = la[i] as NodeRecord;
      const nb = lb[i] as NodeRecord;
      map.set(na.id, nb.id);
      pairs.push([na, nb]);
      const found = walk(na.id, nb.id);
      if (found) return found;
    }
    return null;
  };
  const found = walk(ROOT_ID, ROOT_ID);
  if (found) return found;
  for (const [na, nb] of pairs) {
    if (na.type !== nb.type || na.key !== nb.key) return `${na.id}: ${nb.type} ${nb.key}`;
    const pa = na.props as Record<string, unknown>;
    const pb = nb.props as Record<string, unknown>;
    for (const prop of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      const want =
        prop === "mirrors" || prop === "instanceOf" ? map.get(pa[prop] as string) : pa[prop];
      if (!samePropValue(prop, want, pb[prop]))
        return `${na.type} ${na.id} "${pa.name ?? ""}": ${prop} is ${JSON.stringify(pb[prop])}, expected ${JSON.stringify(want)}`;
    }
  }
  return null;
}

describe("a kit made through compact copies", { timeout: 120_000 }, () => {
  it.each([
    [3_000, 1],
    [20_000, 7],
  ])("is the kit made through materialized ones: %i layers, seed %i", (layers, seed) => {
    const previous = compactCopiesDefault();
    try {
      setCompactCopiesDefault(false);
      const materialized = generateKit({ layers, seed });
      setCompactCopiesDefault(true);
      const compacted = generateKit({ layers, seed });
      expect(compacted.stats.layers).toBe(materialized.stats.layers);
      expect(treeDifference(materialized.nodes, compacted.nodes)).toBeNull();
    } finally {
      setCompactCopiesDefault(previous);
    }
  });
});

const figFixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../fig/test/fixtures/${name}`, import.meta.url)));
const penpotFixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../penpot/test/fixtures/${name}`, import.meta.url)));

describe("compact copies on .fig samples", { timeout: 120_000 }, () => {
  it.each(["pattern.fig", "tailwind-ecklf.fig", "medianova.fig"])("%s", async (name) => {
    const fig = await readFig(figFixture(name), { fileName: name });
    const { nodes } = convertFigma(fig.file, {
      images: (ref) => (fig.images.has(ref) ? "a".repeat(64) : null),
    });
    report(name, equivalent(pinInstances(nodes).nodes));
  });
});

describe("compact copies on Penpot fixtures", { timeout: 120_000 }, () => {
  it.each(["file-with-library.penpot", "svg-attrs-camel-case.penpot", "showcase.penpot"])(
    "%s",
    async (name) => {
      const exp = await readPenpot(penpotFixture(name));
      for (const file of exp.files) {
        const { nodes } = convertPenpot(file, () => undefined);
        report(
          `${name} / ${file.record.name ?? file.record.id}`,
          equivalent(pinInstances(nodes).nodes),
        );
      }
    },
  );
});
