import { Camera, Editor } from "@drawpane/editor";
import { type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { CompareView, changedBounds } from "./compare";

const measurer = { width: (_font: string, text: string) => text.length * 8 };

const node = (
  id: string,
  type: NodeRecord["type"],
  parent: string,
  key: string,
  props: Record<string, unknown> = {},
): NodeRecord => ({ id, type, parent, key, props }) as NodeRecord;

const PAGE = node("p1", "page", ROOT_ID, "a0", { name: "Page 1" });
const CARD = node("card", "rect", "p1", "a0", { x: 0, y: 0, width: 200, height: 100 });
const BADGE = node("badge", "rect", "p1", "a1", { x: 300, y: 0, width: 50, height: 20 });

function setup() {
  const branch = new Editor({ measurer, clientId: "b" });
  branch.loadStatic([PAGE, CARD, BADGE]);
  branch.setPage("p1");
  const view = new CompareView(branch, new Editor({ measurer, clientId: "m" }));
  view.load([PAGE, CARD]);
  return { branch, view };
}

describe("comparing a branch with main", () => {
  it("opens main on the branch's page", () => {
    const { view } = setup();
    expect(view.main.s.pageId).toBe("p1");
    expect(view.main.s.role).toBe("viewer");
  });

  it("moves the two views together, both ways, while linked", () => {
    const { branch, view } = setup();
    const unlink = view.link();
    branch.setCamera(new Camera(40, -20, 2));
    expect(view.main.s.camera).toMatchObject({ x: 40, y: -20, zoom: 2 });
    view.main.setCamera(new Camera(5, 6, 0.5));
    expect(branch.s.camera).toMatchObject({ x: 5, y: 6, zoom: 0.5 });
    unlink();
    branch.setCamera(new Camera(1, 1, 1));
    expect(view.main.s.camera).toMatchObject({ x: 5, y: 6, zoom: 0.5 });
  });

  it("keeps the swipe within the canvas", () => {
    const { view } = setup();
    view.setSwipe(1.4);
    expect(view.s.swipe).toBe(1);
    view.setSwipe(-1);
    expect(view.s.swipe).toBe(0);
  });

  it("frames the changes on the page in view", () => {
    const { branch } = setup();
    expect(changedBounds(branch, ["badge", "card", "gone"])).toEqual({
      x: 0,
      y: 0,
      width: 350,
      height: 100,
    });
    expect(changedBounds(branch, ["gone"])).toBeNull();
  });
});
