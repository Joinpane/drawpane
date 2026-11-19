/** Which of a copy's values layout decides (decision 0035, item 7): each case on its own. */
import { describe, expect, it } from "vitest";
import {
  boundaryDrivenProps,
  constrainedValues,
  heldNodeIds,
  laidOutProps,
  type NodeRecord,
  type Props,
} from "../src/index";

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

  it("follows constraints only in a frame the copy resized, where it's what they derive", () => {
    const main = layer("frame", { width: 100, height: 40 });
    const wider = layer("frame", { width: 160, height: 40 });
    const source = (constraintH: string) =>
      layer("rect", { x: 10, width: 20, height: 20, constraintH });
    // The copy where its constraint puts it in the wider frame (main layer at 10, 20 wide).
    const placed: Record<string, { x: number; width: number }> = {
      start: { x: 10, width: 20 },
      end: { x: 70, width: 20 },
      center: { x: 40, width: 20 },
      stretch: { x: 10, width: 80 },
      scale: { x: 16, width: 32 },
    };
    const copy = (constraintH: string, dx = 0, dw = 0) =>
      layer("rect", {
        x: (placed[constraintH]?.x ?? 0) + dx,
        width: (placed[constraintH]?.width ?? 0) + dw,
        height: 20,
        constraintH,
      });
    const at = (child: NodeRecord, from: NodeRecord, parent: NodeRecord) =>
      sorted(laidOutProps(child, from, { root: false, parent, parentSource: main }));
    expect(at(copy("start"), source("start"), wider)).toEqual([]);
    expect(at(copy("end"), source("end"), wider)).toEqual(["x"]);
    expect(at(copy("center"), source("center"), wider)).toEqual(["x"]);
    expect(at(copy("stretch"), source("stretch"), wider)).toEqual(["width", "x"]);
    expect(at(copy("scale"), source("scale"), wider)).toEqual(["width", "x"]);
    // Moved or resized on top of what the constraint gives: a person's change (review 8, B1).
    expect(at(copy("end", 30), source("end"), wider)).toEqual([]);
    expect(at(copy("center", -5), source("center"), wider)).toEqual([]);
    expect(at(copy("stretch", 0, 30), source("stretch"), wider)).toEqual(["x"]);
    expect(at(copy("scale", 30), source("scale"), wider)).toEqual(["width"]);
    // Within the tolerance Figma's saved decimals need.
    expect(at(copy("end", 0.004), source("end"), wider)).toEqual(["x"]);
    // Same size as its main's frame: a moved child moved on purpose.
    expect(at(copy("scale"), source("scale"), main)).toEqual([]);
  });
});

describe("constrainedValues", () => {
  const parent = (width: number, props: Record<string, unknown> = {}) =>
    layer("frame", { width, height: 40, ...props });
  const child = (constraintH: string, x = 70, width = 20) =>
    layer("rect", { x, width, height: 20, constraintH });

  it("moves an end-pinned or centred child by its frame's growth from its main layer's place", () => {
    // The copy's own (stale) place doesn't matter: it's derived from the main layer's.
    expect(constrainedValues(child("end", 150), child("end"), parent(200), parent(100))).toEqual({
      x: 170,
    });
    expect(
      constrainedValues(child("center", 0), child("center", 40), parent(200), parent(100)),
    ).toEqual({ x: 90 });
  });

  it("stretches and scales sizes too, and leaves a start-pinned child alone", () => {
    expect(
      constrainedValues(child("stretch"), child("stretch", 10, 80), parent(200), parent(100)),
    ).toEqual({ x: 10, width: 180 });
    expect(
      constrainedValues(child("scale"), child("scale", 10, 20), parent(200), parent(100)),
    ).toEqual({ x: 20, width: 40 });
    expect(constrainedValues(child("start"), child("start"), parent(200), parent(100))).toEqual({});
  });

  it("gives nothing for a frame of the same size, or one auto layout places children in", () => {
    expect(constrainedValues(child("end"), child("end"), parent(100), parent(100))).toEqual({});
    const flow = { layoutMode: "row" };
    expect(
      constrainedValues(child("end"), child("end"), parent(200, flow), parent(100, flow)),
    ).toEqual({});
  });
});

describe("component property values (decision 0035, item 3)", () => {
  it("keeps the fields an outer property drives at a swap, but not the swap itself", () => {
    expect(
      boundaryDrivenProps(layer("frame", { propRefs: { visible: "a", instanceOf: "b" } })),
    ).toEqual(["visible"]);
  });

  it("lists the components a swap definition names", () => {
    expect(
      heldNodeIds({
        componentProps: [
          { id: "a", name: "Icon", type: "instance", default: "main1", preferred: ["main2"] },
          { id: "b", name: "Label", type: "text", default: "Go" },
        ],
      } as Props).others,
    ).toEqual(["main1", "main2"]);
  });
});
