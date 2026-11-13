import { Doc, Scene } from "@drawpane/editor";
import { ROOT_ID } from "@drawpane/model";
import { beforeEach, describe, expect, it } from "vitest";
import { anchorAt, anchorLabel, resolveAnchor } from "./anchor";

function makeScene() {
  const doc = new Doc();
  doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: { name: "Page 1" } },
    { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: { name: "Page 2" } },
    {
      op: "create",
      id: "board",
      type: "frame",
      parent: "p1",
      key: "a0",
      props: { name: "Home — iOS", x: 100, y: 100, width: 200, height: 200 },
    },
    {
      op: "create",
      id: "hero",
      type: "rect",
      parent: "board",
      key: "a0",
      props: { name: "Hero card", x: 20, y: 30, width: 50, height: 40 },
    },
  ]);
  return { doc, scene: new Scene(doc) };
}

describe("comment anchors", () => {
  let doc: Doc;
  let scene: Scene;
  beforeEach(() => {
    ({ doc, scene } = makeScene());
  });

  it("pins to the deepest layer under the point, with an offset in its local box", () => {
    const anchor = anchorAt(scene, "p1", { x: 130, y: 140 });
    expect(anchor).toEqual({ x: 130, y: 140, nodeId: "hero", offset: { x: 10, y: 10 } });
    expect(anchorLabel(scene, anchor, "p1")).toBe("Hero card · Home — iOS");
  });

  it("pins to the board when the point misses its children", () => {
    const anchor = anchorAt(scene, "p1", { x: 250, y: 250 });
    expect(anchor).toMatchObject({ nodeId: "board", offset: { x: 150, y: 150 } });
    expect(anchorLabel(scene, anchor, "p1")).toBe("Home — iOS · Page 1");
  });

  it("stays on the page when nothing is under the point", () => {
    const anchor = anchorAt(scene, "p1", { x: -40.123, y: 12.567 });
    expect(anchor).toEqual({ x: -40.12, y: 12.57, nodeId: null, offset: null });
    expect(resolveAnchor(scene, anchor, "p1")).toEqual({
      pageId: "p1",
      point: { x: -40.12, y: 12.57 },
      attached: true,
    });
    expect(anchorLabel(scene, anchor, "p1")).toBe("Page 1");
  });

  it("follows its layer when the layer or its parent moves", () => {
    const anchor = anchorAt(scene, "p1", { x: 130, y: 140 });
    doc.apply([{ op: "set", id: "board", prop: "x", value: 150 }]);
    expect(resolveAnchor(scene, anchor, "p1").point).toEqual({ x: 180, y: 140 });
    doc.apply([{ op: "set", id: "hero", prop: "y", value: 0 }]);
    expect(resolveAnchor(scene, anchor, "p1").point).toEqual({ x: 180, y: 110 });
  });

  it("turns with its layer when the layer rotates", () => {
    const anchor = anchorAt(scene, "p1", { x: 120, y: 130 });
    expect(anchor.offset).toEqual({ x: 0, y: 0 });
    // A 90° turn about the centre (145, 150) carries the top-left corner to the top-right.
    doc.apply([{ op: "set", id: "hero", prop: "rotation", value: 90 }]);
    const { point } = resolveAnchor(scene, anchor, "p1");
    expect(point.x).toBeCloseTo(165);
    expect(point.y).toBeCloseTo(125);
  });

  it("moves to another page with its layer", () => {
    const anchor = anchorAt(scene, "p1", { x: 130, y: 140 });
    doc.apply([{ op: "move", id: "board", parent: "p2", key: "a0" }]);
    expect(resolveAnchor(scene, anchor, "p1")).toMatchObject({ pageId: "p2", attached: true });
  });

  it("falls back to its page point when the layer is deleted", () => {
    const anchor = anchorAt(scene, "p1", { x: 130, y: 140 });
    doc.apply([{ op: "set", id: "board", prop: "x", value: 400 }]);
    doc.apply([{ op: "delete", id: "hero" }]);
    expect(resolveAnchor(scene, anchor, "p1")).toEqual({
      pageId: "p1",
      point: { x: 130, y: 140 },
      attached: false,
    });
    expect(anchorLabel(scene, anchor, "p1")).toBe("Page 1");
  });

  it("ignores hidden and locked layers", () => {
    doc.apply([{ op: "set", id: "hero", prop: "locked", value: true }]);
    expect(anchorAt(scene, "p1", { x: 130, y: 140 }).nodeId).toBe("board");
    doc.apply([{ op: "set", id: "board", prop: "visible", value: false }]);
    expect(anchorAt(scene, "p1", { x: 130, y: 140 }).nodeId).toBeNull();
  });
});
