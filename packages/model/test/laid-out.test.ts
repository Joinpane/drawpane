/** Which of a copy's values layout decides (decision 0035, item 7): each case on its own. */
import { describe, expect, it } from "vitest";
import { laidOutProps, type NodeRecord, type Props } from "../src/index";

const layer = (type: NodeRecord["type"], props: Record<string, unknown> = {}): NodeRecord => ({
  id: "x",
  type,
  parent: "p",
  key: "a0",
  props: props as Props,
});
const sorted = (set: Set<string>) => [...set].sort();

describe("laidOutProps", () => {
  it("leaves an instance its place, and its size where it or its main fills", () => {
    const main = layer("frame", { width: 100 });
    expect(sorted(laidOutProps(layer("frame", { width: 100 }), main, { root: true }))).toEqual([
      "x",
      "y",
    ]);
    expect(
      sorted(laidOutProps(layer("frame", { sizingH: "fill", width: 300 }), main, { root: true })),
    ).toEqual(["sizingH", "width", "x", "y"]);
  });

  it("gives an instance that hugs, or whose main hugs, its own size on that axis", () => {
    const main = layer("frame", { sizingV: "hug" });
    expect(sorted(laidOutProps(layer("frame", { sizingV: "hug" }), main, { root: true }))).toEqual([
      "height",
      "x",
      "y",
    ]);
  });

  it("leaves auto layout its children's places, and the sizes that hug or fill", () => {
    const row = layer("frame", { layoutMode: "row" });
    const fixed = layer("rect", { width: 10 });
    expect(
      sorted(laidOutProps(fixed, fixed, { root: false, parent: row, parentSource: row })),
    ).toEqual(["x", "y"]);
    const fill = layer("rect", { sizingH: "fill" });
    expect(
      sorted(laidOutProps(fill, fill, { root: false, parent: row, parentSource: row })),
    ).toEqual(["width", "x", "y"]);
    // Placed absolutely, it keeps its place.
    const absolute = layer("rect", { positioning: "absolute" });
    expect(
      sorted(laidOutProps(absolute, absolute, { root: false, parent: row, parentSource: row })),
    ).toEqual([]);
  });

  it("lets auto-sized text measure itself", () => {
    const grows = layer("text", { textAutoResize: "width" });
    expect(sorted(laidOutProps(grows, grows, { root: false }))).toEqual(["height", "width"]);
    const wraps = layer("text", { textAutoResize: "height" });
    expect(sorted(laidOutProps(wraps, wraps, { root: false }))).toEqual(["height"]);
    const fixed = layer("text", { textAutoResize: "none" });
    expect(sorted(laidOutProps(fixed, fixed, { root: false }))).toEqual([]);
  });

  it("follows constraints only in a frame the copy resized", () => {
    const main = layer("frame", { width: 100, height: 40 });
    const wider = layer("frame", { width: 160, height: 40 });
    const pinned = (constraintH: string) => layer("rect", { constraintH, constraintV: "end" });
    const at = (child: NodeRecord, parent: NodeRecord) =>
      sorted(laidOutProps(child, child, { root: false, parent, parentSource: main }));
    expect(at(pinned("start"), wider)).toEqual([]);
    expect(at(pinned("end"), wider)).toEqual(["x"]);
    expect(at(pinned("center"), wider)).toEqual(["x"]);
    expect(at(pinned("stretch"), wider)).toEqual(["width", "x"]);
    expect(at(pinned("scale"), wider)).toEqual(["width", "x"]);
    // Same size as its main's frame: a moved child moved on purpose.
    expect(at(pinned("scale"), main)).toEqual([]);
  });
});
