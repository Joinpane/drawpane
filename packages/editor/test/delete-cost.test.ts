import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";

/**
 * Deleting a selection costs what it deletes. Compact copies leave a delete
 * that a later delete of an ancestor covers to that delete (issue 280); that
 * check walks up from each layer once, rather than scanning the rest of the
 * batch for each one, which made 8,000 siblings take 6 times main's time.
 */
describe("deleting many layers", () => {
  const timeToDelete = (count: number): number => {
    const nodes: NodeRecord[] = [
      { id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      ...Array.from(
        { length: count },
        (_, i): NodeRecord => ({
          id: `r${i}`,
          type: "rect",
          parent: "p",
          key: "a0",
          props: { width: 10, height: 10 },
        }),
      ),
    ];
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round++) {
      const editor = new Editor({ measurer: { width: (_f, t) => t.length * 5 }, clientId: "cost" });
      editor.doc.resetStored(nodes, "compact");
      editor.state.set({ role: "editor" });
      editor.setPage("p");
      editor.select(nodes.slice(1).map((n) => n.id));
      const start = performance.now();
      editor.deleteSelection();
      best = Math.min(best, performance.now() - start);
      expect(editor.doc.childIds("p")).toEqual([]);
    }
    return best;
  };

  it("takes time linear in how many siblings go, with compact copies", () => {
    const small = timeToDelete(2000);
    const large = timeToDelete(8000);
    // Four times the layers: about four times the time when linear, sixteen when quadratic.
    expect(large / small, `${small.toFixed(1)} ms, then ${large.toFixed(1)} ms`).toBeLessThan(8);
  }, 60_000);
});
