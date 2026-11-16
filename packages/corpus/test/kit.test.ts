import { applyTransaction, MemoryStore, type Op, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { generateKit } from "../src";

// Building a file of 20,000 layers takes a second or two, more under a full parallel run.
describe("a generated kit", { timeout: 60_000 }, () => {
  it("is a valid file, shaped like a real kit", () => {
    const kit = generateKit({ layers: 20_000, seed: 7 });
    const byParent = new Map<string, typeof kit.nodes>();
    for (const n of kit.nodes) {
      const siblings = byParent.get(n.parent);
      if (siblings) siblings.push(n);
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
      } as Op);
      queue.push(...(byParent.get(n.id) ?? []));
    }
    expect(ops).toHaveLength(kit.nodes.length);
    applyTransaction(new MemoryStore([]), ops, { rollback: false });

    expect(kit.stats.layers).toBeGreaterThanOrEqual(20_000);
    expect(kit.stats.layers).toBeLessThan(24_000);
    // Mostly copies, as real kits are.
    const mirrored = kit.nodes.filter((n) => typeof n.props.mirrors === "string").length;
    expect(mirrored / kit.stats.layers).toBeGreaterThan(0.6);
    // About what the shadcn/ui Pro kit's converted layers weigh.
    expect(kit.stats.bytes / kit.stats.layers).toBeGreaterThan(250);
    expect(kit.stats.bytes / kit.stats.layers).toBeLessThan(700);
    expect(kit.busiestMains[0]?.copies).toBeGreaterThan(100);
  });

  it("is the same file for the same seed", () => {
    const shape = (seed: number) =>
      generateKit({ layers: 3_000, seed })
        .nodes.map((n) => `${n.type}:${n.props.name ?? ""}`)
        .join();
    expect(shape(3)).toBe(shape(3));
    expect(shape(3)).not.toBe(shape(4));
  });
});
