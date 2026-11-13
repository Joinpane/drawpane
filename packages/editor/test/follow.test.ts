import type { Peer, Presence } from "@drawpane/model";
import { ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import { Editor } from "../src/editor";

function setup() {
  const editor = new Editor({ measurer: { width: () => 0 }, clientId: "t" });
  editor.state.set({
    role: "editor",
    viewport: { width: 1000, height: 600 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  editor.doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
    { op: "create", id: "p2", type: "page", parent: ROOT_ID, key: "a1", props: {} },
  ]);
  editor.setPage("p1");
  return editor;
}

const peer = (presence: Partial<Presence> | null): Peer => ({
  sessionId: "lena",
  userId: "u-lena",
  name: "Lena Park",
  color: 2,
  kind: "person",
  presence: presence ? { cursor: null, pageId: "p1", selection: [], ...presence } : null,
});

/** What the follower shows of the page, in page coordinates. */
const shown = (editor: Editor) => {
  const v = editor.presence(null).viewport;
  return (
    v && {
      x: Math.round(v.x),
      y: Math.round(v.y),
      width: Math.round(v.width),
      height: Math.round(v.height),
    }
  );
};

describe("following", () => {
  it("shows the leader's page and the area they see", () => {
    const editor = setup();
    editor.state.set({
      peers: new Map([
        ["lena", peer({ pageId: "p2", viewport: { x: 100, y: 50, width: 500, height: 300 } })],
      ]),
    });
    editor.follow("lena");
    expect(editor.s.following).toBe("lena");
    expect(editor.s.pageId).toBe("p2");
    // Their 500 × 300 area at twice the size fills a 1000 × 600 screen exactly.
    expect(editor.s.camera.zoom).toBeCloseTo(2, 6);
    expect(shown(editor)).toEqual({ x: 100, y: 50, width: 500, height: 300 });
  });

  it("stops when you move the view, edit, change page, or the leader leaves", () => {
    const editor = setup();
    const peers = new Map([["lena", peer({ viewport: { x: 0, y: 0, width: 100, height: 100 } })]]);
    editor.state.set({ peers });
    editor.follow("lena");
    editor.setCamera(new Camera(10, 10, 1));
    expect(editor.s.following).toBeNull();

    editor.follow("lena");
    editor.commit([{ op: "create", id: "r", type: "rect", parent: "p1", key: "a0", props: {} }]);
    expect(editor.s.following).toBeNull();

    editor.follow("lena");
    editor.setPage("p2");
    expect(editor.s.following).toBeNull();
  });

  it("tells you when the leader leaves", () => {
    const editor = setup();
    // Lena arrives and moves, through the sync engine like a real room.
    editor.sync.receive({
      t: "peer",
      peer: peer({ viewport: { x: 0, y: 0, width: 200, height: 200 } }),
    });
    editor.follow("lena");
    expect(editor.s.following).toBe("lena");
    editor.sync.receive({ t: "peer-left", sessionId: "lena" });
    expect(editor.s.following).toBeNull();
    expect(editor.s.notice?.text).toBe("Lena Park left the file, so you stopped following.");
  });

  it("sends what's on screen, who you follow and whether you spotlight", () => {
    const editor = setup();
    editor.state.set({ insets: { top: 60, right: 276, bottom: 56, left: 276 } });
    editor.setSpotlight(true);
    const p = editor.presence({ x: 1, y: 2 });
    expect(p).toMatchObject({
      cursor: { x: 1, y: 2 },
      pageId: "p1",
      spotlight: true,
      following: null,
    });
    // Only the part between the panes.
    expect(p.viewport).toEqual({ x: 276, y: 60, width: 448, height: 484 });
  });
});
