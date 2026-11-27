/**
 * Uncommitted touch interaction rollback, sync hold scoping, and desktop cancel
 * semantics: verifies that held touch drags revert cleanly without affecting
 * undo/redo, collaborators, or unrelated mid-hold edits, and pins desktop Escape
 * behavior for resize handles and image cropping.
 */
import { type ClientMessage, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor";
import { Interaction, type PointerInput } from "../src/interaction";

function setupConnected() {
  const sent: ClientMessage[] = [];
  const editor = new Editor({
    measurer: { width: (_f, t) => t.length * 8 },
    clientId: "touch-test",
  });
  editor.state.set({ viewport: { width: 1200, height: 800 } });
  editor.sync.connected((msg) => sent.push(msg));
  editor.sync.receive({
    t: "welcome",
    sessionId: "s1",
    role: "editor",
    revn: 1,
    lastSeq: 0,
    mode: "snapshot",
    copies: "materialized",
    peers: [],
  });
  editor.sync.receive({
    t: "snapshot",
    done: true,
    nodes: [{ id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} }],
  });
  editor.setPage("p");
  const ix = new Interaction(editor);
  const txns = () => sent.filter((m) => m.t === "txn") as Extract<ClientMessage, { t: "txn" }>[];
  return { editor, ix, sent, txns };
}

const at = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  screen: { x, y },
  button: 0,
  shift: false,
  alt: false,
  mod: false,
  clicks: 1,
  coarse: true,
  ...extra,
});

function beginHeldTouchDrag(
  editor: Editor,
  ix: Interaction,
  start: PointerInput,
  cur: PointerInput,
) {
  const prevSelection = editor.s.selection;
  const prevHistoryDepth = editor.history.groupDepth;
  const nestedMark = prevHistoryDepth > 0;
  if (nestedMark) editor.history.begin("Touch stroke", prevSelection);
  editor.sync.beginHold();
  editor.sync.withHeld(() => {
    ix.down(start);
    ix.move(cur);
  });
  return { prevSelection, prevHistoryDepth, nestedMark };
}

function rollbackHeldTouchDrag(
  editor: Editor,
  ix: Interaction,
  session: { prevSelection: readonly string[]; prevHistoryDepth: number },
) {
  ix.rollback();
  while (editor.history.groupDepth > session.prevHistoryDepth) editor.dropGesture();
  editor.sync.discardHold();
  editor.select(session.prevSelection.filter((id) => editor.doc.has(id)));
  editor.state.set({
    gesture: editor.history.grouping,
    guides: [],
    marquee: null,
    guideDraft: null,
  });
}

describe("held touch rollback and SyncEngine hold scoping", () => {
  it("rolls back a mid-drag move with zero document change, zero undo entries, and zero sent txns", () => {
    const { editor, ix, txns } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    editor.sync.flush();
    const sentBefore = txns().length;
    const undoBefore = editor.history.undoDepth;
    const redoBefore = editor.history.redoDepth;

    const session = beginHeldTouchDrag(editor, ix, at(180, 150), at(240, 190));
    editor.sync.withHeld(() => ix.move(at(310, 240)));
    expect((editor.doc.get(id) as NodeRecord).props.x).not.toBe(100);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    const props = (editor.doc.get(id) as NodeRecord).props;
    expect([props.x, props.y, props.width, props.height]).toEqual([100, 100, 160, 100]);
    expect(editor.s.selection).toEqual([id]);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(editor.history.redoDepth).toBe(redoBefore);
    expect(editor.s.gesture).toBe(false);
    expect(txns().length).toBe(sentBefore);
    expect(editor.sync.holding).toBe(false);
  });

  it("rolls back a mid-drag resize over a selection handle without shrinking the layer", () => {
    const { editor, ix, txns } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    editor.sync.flush();
    const sentBefore = txns().length;
    const undoBefore = editor.history.undoDepth;

    const session = beginHeldTouchDrag(editor, ix, at(260, 150), at(183, 150));
    expect((editor.doc.get(id) as NodeRecord).props.width).toBe(83);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    const props = (editor.doc.get(id) as NodeRecord).props;
    expect([props.x, props.y, props.width, props.height]).toEqual([100, 100, 160, 100]);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(editor.history.redoDepth).toBe(0);
    expect(txns().length).toBe(sentBefore);
  });

  it("rolls back a mid-drag shape draw without leaving a stray node or undo entry", () => {
    const { editor, ix, txns } = setupConnected();
    const existing = editor.createLayer(
      "rect",
      { x: 50, y: 50, width: 80, height: 80 },
      "p",
    ) as string;
    editor.select([existing]);
    editor.setTool("rect");
    editor.sync.flush();
    const sentBefore = txns().length;
    const undoBefore = editor.history.undoDepth;
    const childrenBefore = editor.doc.childIds("p").length;

    const session = beginHeldTouchDrag(editor, ix, at(300, 200), at(420, 320));
    expect(editor.doc.childIds("p").length).toBe(childrenBefore + 1);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    expect(editor.doc.childIds("p").length).toBe(childrenBefore);
    expect(editor.s.selection).toEqual([existing]);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(txns().length).toBe(sentBefore);
  });

  it("preserves remote collaborator transactions received during a rolled-back touch drag", () => {
    const { editor, ix, txns } = setupConnected();
    const a = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    const b = editor.createLayer(
      "rect",
      { x: 400, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    editor.select([a]);
    editor.sync.flush();
    editor.sync.receive({ t: "ack", seq: 1, revn: 2 });
    const sentBefore = txns().length;

    const session = beginHeldTouchDrag(editor, ix, at(150, 150), at(250, 150));
    editor.sync.receive({
      t: "txn",
      revn: 3,
      author: { userId: "u2", sessionId: "s2" },
      ops: [{ op: "set", id: b, prop: "x", value: 520 }],
    });
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(200);
    expect((editor.doc.get(b) as NodeRecord).props.x).toBe(520);

    rollbackHeldTouchDrag(editor, ix, session);

    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect((editor.doc.get(b) as NodeRecord).props.x).toBe(520);
    expect(txns().length).toBe(sentBefore);
  });

  it("exercises SyncEngine discardHold hasNonHeldAfter rebase and flushes preserved edits", () => {
    const { editor, txns } = setupConnected();
    const a = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    const b = editor.createLayer(
      "rect",
      { x: 400, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    editor.sync.flush();
    const sentBefore = txns().length;

    editor.sync.beginHold();
    editor.sync.withHeld(() => editor.sync.commit([{ op: "set", id: a, prop: "x", value: 250 }]));
    // Non-held commit arrives after the held commit (e.g. font refit or undo).
    editor.sync.commit([{ op: "set", id: b, prop: "y", value: 333 }]);
    // Further held commit interleaved after the non-held commit.
    editor.sync.withHeld(() => editor.sync.commit([{ op: "set", id: a, prop: "x", value: 290 }]));
    editor.sync.flush();
    expect(txns().length).toBe(sentBefore);

    expect(editor.sync.discardHold()).toBe(true);
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect((editor.doc.get(b) as NodeRecord).props.y).toBe(333);
    // Preserved non-held edit flushed immediately on discardHold.
    expect(txns().length).toBe(sentBefore + 1);
    expect(txns().at(-1)?.ops).toEqual([{ op: "set", id: b, prop: "y", value: 333 }]);
  });

  it("rolls back only the uncommitted anchor of an in-progress pen path", () => {
    const { editor, ix, txns } = setupConnected();
    editor.setTool("pen");
    ix.down(at(100, 100));
    ix.up(at(100, 100));
    ix.down(at(200, 100));
    ix.up(at(200, 100));
    editor.sync.flush();
    const sentBefore = txns().length;
    expect(ix.pen.preview()?.anchors.length).toBe(2);

    const session = beginHeldTouchDrag(editor, ix, at(300, 200), at(340, 220));
    expect(ix.pen.preview()?.anchors.length).toBe(3);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    expect(ix.pen.preview()?.anchors.length).toBe(2);
    expect(editor.history.groupDepth).toBe(1);
    expect(txns().length).toBe(sentBefore);
  });

  it("widens handle hit zones for coarse touch drags while skipping handles on taps", () => {
    const { editor, ix } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    const tiny = editor.createLayer(
      "rect",
      { x: 264, y: 145, width: 5, height: 10 },
      "p",
    ) as string;
    editor.select([id]);
    // 9 px outside east handle at (260, 150): missed by mouse (6 px), hit by coarse touch (12 px).
    expect(ix.handleAt({ x: 269, y: 150 }, false)).toBeNull();
    expect(ix.handleAt({ x: 269, y: 150 }, true)).toEqual({ handle: "e", rotate: false });

    // At 50% zoom, tapping `tiny` with `skipHandles: true` selects `tiny` instead of grabbing the handle.
    editor.zoomTo(0.5);
    const tinyScreen = editor.s.camera.toScreen({ x: 266.5, y: 150 });
    ix.down(at(tinyScreen.x, tinyScreen.y, { coarse: false, skipHandles: true }));
    ix.up(at(tinyScreen.x, tinyScreen.y, { coarse: false, skipHandles: true }));
    expect(editor.s.selection).toEqual([tiny]);
  });

  it("rolls back a vector-edit anchor drag and restores prior anchor selection", () => {
    const { editor, ix, txns } = setupConnected();
    const id = editor.createLayer("path", { x: 100, y: 100, width: 100, height: 100 }, "p", {
      pathData: "M0 0L100 0L100 100Z",
    }) as string;
    expect(editor.enterVectorEdit(id)).toBe(true);
    editor.selectAnchors(["0:0"]);
    editor.sync.flush();
    const sentBefore = txns().length;
    const undoBefore = editor.history.undoDepth;
    const beforePath = (editor.doc.get(id) as NodeRecord).props.pathData;

    const session = beginHeldTouchDrag(editor, ix, at(200, 100), at(260, 140));
    expect((editor.doc.get(id) as NodeRecord).props.pathData).not.toBe(beforePath);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    expect((editor.doc.get(id) as NodeRecord).props.pathData).toBe(beforePath);
    expect(editor.s.vectorEdit?.anchors).toEqual(["0:0"]);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(txns().length).toBe(sentBefore);
  });
});

describe("desktop Escape cancel semantics", () => {
  const mouse = (x: number, y: number): PointerInput => at(x, y, { coarse: false });

  it("keeps the previous edit when pressing Escape right after pressing a resize handle without moving", () => {
    const { editor, ix } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.setProp([id], "opacity", 0.5);
    editor.select([id]);

    ix.down(mouse(260, 150)); // press east handle without moving
    ix.cancel();

    expect((editor.doc.get(id) as NodeRecord).props.opacity).toBe(0.5);
    expect(editor.history.redoDepth).toBe(0);
    expect(editor.s.gesture).toBe(false);
  });

  it("reverts an in-progress resize on Escape without leaving a redo entry", () => {
    const { editor, ix } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    const undoBefore = editor.history.undoDepth;

    ix.down(mouse(260, 150));
    ix.move(mouse(320, 150));
    expect((editor.doc.get(id) as NodeRecord).props.width).toBe(220);

    ix.cancel();

    expect((editor.doc.get(id) as NodeRecord).props.width).toBe(160);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(editor.history.canRedo).toBe(false);
    expect(editor.s.gesture).toBe(false);
  });

  it("reverts an active crop drag on Escape while staying in crop mode, and commits on Enter", () => {
    const editor = new Editor({ measurer: { width: () => 0 }, clientId: "crop-escape" });
    editor.state.set({ role: "editor", viewport: { width: 1000, height: 800 } });
    editor.imageSize = () => ({ width: 2000, height: 1000 });
    editor.doc.apply([
      { op: "create", id: "p", type: "page", parent: ROOT_ID, key: "a0", props: {} },
      {
        op: "create",
        id: "photo",
        type: "rect",
        parent: "p",
        key: "a0",
        props: {
          x: 100,
          y: 100,
          width: 200,
          height: 200,
          fills: [{ type: "image", ref: "a".repeat(64), scaleMode: "fill" }],
        },
      },
    ]);
    editor.setPage("p");
    const ix = new Interaction(editor);
    editor.select(["photo"]);
    editor.enterCrop("photo");
    const undoBefore = editor.history.undoDepth;

    // Start dragging the right crop handle inward, then press Escape:
    // matches Figma by reverting the active drag while remaining in crop mode.
    ix.down(mouse(300, 200));
    ix.move(mouse(250, 200));
    expect((editor.doc.get("photo") as NodeRecord).props.width).toBe(150);

    expect(ix.key({ key: "Escape", shift: false, alt: false, mod: false })).toBe(true);
    expect((editor.doc.get("photo") as NodeRecord).props.width).toBe(200);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(editor.history.canRedo).toBe(false);
    expect(editor.s.gesture).toBe(false);
    expect(editor.s.cropping).toEqual({ id: "photo", index: 0 });

    // A second Escape (when idle in crop mode) exits crop mode.
    expect(ix.key({ key: "Escape", shift: false, alt: false, mod: false })).toBe(true);
    expect(editor.s.cropping).toBeNull();

    // Enter while dragging commits the crop drag and exits crop mode.
    editor.enterCrop("photo");
    ix.down(mouse(300, 200));
    ix.move(mouse(260, 200));
    expect(ix.key({ key: "Enter", shift: false, alt: false, mod: false })).toBe(true);
    expect((editor.doc.get("photo") as NodeRecord).props.width).toBe(160);
    expect(editor.s.cropping).toBeNull();
    expect(editor.s.gesture).toBe(false);

    // Direct interaction.cancel() mid-crop drag also reverts cleanly.
    editor.enterCrop("photo");
    ix.down(mouse(260, 200));
    ix.move(mouse(220, 200));
    expect((editor.doc.get("photo") as NodeRecord).props.width).toBe(120);
    ix.cancel();
    expect((editor.doc.get("photo") as NodeRecord).props.width).toBe(160);
    expect(editor.history.canRedo).toBe(false);
  });
});
