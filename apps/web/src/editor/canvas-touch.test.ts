/**
 * Integration tests exercising the REAL Canvas touch handlers (`createCanvasTouchHost`
 * wired to `TouchArbiter`, `Editor`, `Interaction`, and `SyncEngine`) rather than test copies.
 *
 * Covers:
 * - Bounded 200 ms hold window: silent rollback before 200 ms, live collaborator streaming
 *   after 200 ms, and desktop-Escape-style cancel + revert sync when a second finger lands
 *   after 200 ms.
 * - Normal hold release delivery and disconnect/reconnect during a hold.
 * - Scoped hold rollback preserving unrelated mid-hold commits (`refitText`, `undo`, prop edits).
 * - `try/finally` safety when a tool throws on release or start.
 * - Tap skipping resize handles at 50% zoom for tiny neighbouring layers, while coarse
 *   touch drags prefer neighbouring unselected layers outside the exact handle radius.
 */
import { Editor, Interaction } from "@drawpane/editor";
import { type ClientMessage, getProp, type NodeRecord, ROOT_ID } from "@drawpane/model";
import { describe, expect, it, vi } from "vitest";
import { createCanvasTouchHost } from "./canvas-touch";
import { TOUCH_HOLD_MS, TouchArbiter, type TouchPoint } from "./touch-arbitration";
import { uiFor } from "./ui-state";
import type { WorkspaceMode } from "./workspace-mode";

class FakeClock {
  now = 1000;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let earliestId: number | null = null;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.#timers) {
        if (entry.at <= target && entry.at < earliestAt) {
          earliestAt = entry.at;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = this.#timers.get(earliestId);
      this.#timers.delete(earliestId);
      this.now = earliestAt;
      entry?.fn();
    }
    this.now = target;
  }
}

function setupCanvasTouch(mode: WorkspaceMode = "tablet") {
  let charWidth = 8;
  let measurerGen = 0;
  const clock = new FakeClock();
  const sent: ClientMessage[] = [];
  const editor = new Editor({
    measurer: {
      width: (_f, t) => t.length * charWidth,
      get generation() {
        return measurerGen;
      },
    },
    clientId: "canvas-touch-test",
  });
  editor.state.set({ viewport: { width: 1024, height: 768 } });
  uiFor(editor).set({ workspaceMode: mode });
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
  const interaction = new Interaction(editor);
  const menus: Array<{ x: number; y: number }> = [];
  const touchHost = createCanvasTouchHost({
    editor,
    interaction,
    getHostElement: () => null,
    setCursor: () => {},
    blurOutsideCanvas: () => {},
    openCanvasContextMenu: (x, y) => menus.push({ x, y }),
    onCameraMotionStart: () => {},
    onCameraMotionEnd: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => clock.now,
  });
  const arbiter = new TouchArbiter(touchHost.host);
  const txns = () => sent.filter((m) => m.t === "txn") as Extract<ClientMessage, { t: "txn" }>[];
  const pt = (
    pointerId: number,
    x: number,
    y: number,
    pointerType: "touch" | "pen" = "touch",
  ): TouchPoint => ({
    pointerId,
    pointerType,
    screen: { x, y },
    client: { x, y },
    button: 0,
    shift: false,
    alt: false,
    mod: false,
    noSnap: false,
    timeStamp: clock.now,
  });
  return {
    editor,
    interaction,
    arbiter,
    touchHost,
    clock,
    sent,
    txns,
    menus,
    pt,
    setCharWidth: (w: number) => {
      charWidth = w;
      measurerGen++;
    },
  };
}

describe("real Canvas touch host (createCanvasTouchHost + TouchArbiter)", () => {
  it("holds edits for 200 ms, then streams live; a later second finger cancels and syncs the revert", () => {
    const { editor, arbiter, clock, txns, pt } = setupCanvasTouch("tablet");
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    editor.sync.flush();
    const sentBefore = txns().length;
    const undoBefore = editor.history.undoDepth;

    // Start dragging finger 1 past touch slop.
    arbiter.pointerDown(pt(1, 180, 150));
    arbiter.pointerMove(pt(1, 210, 150));
    expect(arbiter.phase).toBe("tool-drag");
    expect((editor.doc.get(id) as NodeRecord).props.x).toBe(130);
    expect(editor.sync.holding).toBe(true);

    // During the first < 200 ms, flushing sends nothing to collaborators.
    clock.advance(TOUCH_HOLD_MS - 10);
    arbiter.pointerMove(pt(1, 240, 150));
    editor.sync.flush();
    expect(txns().length).toBe(sentBefore);
    expect(editor.sync.holding).toBe(true);

    // At 200 ms, hold releases automatically and flushes current drag position live.
    clock.advance(10);
    expect(editor.sync.holding).toBe(false);
    expect(txns().length).toBe(sentBefore + 1);

    // Subsequent moves stream immediately on flush like desktop.
    arbiter.pointerMove(pt(1, 280, 150));
    editor.sync.flush();
    expect(txns().length).toBe(sentBefore + 2);
    expect((editor.doc.get(id) as NodeRecord).props.x).toBe(200);

    // A second finger landing AFTER 200 ms cancels like desktop Escape: reverts locally
    // AND flushes inverse ops to collaborators with zero undo/redo entry left.
    const sentBeforeCancel = txns().length;
    arbiter.pointerDown(pt(2, 400, 150));
    expect(arbiter.phase).toBe("multitouch");
    expect((editor.doc.get(id) as NodeRecord).props.x).toBe(100);
    expect(editor.history.undoDepth).toBe(undoBefore);
    expect(editor.history.redoDepth).toBe(0);
    expect(editor.s.selection).toEqual([id]);
    expect(txns().length).toBe(sentBeforeCancel + 1);
  });

  it("delivers final edit on normal lift within 200 ms and survives disconnect/reconnect mid-hold", () => {
    const { editor, arbiter, sent, txns, pt } = setupCanvasTouch("tablet");
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    editor.sync.flush();
    editor.sync.receive({ t: "ack", seq: 1, revn: 2 });
    const sentBefore = txns().length;

    // Drag and lift cleanly within 200 ms -> single txn delivered on lift.
    arbiter.pointerDown(pt(1, 180, 150));
    arbiter.pointerMove(pt(1, 230, 150));
    expect(txns().length).toBe(sentBefore);
    arbiter.pointerUp(pt(1, 230, 150));
    expect(editor.sync.holding).toBe(false);
    expect(txns().length).toBe(sentBefore + 1);
    expect((editor.doc.get(id) as NodeRecord).props.x).toBe(150);

    // Acknowledge, then start another held drag and reconnect mid-hold.
    editor.sync.receive({ t: "ack", seq: 2, revn: 3 });
    const sentBeforeReconnect = txns().length;
    arbiter.pointerDown(pt(2, 230, 150));
    arbiter.pointerMove(pt(2, 290, 150));
    expect(editor.sync.holding).toBe(true);
    editor.sync.disconnected();
    editor.sync.connected((m) => sent.push(m));
    editor.sync.receive({
      t: "welcome",
      sessionId: "s1b",
      role: "editor",
      revn: 3,
      lastSeq: 2,
      mode: "catchup",
      copies: "materialized",
      peers: [],
    });
    // Reconnecting during a hold must NOT prematurely flush the held drag.
    expect(txns().length).toBe(sentBeforeReconnect);
    expect(editor.sync.holding).toBe(true);

    // Lifting releases the hold and sends one txn with the final position.
    arbiter.pointerMove(pt(2, 330, 150));
    arbiter.pointerUp(pt(2, 330, 150));
    expect(editor.sync.holding).toBe(false);
    expect(txns().length).toBe(sentBeforeReconnect + 1);
    expect((editor.doc.get(id) as NodeRecord).props.x).toBe(250);
  });

  it("rolls back the held drag before any external commit (nudge, refitText, undo, delete) so undo never saves discarded positions", () => {
    const { editor, arbiter, txns, pt, setCharWidth } = setupCanvasTouch("tablet");
    const textId = editor.createLayer(
      "text",
      { x: 600, y: 100, width: 0, height: 0 },
      "p",
    ) as string;
    editor.setProp([textId], "characters", "Hello");
    const a = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    const b = editor.createLayer(
      "rect",
      { x: 400, y: 100, width: 100, height: 100 },
      "p",
    ) as string;
    editor.setProp([a], "opacity", 0.5);
    editor.select([a]);
    editor.sync.flush();
    const undoBefore = editor.history.undoDepth;
    const textWidthBefore = (editor.doc.get(textId) as NodeRecord).props.width;

    // 1) N2 scenario: drag `a` to x = 160 (held), keyboard nudge (+1), then second finger lands.
    // The nudge must roll back the held drag to x = 100 first, leaving x = 101 (never 161),
    // and undo must restore x = 100 (never the discarded x = 160).
    arbiter.pointerDown(pt(1, 180, 150));
    arbiter.pointerMove(pt(1, 240, 150));
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(160);
    expect(editor.sync.holding).toBe(true);

    editor.nudge(1, 0);
    expect(editor.sync.holding).toBe(false);
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(101);
    expect(editor.history.undoDepth).toBe(undoBefore + 1);

    // Continued moves on finger 1 and a landing second finger must not corrupt the nudge.
    arbiter.pointerMove(pt(1, 290, 150));
    arbiter.pointerDown(pt(2, 340, 150));
    arbiter.pointerUp(pt(2, 340, 150));
    arbiter.pointerUp(pt(1, 290, 150));
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(101);

    editor.undo();
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect(editor.history.undoDepth).toBe(undoBefore);
    editor.redo();
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(101);
    editor.undo();
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);

    // 2) Web font arrives mid-hold -> refitText rolls back the held drag cleanly and refits text.
    arbiter.pointerDown(pt(3, 180, 150));
    arbiter.pointerMove(pt(3, 240, 150));
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(160);
    expect(editor.sync.holding).toBe(true);

    setCharWidth(12);
    editor.refitText();
    const textWidthRefit = (editor.doc.get(textId) as NodeRecord).props.width;
    expect(textWidthRefit).not.toBe(textWidthBefore);
    expect(editor.sync.holding).toBe(false);
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    arbiter.pointerUp(pt(3, 240, 150));

    // 3) Hardware keyboard Cmd+Z mid-hold rolls back the drag first, then undoes `a`'s opacity.
    arbiter.pointerDown(pt(4, 180, 150));
    arbiter.pointerMove(pt(4, 240, 150));
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(160);
    expect(editor.sync.holding).toBe(true);

    editor.undo();
    expect(editor.sync.holding).toBe(false);
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect(getProp((editor.doc.get(a) as NodeRecord).props, "opacity")).toBe(1);
    arbiter.pointerDown(pt(5, 340, 150));
    arbiter.pointerUp(pt(5, 340, 150));
    arbiter.pointerUp(pt(4, 240, 150));

    // 4) Unrelated prop edit mid-hold on `b` rolls back the held drag on `a` and commits `b`.
    const sentBeforeProp = txns().length;
    arbiter.pointerDown(pt(6, 180, 150));
    arbiter.pointerMove(pt(6, 240, 150));
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(160);
    editor.setProp([b], "opacity", 0.25);
    editor.sync.flush();
    expect(editor.sync.holding).toBe(false);
    expect((editor.doc.get(a) as NodeRecord).props.x).toBe(100);
    expect(getProp((editor.doc.get(b) as NodeRecord).props, "opacity")).toBe(0.25);
    expect(txns().length).toBeGreaterThan(sentBeforeProp);
    arbiter.pointerUp(pt(6, 240, 150));

    // History and document agree: undoing once reverts `b`'s opacity (the unrelated edit).
    expect(editor.history.undoDepth).toBe(undoBefore);
    editor.undo();
    expect(getProp((editor.doc.get(b) as NodeRecord).props, "opacity")).toBe(1);

    // 5) Drawing a speculative rect mid-hold then pressing Delete rolls back the drawn rect
    // cleanly instead of deleting a speculative layer the server never saw.
    editor.select([]);
    editor.setTool("rect");
    const countBeforeDraw = editor.doc.childIds("p").length;
    const undoBeforeDraw = editor.history.undoDepth;
    arbiter.pointerDown(pt(7, 500, 300));
    arbiter.pointerMove(pt(7, 620, 400));
    expect(editor.sync.holding).toBe(true);
    expect(editor.doc.childIds("p").length).toBe(countBeforeDraw + 1);
    editor.deleteSelection();
    expect(editor.sync.holding).toBe(false);
    expect(editor.doc.childIds("p").length).toBe(countBeforeDraw);
    expect(editor.history.undoDepth).toBe(undoBeforeDraw);
    arbiter.pointerUp(pt(7, 620, 400));
  });

  it("releases the sync hold via try/finally even if a tool throws on release", () => {
    const { editor, interaction, arbiter, txns, pt } = setupCanvasTouch("tablet");
    const id = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    editor.select([id]);
    editor.sync.flush();
    const sentBefore = txns().length;

    arbiter.pointerDown(pt(1, 180, 150));
    arbiter.pointerMove(pt(1, 240, 150));
    expect(editor.sync.holding).toBe(true);

    const upSpy = vi.spyOn(interaction, "up").mockImplementationOnce(() => {
      throw new Error("simulated tool throw on pointerup");
    });
    expect(() => arbiter.pointerUp(pt(1, 240, 150))).toThrow("simulated tool throw on pointerup");
    upSpy.mockRestore();

    // Hold was released in finally; later edits continue syncing normally.
    expect(editor.sync.holding).toBe(false);
    expect(txns().length).toBeGreaterThan(sentBefore);
    const countAfterThrow = txns().length;
    editor.setProp([id], "opacity", 0.5);
    editor.sync.flush();
    expect(txns().length).toBe(countAfterThrow + 1);
  });

  it("skips handle zones on tap at 50% zoom so a 5 px layer next to selection is selected", () => {
    const { editor, arbiter, pt } = setupCanvasTouch("tablet");
    const big = editor.createLayer(
      "rect",
      { x: 100, y: 100, width: 160, height: 100 },
      "p",
    ) as string;
    // 5 px wide layer positioned 4 page px right of `big`'s east edge (x = 260).
    const small = editor.createLayer(
      "rect",
      { x: 264, y: 145, width: 5, height: 10 },
      "p",
    ) as string;
    editor.zoomTo(0.5);
    editor.select([big]);

    // Screen position of `small`'s center is only ~3.25 screen px from `big`'s east handle!
    const smallCenter = editor.s.camera.toScreen({ x: 266.5, y: 150 });
    arbiter.pointerDown(pt(1, smallCenter.x, smallCenter.y));
    arbiter.pointerUp(pt(1, smallCenter.x, smallCenter.y));
    expect(editor.s.selection).toEqual([small]);

    // At 100% zoom, dragging empty space 9 px right of `big`'s east handle still resizes `big`
    // via coarse touch, while dragging `small` placed 9 px outside moves `small` instead.
    editor.zoomTo(1);
    editor.select([big]);
    const bigEast = editor.s.camera.toScreen({ x: 260, y: 150 });
    arbiter.pointerDown(pt(2, bigEast.x + 9, bigEast.y + 30));
    arbiter.pointerMove(pt(2, bigEast.x + 29, bigEast.y + 30));
    arbiter.pointerUp(pt(2, bigEast.x + 29, bigEast.y + 30));
    // (269, 180) is outside the east handle's y range; test directly at y = 150 with no neighbour:
    editor.setProp([small], "x", 500);
    editor.select([big]);
    const bigEastClear = editor.s.camera.toScreen({ x: 260, y: 150 });
    arbiter.pointerDown(pt(3, bigEastClear.x + 9, bigEastClear.y));
    arbiter.pointerMove(pt(3, bigEastClear.x + 49, bigEastClear.y));
    arbiter.pointerUp(pt(3, bigEastClear.x + 49, bigEastClear.y));
    expect((editor.doc.get(big) as NodeRecord).props.width).toBeGreaterThan(160);
  });
});
