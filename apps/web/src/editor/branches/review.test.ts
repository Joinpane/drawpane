import { branchChanges, type NodeRecord, nodeReader } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { kindCounts, mergePlan, reviewRows, valueText } from "./review";

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown> = {},
): NodeRecord => ({ id, type, parent, key, props }) as NodeRecord;

const BASE: NodeRecord[] = [
  node("p", "page", "root", "a0", { name: "Page" }),
  node("card", "frame", "p", "a0", { name: "Hero card", width: 320 }),
  node("title", "text", "card", "a0", { name: "Greeting", characters: "Good morning" }),
  node("badge", "rect", "p", "a1", {
    name: "Badge",
    fills: [{ type: "solid", color: "#16181d" }],
  }),
];

function review(branch: NodeRecord[], main: NodeRecord[] = BASE) {
  const docs = { base: nodeReader(BASE), branch: nodeReader(branch), main: nodeReader(main) };
  return reviewRows(branchChanges(docs.base, docs.branch, docs.main), docs);
}

const withProps = (nodes: NodeRecord[], id: string, props: Record<string, unknown>) =>
  nodes.map((n) => (n.id === id ? { ...n, props: { ...n.props, ...props } } : n));

describe("review rows", () => {
  it("says each change in words, named by its layer", () => {
    let branch = withProps(BASE, "title", { characters: "Good afternoon" });
    branch = withProps(branch, "badge", { fills: [{ type: "solid", color: "#2b4fd6" }] });
    branch = [...branch, node("note", "text", "card", "a1", { name: "Note", characters: "Hi" })];
    const rows = review(branch);
    expect(rows.map((r) => [r.layer, r.detail])).toEqual([
      ["Greeting", "Text “Good morning” → “Good afternoon”"],
      ["Note", "New text layer"],
      ["Badge", "Fill #16181d → #2b4fd6"],
    ]);
    expect(kindCounts(rows)).toEqual({ added: 1, changed: 2, removed: 0 });
  });

  it("puts conflicts first, with both sides", () => {
    const branch = withProps(withProps(BASE, "card", { width: 360 }), "badge", { opacity: 0.5 });
    const main = withProps(BASE, "badge", { opacity: 0.25 });
    const rows = review(branch, main);
    expect(rows[0]).toMatchObject({
      layer: "Badge",
      conflict: true,
      sides: { main: "Opacity 25%", branch: "Opacity 50%" },
    });
    expect(rows[1]).toMatchObject({
      layer: "Hero card",
      detail: "Width 320 → 360",
      conflict: false,
    });
  });

  it("names moves and deletions", () => {
    const branch = BASE.filter((n) => n.id !== "badge").map((n) =>
      n.id === "title" ? { ...n, parent: "p", key: "a2" } : n,
    );
    const rows = review(branch);
    expect(rows.map((r) => r.detail)).toEqual(["Moved into Page", "Deleted"]);
  });
});

describe("merge plan", () => {
  const branch = withProps(withProps(BASE, "card", { width: 360 }), "badge", { opacity: 0.5 });
  const main = withProps(BASE, "badge", { opacity: 0.25 });
  const rows = review(branch, main);
  const conflict = rows[0]?.key as string;
  const clean = rows[1]?.key as string;

  it("waits for every conflict to be decided", () => {
    const plan = mergePlan(rows, { resolutions: new Map(), skipped: new Set() });
    expect(plan).toMatchObject({ undecided: 1, conflicts: 1, ready: false });
  });

  it("counts what merging takes", () => {
    expect(
      mergePlan(rows, { resolutions: new Map([[conflict, "branch"]]), skipped: new Set() }),
    ).toMatchObject({ included: 2, total: 2, ready: true });
    // Main's side takes nothing from the branch.
    expect(
      mergePlan(rows, { resolutions: new Map([[conflict, "main"]]), skipped: new Set() }),
    ).toMatchObject({ included: 1, ready: true });
    // Leaving out the conflict needs no decision; leaving out everything leaves nothing to merge.
    expect(
      mergePlan(rows, { resolutions: new Map(), skipped: new Set([conflict, clean]) }),
    ).toMatchObject({ included: 0, undecided: 0, ready: false });
  });
});

describe("values", () => {
  it("keeps them short", () => {
    expect(valueText("opacity", 0.5)).toBe("50%");
    expect(valueText("width", 120.456)).toBe("120.46");
    expect(valueText("visible", false)).toBe("hidden");
    expect(valueText("characters", "A long line of text that goes on and on")).toBe(
      "“A long line of text tha…”",
    );
    expect(valueText("effects", [])).toBe("none");
  });
});
