/**
 * Uncommitted touch interaction rollback: verifies that when a second finger
 * interrupts an in-progress touch move, resize, draw, pen stroke, vector edit,
 * or crop, the document, undo/redo stacks, selection, and collaborator sync
 * stream are completely unchanged.
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
  const txns = () => sent.filter((m) => m.t === "txn");
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
  ix.down(start);
  ix.move(cur);
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

describe("held touch rollback", () => {
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
    ix.move(at(310, 240));
    // Live local preview moved, but nothing flushed to collaborators while held.
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

    // Grab the east handle at (260, 150) and pull inward to 83 px wide, then roll back.
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
    // Acknowledge our setup transaction so revn advances to 2.
    editor.sync.receive({ t: "ack", seq: 1, revn: 2 });
    const sentBefore = txns().length;

    const session = beginHeldTouchDrag(editor, ix, at(150, 150), at(250, 150));
    // A teammate moves `b` while our touch drag is held locally.
    editor.sync.receive({
      t: "txn",
      revn: 3,
      author: { userId: "u2", sessionId: "s2" },
      ops: [{ op: "set", id: b, prop: "x", value: 520 }],
    });
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(200);
    expect((editor.doc.get(b) as NodeRecord).props.x).toBe(520);

    rollbackHeldTouchDrag(editor, ix, session);

    // Our local drag reverted, while the teammate's move stays intact.
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect((editor.doc.get(b) as NodeRecord).props.x).toBe(520);
    expect(txns().length).toBe(sentBefore);
  });

  it("rolls back only the uncommitted anchor of an in-progress pen path", () => {
    const { editor, ix, txns } = setupConnected();
    editor.setTool("pen");
    // Place two committed anchors first.
    ix.down(at(100, 100));
    ix.up(at(100, 100));
    ix.down(at(200, 100));
    ix.up(at(200, 100));
    editor.sync.flush();
    const sentBefore = txns().length;
    expect(ix.pen.preview()?.anchors.length).toBe(2);

    // Start dragging a third anchor, then roll back on second finger.
    const session = beginHeldTouchDrag(editor, ix, at(300, 200), at(340, 220));
    expect(ix.pen.preview()?.anchors.length).toBe(3);
    expect(txns().length).toBe(sentBefore);

    rollbackHeldTouchDrag(editor, ix, session);

    expect(ix.pen.preview()?.anchors.length).toBe(2);
    expect(editor.history.groupDepth).toBe(1);
    expect(txns().length).toBe(sentBefore);
  });

  it("widens handle hit zones only for coarse touch input, leaving mouse precision unchanged", () => {
    const { editor, ix } = setupConnected();
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    // 9 px outside the east handle at (260, 150): missed by mouse (6 px), hit by coarse touch (12 px).
    expect(ix.handleAt({ x: 269, y: 150 }, false)).toBeNull();
    expect(ix.handleAt({ x: 269, y: 150 }, true)).toEqual({ handle: "e", rotate: false });
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

    // Grab anchor 1 at screen (200, 100) and drag it to (260, 140), then roll back on second finger.
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
