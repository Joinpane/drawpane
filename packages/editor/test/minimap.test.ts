import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { fromMinimap, minimapFit, minimapModel, toMinimap } from "../src/minimap";

function setup() {
  const editor = new Editor({ measurer: { width: (_f, t) => t.length * 6 }, clientId: "t" });
  editor.state.set({ role: "editor" });
  editor.doc.apply([
    { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    { op: "create", id: "q", type: "page", parent: ROOT_ID, key: "a1", props: {} },
  ]);
  editor.setPage("p");
  editor.setViewport(1200, 800);
  const home = editor.createLayer("frame", { x: 0, y: 0, width: 400, height: 800 }, "p") as string;
  const settings = editor.createLayer("frame", { x: 500, y: 0, width: 400, height: 800 }, "p", {
    visible: false,
  }) as string;
  const note = editor.createLayer("rect", { x: 0, y: 900, width: 100, height: 40 }, "p") as string;
  // Inside a board: not drawn on its own.
  editor.createLayer("rect", { x: 20, y: 20, width: 50, height: 50 }, home);
  return { editor, home, settings, note };
}

describe("minimap model", () => {
  it("shows the page's top-level layers, counting boards and marking hidden ones", () => {
    const { editor, home, settings, note } = setup();
    const model = minimapModel(editor);
    expect(model?.layers.map((l) => [l.id, l.board, l.hidden])).toEqual([
      [home, true, false],
      [settings, true, true],
      [note, false, false],
    ]);
    expect(model?.boards).toBe(2);
  });

  it("covers the layers and the visible area together, so the view is never off the map", () => {
    const { editor } = setup();
    editor.state.set({ insets: { top: 60, right: 276, bottom: 56, left: 276 } });
    editor.centerOn({ x: 5000, y: 5000 });
    const model = minimapModel(editor);
    if (!model) throw new Error("no model");
    const view = editor.visibleArea();
    expect(model.view).toEqual(view);
    // The view is centred on the point, in the area the panes don't cover.
    expect((view?.x ?? 0) + (view?.width ?? 0) / 2).toBeCloseTo(5000);
    expect((view?.y ?? 0) + (view?.height ?? 0) / 2).toBeCloseTo(5000);
    expect(model.bounds.x).toBe(0);
    expect(model.bounds.x + model.bounds.width).toBeGreaterThan(5000);
  });

  it("shows where people on this page are pointing, and no one elsewhere", () => {
    const { editor } = setup();
    const peer = (sessionId: string, pageId: string, kind: "person" | "agent" = "person") => [
      sessionId,
      {
        sessionId,
        userId: sessionId,
        name: sessionId,
        color: 3,
        kind,
        presence: {
          cursor: { x: 120, y: 340 },
          pageId,
          selection: [],
          viewport: null,
          following: null,
          spotlight: false,
        },
      },
    ];
    editor.state.set({
      // biome-ignore lint/suspicious/noExplicitAny: a test's hand-made peers.
      peers: new Map([peer("lena", "p"), peer("bo", "q"), peer("agent", "p", "agent")] as any),
    });
    const model = minimapModel(editor);
    expect(model?.peers.map((p) => [p.sessionId, p.at, p.agent])).toEqual([
      ["lena", { x: 120, y: 340 }, false],
      ["agent", { x: 120, y: 340 }, true],
    ]);
  });

  it("keeps people on the map far from the content, and where they look when their pointer is off the canvas", () => {
    const { editor } = setup();
    const peer = (sessionId: string, cursor: { x: number; y: number } | null) => [
      sessionId,
      {
        sessionId,
        userId: sessionId,
        name: sessionId,
        color: 2,
        kind: "person",
        presence: {
          cursor,
          pageId: "p",
          selection: [],
          viewport: { x: 1000, y: 2000, width: 400, height: 200 },
          following: null,
          spotlight: false,
        },
      },
    ];
    editor.state.set({
      // biome-ignore lint/suspicious/noExplicitAny: a test's hand-made peers.
      peers: new Map([peer("far", { x: 5880, y: 3948 }), peer("panel", null)] as any),
    });
    const model = minimapModel(editor);
    if (!model) throw new Error("no model");
    expect(model.peers.map((p) => [p.sessionId, p.at, p.pointing])).toEqual([
      ["far", { x: 5880, y: 3948 }, true],
      ["panel", { x: 1200, y: 2100 }, false],
    ]);
    const b = model.bounds;
    expect(b.x + b.width).toBeGreaterThanOrEqual(5880);
    expect(b.y + b.height).toBeGreaterThanOrEqual(3948);
  });
});

describe("minimap fit", () => {
  it("fits and centres the bounds in the box, and maps points both ways", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 400 };
    const fit = minimapFit(bounds, 160, 72, 6);
    // Width-limited: 148 / 1000.
    expect(fit.scale).toBeCloseTo(0.148);
    const centre = toMinimap(fit, { x: 500, y: 200 });
    expect(centre.x).toBeCloseTo(80);
    expect(centre.y).toBeCloseTo(36);
    const back = fromMinimap(fit, toMinimap(fit, { x: 123, y: 45 }));
    expect(back.x).toBeCloseTo(123);
    expect(back.y).toBeCloseTo(45);
  });
});
