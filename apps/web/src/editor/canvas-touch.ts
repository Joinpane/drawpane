/**
 * Canvas integration layer for `TouchArbiter`: builds the real `TouchArbiterHost`
 * callbacks used by `Canvas.tsx` (tap handling, bounded 200 ms hold with live
 * streaming afterwards, rollback vs Escape-style cancel, `try/finally` hold
 * release safety, and floating-chrome touch target classification).
 *
 * Extracted from `Canvas.tsx` so unit tests exercise the exact production
 * handlers rather than duplicated test helpers.
 */
import { Camera, type Editor, type Interaction, type PointerInput } from "@drawpane/editor";
import { passesToCanvas } from "./canvas-gestures";
import {
  type Point2D,
  TOUCH_HOLD_MS,
  type TouchArbiterHost,
  type TouchPoint,
} from "./touch-arbitration";
import { commentBridgeFor, uiFor } from "./ui-state";

/** Elements that own interactive dialogs/popovers and should never join a canvas pinch. */
const NON_PASSTHROUGH_CHROME =
  ".mobile-sheet-host, .dp-popover, [role='menu'], [role='listbox'], .comment-popover, .comment-draft";

/**
 * Whether a touch starting outside `.canvas__overlay` sits on floating canvas
 * chrome or sibling canvas UI (Lens, toolbar, text-editing box, comment pin)
 * inside the canvas rect and can safely join a two-finger canvas pan/pinch.
 */
export function isCanvasTouchPassthrough(
  target: EventTarget | null,
  hostEl: HTMLElement | null,
  overlayEl: HTMLElement,
  client: Point2D,
): boolean {
  if (!(target instanceof Element)) return false;
  if (overlayEl.contains(target)) return false;
  const r = overlayEl.getBoundingClientRect();
  if (client.x < r.left || client.x >= r.right || client.y < r.top || client.y >= r.bottom) {
    return false;
  }
  if (target.closest(NON_PASSTHROUGH_CHROME)) return false;
  if (hostEl?.contains(target)) return true;
  if (target.closest(".comment-pin")) return true;
  return passesToCanvas(target, null);
}

export function touchPointToInput(
  point: TouchPoint,
  clicks = 1,
  options: { readonly coarse?: boolean; readonly skipHandles?: boolean } = {},
): PointerInput {
  return {
    screen: point.screen,
    button: point.button,
    shift: point.shift,
    alt: point.alt,
    mod: point.mod,
    noSnap: point.noSnap,
    clicks,
    ...(options.coarse ? { coarse: true } : {}),
    ...(options.skipHandles ? { skipHandles: true } : {}),
  };
}

export interface CanvasTouchHostDeps {
  readonly editor: Editor;
  readonly interaction: Interaction;
  readonly getHostElement: () => HTMLElement | null;
  readonly setCursor: (cursor: string) => void;
  readonly blurOutsideCanvas: () => void;
  readonly openCanvasContextMenu: (clientX: number, clientY: number, deep: boolean) => void;
  readonly onCameraMotionStart: () => void;
  readonly onCameraMotionEnd: () => void;
  readonly onPromoteExternalTouches?: (pointerIds: readonly number[]) => void;
  readonly holdMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

interface TouchDragSession {
  readonly prevSelection: readonly string[];
  readonly prevHistoryDepth: number;
  readonly nestedMark: boolean;
  holdReleased: boolean;
  holdTimer: unknown;
}

/**
 * Builds the `TouchArbiterHost` wired to `editor`, `interaction`, and `uiFor(editor)`.
 *
 * Single-finger tablet drags hold sync writes for `holdMs` (default 200 ms) so an
 * arriving second finger rolls back with zero server writes or undo entries; once the
 * hold window passes, the drag releases its hold and streams live to collaborators
 * like desktop, and any later second finger cancels via `cancelGesture()` (reverting
 * locally and syncing the revert).
 */
export function createCanvasTouchHost(deps: CanvasTouchHostDeps): {
  readonly host: TouchArbiterHost;
  readonly dispose: () => void;
} {
  const { editor, interaction } = deps;
  const holdMs = deps.holdMs ?? TOUCH_HOLD_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let touchDrag: TouchDragSession | null = null;

  const clearHoldTimer = (session: TouchDragSession | null) => {
    if (session && session.holdTimer !== null) {
      clearTimer(session.holdTimer);
      session.holdTimer = null;
    }
  };

  const releaseHold = (session: TouchDragSession) => {
    clearHoldTimer(session);
    if (session.holdReleased) return;
    session.holdReleased = true;
    editor.sync.commitHold();
  };

  const rollbackSession = (session: TouchDragSession) => {
    touchDrag = null;
    clearHoldTimer(session);
    try {
      interaction.rollback();
    } finally {
      if (!session.holdReleased) {
        // Still inside the initial hold window: drop silently with zero server traffic.
        while (editor.history.groupDepth > session.prevHistoryDepth) editor.dropGesture();
        session.holdReleased = true;
        editor.sync.discardHold();
      } else {
        // Already streaming to collaborators: revert and sync the revert like desktop Escape.
        while (editor.history.groupDepth > session.prevHistoryDepth) editor.cancelGesture();
        editor.sync.flush();
      }
      editor.select(session.prevSelection.filter((id) => editor.doc.has(id)));
      editor.state.set({
        gesture: editor.history.grouping,
        guides: [],
        marquee: null,
        guideDraft: null,
      });
      deps.setCursor(interaction.cursor);
    }
  };

  const host: TouchArbiterHost = {
    workspaceMode: () => uiFor(editor).get().workspaceMode,
    tool: () => editor.s.tool,
    canEdit: () => editor.canEdit,
    camera: () => editor.s.camera,
    setCamera: (next) => editor.setCamera(new Camera(next.x, next.y, next.zoom)),
    onCameraGestureStart: () => {
      editor.stopCameraAnimation();
      deps.onCameraMotionStart();
      uiFor(editor).set({ cameraGesture: true });
    },
    onCameraGestureEnd: () => {
      deps.onCameraMotionEnd();
      uiFor(editor).set({ cameraGesture: false });
    },
    onTap: (point, tapClicks) => {
      deps.blurOutsideCanvas();
      if (editor.s.tool === "comment") {
        const hostEl = deps.getHostElement();
        if (hostEl) commentBridgeFor(editor)?.placeAt(hostEl, point.client.x, point.client.y);
        return;
      }
      commentBridgeFor(editor)?.dismissOpen();
      // Taps cannot resize or rotate, so skip handle hit zones so tiny layers next to
      // a selection remain tappable even at low zoom.
      const input = touchPointToInput(point, tapClicks, { coarse: false, skipHandles: true });
      interaction.down(input);
      interaction.up(input);
      deps.setCursor(interaction.cursor);
    },
    onLongPress: (point, mode) => {
      deps.blurOutsideCanvas();
      if (mode === "phone") {
        const hostEl = deps.getHostElement();
        if (hostEl) commentBridgeFor(editor)?.placeAt(hostEl, point.client.x, point.client.y);
        return;
      }
      commentBridgeFor(editor)?.dismissOpen();
      deps.openCanvasContextMenu(point.client.x, point.client.y, false);
    },
    onToolDragStart: (start, current) => {
      deps.blurOutsideCanvas();
      commentBridgeFor(editor)?.dismissOpen();
      if (editor.s.editingText !== null) editor.endTextEdit();
      const prevSelection = editor.s.selection;
      const prevHistoryDepth = editor.history.groupDepth;
      const nestedMark = prevHistoryDepth > 0;
      if (nestedMark) editor.history.begin("Touch stroke", prevSelection);
      const session: TouchDragSession = {
        prevSelection,
        prevHistoryDepth,
        nestedMark,
        holdReleased: false,
        holdTimer: null,
      };
      touchDrag = session;
      editor.sync.beginHold(() => {
        if (touchDrag === session) rollbackSession(session);
      });
      session.holdTimer = setTimer(() => {
        session.holdTimer = null;
        if (touchDrag !== session || session.holdReleased) return;
        session.holdReleased = true;
        editor.sync.commitHold();
      }, holdMs);
      try {
        editor.sync.withHeld(() => {
          interaction.down(touchPointToInput(start, 1, { coarse: true }));
          interaction.move(touchPointToInput(current, 1, { coarse: true }));
        });
      } catch (error) {
        clearHoldTimer(session);
        if (touchDrag === session) touchDrag = null;
        interaction.rollback();
        while (editor.history.groupDepth > session.prevHistoryDepth) editor.dropGesture();
        if (!session.holdReleased) {
          session.holdReleased = true;
          editor.sync.discardHold();
        }
        deps.setCursor(interaction.cursor);
        throw error;
      }
      deps.setCursor(interaction.cursor);
    },
    onToolDragMove: (point) => {
      if (!touchDrag) return;
      const input = touchPointToInput(point, 1, { coarse: true });
      if (!touchDrag.holdReleased) {
        editor.sync.withHeld(() => interaction.move(input));
      } else {
        interaction.move(input);
      }
      deps.setCursor(interaction.cursor);
    },
    onToolDragEnd: (point) => {
      const session = touchDrag;
      if (!session) return;
      touchDrag = null;
      clearHoldTimer(session);
      const input = touchPointToInput(point, 1, { coarse: true });
      try {
        if (!session.holdReleased) {
          editor.sync.withHeld(() => interaction.up(input));
        } else {
          interaction.up(input);
        }
        if (session.nestedMark && editor.history.groupDepth > session.prevHistoryDepth) {
          editor.history.end();
        }
      } finally {
        releaseHold(session);
        deps.setCursor(interaction.cursor);
      }
    },
    onToolDragRollback: () => {
      const session = touchDrag;
      if (!session) return;
      rollbackSession(session);
    },
    onPenDown: (point, penClicks) => {
      deps.blurOutsideCanvas();
      if (point.button === 2) return;
      if (editor.s.tool === "comment" && point.button === 0) {
        const hostEl = deps.getHostElement();
        if (hostEl) commentBridgeFor(editor)?.placeAt(hostEl, point.client.x, point.client.y);
        return;
      }
      commentBridgeFor(editor)?.dismissOpen();
      interaction.down(touchPointToInput(point, penClicks));
      deps.setCursor(interaction.cursor);
    },
    onPenMove: (point) => {
      interaction.move(touchPointToInput(point, 1));
      deps.setCursor(interaction.cursor);
    },
    onPenUp: (point) => {
      interaction.up(touchPointToInput(point, 1));
      deps.setCursor(interaction.cursor);
    },
    onPenCancel: () => {
      interaction.cancel();
      deps.setCursor(interaction.cursor);
    },
    ...(deps.onPromoteExternalTouches
      ? { onPromoteExternalTouches: deps.onPromoteExternalTouches }
      : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  const dispose = () => {
    const session = touchDrag;
    touchDrag = null;
    if (session) releaseHold(session);
  };

  return { host, dispose };
}
