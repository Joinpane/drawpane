/**
 * What a document records as read while `trackReads` is on: what an agent
 * run's scope is found from (decision 0033), the top-level layers it read in.
 */
import { copyId, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";

function doc(compactCopies = false) {
  const d = new Doc({ compactCopies });
  d.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    { op: "create", id: "f", type: "frame", parent: "p", key: "a0", props: { width: 100 } },
    { op: "create", id: "a", type: "rect", parent: "f", key: "a0", props: {} },
    { op: "create", id: "b", type: "rect", parent: "f", key: "a1", props: {} },
  ]);
  return d;
}

describe("a document's reads", () => {
  it("records layers read and child lists read, and nothing once untracked", () => {
    const d = doc();
    const reads = d.trackReads();
    d.get("a");
    d.has("missing");
    d.childIds("f");
    d.untrackReads();
    d.get("p");
    expect([...reads.ids].sort()).toEqual(["a", "f", "missing"]);
    expect([...reads.lists]).toEqual(["f"]);
    expect(reads.all).toBe(false);
  });

  it("records ancestors read on the way up", () => {
    const d = doc();
    const reads = d.trackReads();
    d.pageOf("a");
    expect([...reads.ids].sort()).toEqual(["a", "f", "p"]);
  });

  it("depends on everything once every layer is read", () => {
    const d = doc();
    const reads = d.trackReads();
    for (const _ of d.nodes()) break;
    expect(reads.all).toBe(true);
  });

  it("records a copy layer read by its own id", () => {
    const d = doc(true);
    d.apply([
      { op: "set", id: "f", prop: "isComponent", value: true },
      {
        op: "create",
        id: "i",
        type: "frame",
        parent: "p",
        key: "a1",
        props: { instanceOf: "f", x: 300 },
      },
    ]);
    const copy = copyId("i", ["a"]);
    expect(d.get(copy)).toBeDefined();
    const reads = d.trackReads();
    d.get(copy);
    expect([...reads.ids]).toEqual([copy]);
  });
});
