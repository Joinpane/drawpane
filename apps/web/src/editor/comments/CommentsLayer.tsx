/**
 * Comment pins, the open thread and the new-comment draft, as DOM over the
 * canvas. Pins are real buttons (focusable, labelled, clickable) and keep a
 * fixed size at every zoom. React renders them when threads change; their
 * positions are written straight to the DOM, at most once a frame, when the
 * camera, page or document changes. The canvas code never sees them.
 */
import type { Interaction } from "@drawpane/editor";
import type { CommentPerson, CommentThread } from "@drawpane/model";
import { Icon } from "@drawpane/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useEditor, useEditorState } from "../hooks";
import { MobileSheet } from "../MobileSheet";
import { useUi } from "../ui-state";
import { readVisualViewport } from "../visual-viewport";
import { anchorAt, anchorLabel, type PinPosition, resolveAnchor } from "./anchor";
import { colorStyle, displayName, personInitials } from "./people";
import { type CommentStore, type CommentsState, matchesFilter } from "./store";
import { DraftPopover, ThreadPopover } from "./Thread";
import "./comments.css";

/** Space between a pin and its popover, and between popovers and the window edge. */
const GAP = 12;
/** The top bar's height plus its margin: popovers stay below it. */
const TOP = 64;
const PIN = 28;

export function useComments<T>(store: CommentStore, select: (s: CommentsState) => T): T {
  return useSyncExternalStore(store.state.subscribe, () => select(store.state.get()));
}

export interface CommentsLayerProps {
  readonly store: CommentStore;
  readonly interaction: Interaction;
  readonly people: readonly CommentPerson[];
  /** Width the floating panes cover on each side, so popovers open over the canvas. */
  readonly insets: { readonly left: number; readonly right: number };
  /** Fallback trigger to focus when closing a phone comment sheet whose pin isn't available. */
  readonly phoneReturnFocusTo?: (() => HTMLElement | null) | undefined;
  /** Optional Back button handler in phone thread sheet (returns to the Comments list sheet). */
  readonly onPhoneBackToList?: (() => void) | undefined;
}

export function CommentsLayer({
  store,
  interaction,
  people,
  insets,
  phoneReturnFocusTo,
  onPhoneBackToList,
}: CommentsLayerProps) {
  const editor = useEditor();
  const workspaceMode = useUi(editor, (ui) => ui.workspaceMode);
  const isPhone = workspaceMode === "phone";
  const isTouchWorkspace = workspaceMode !== "desktop";
  const threads = useComments(store, (s) => s.threads);
  const filter = useComments(store, (s) => s.filter);
  const openId = useComments(store, (s) => s.openId);
  const draft = useComments(store, (s) => s.draft);
  const role = useEditorState((s) => s.role);
  const focusMode = useEditorState((s) => s.focusMode);
  // Pins step aside while you drag, resize or draw.
  const dragging = useEditorState((s) => s.gesture && !s.editingText);
  const me = store.me?.id ?? null;

  const root = useRef<HTMLElement>(null);
  const pins = useRef(new Map<string, HTMLButtonElement>());
  const draftPin = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLElement>(null);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const update = useRef<() => void>(() => {});
  const schedule = useRef<() => void>(() => {});

  const shown = [...threads.values()].filter(
    (t) => t.id === openId || matchesFilter(t, filter, me),
  );
  const open = openId ? threads.get(openId) : undefined;

  // Positioning: one pass per frame, on camera, page, viewport or document change.
  useLayoutEffect(() => {
    let frame = 0;
    let version = -1;
    let threadsSeen: ReadonlyMap<string, CommentThread> | null = null;
    const cache = new Map<string, PinPosition>();

    const positionOf = (thread: CommentThread) => {
      let pos = cache.get(thread.id);
      if (!pos) {
        pos = resolveAnchor(editor.scene, thread.anchor, thread.pageId);
        cache.set(thread.id, pos);
      }
      return pos;
    };

    const place = (el: HTMLElement, pos: PinPosition | null) => {
      const { pageId, camera } = editor.s;
      if (!pos || pos.pageId !== pageId) {
        el.hidden = true;
        return null;
      }
      const p = camera.toScreen(pos.point);
      el.hidden = false;
      el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
      return p;
    };

    const run = () => {
      frame = 0;
      const cs = store.state.get();
      if (editor.doc.version !== version || cs.threads !== threadsSeen) {
        cache.clear();
        version = editor.doc.version;
        threadsSeen = cs.threads;
      }
      let anchor: { x: number; y: number } | null = null;
      for (const [id, el] of pins.current) {
        // A pin being dragged follows the pointer, not its anchor.
        if (el.dataset.moving !== undefined) continue;
        const thread = cs.threads.get(id);
        const p = place(el, thread ? positionOf(thread) : null);
        if (id === cs.openId) anchor = p;
      }
      if (draftPin.current) {
        const d = cs.draft;
        anchor = place(
          draftPin.current,
          d ? resolveAnchor(editor.scene, d.anchor, d.pageId) : null,
        );
      }
      const pop = popover.current;
      if (pop) {
        if (!anchor) {
          pop.hidden = true;
        } else {
          pop.hidden = false;
          const { width: vw, height: vh } = editor.s.viewport;
          const { left: insetLeft, right: insetRight } = insetsRef.current;
          const vv = readVisualViewport();
          const leftEdge = Math.max(0, vv.offsetLeft);
          const rightEdge = Math.min(vw, vv.offsetLeft + vv.width);
          const topBound = Math.max(
            TOP,
            editor.s.insets.top > TOP ? editor.s.insets.top + 4 : TOP,
            vv.offsetTop + GAP,
          );
          const bottomBound = Math.min(vh, vv.offsetTop + vv.height) - GAP;
          const availH = Math.max(160, bottomBound - topBound);
          if (vv.bottomInset > 0 || vv.offsetTop > 0) {
            pop.style.maxHeight = `${Math.round(availH)}px`;
          } else {
            pop.style.removeProperty("max-height");
          }
          const w = pop.offsetWidth;
          const h = Math.min(pop.offsetHeight, availH);
          const minX = insetLeft + GAP;
          const maxX = vw - insetRight - GAP - w;
          let x = anchor.x + PIN + GAP;
          if (x > maxX) x = anchor.x - GAP - w;
          if (maxX >= minX) x = Math.max(minX, Math.min(x, maxX));
          // Never clip past the visual viewport even when side panels leave narrow space.
          const hardMinX = leftEdge + GAP;
          const hardMaxX = Math.max(hardMinX, rightEdge - GAP - w);
          x = Math.max(hardMinX, Math.min(x, hardMaxX));
          const maxY = Math.max(topBound, bottomBound - h);
          const y = Math.max(topBound, Math.min(anchor.y - PIN - 8, maxY));
          pop.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        }
      }
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    update.current = run;
    schedule.current = request;

    let last = editor.s;
    const offState = editor.state.subscribe(() => {
      const s = editor.s;
      if (
        s.camera !== last.camera ||
        s.pageId !== last.pageId ||
        s.viewport !== last.viewport ||
        s.insets !== last.insets
      )
        request();
      last = s;
    });
    const offDoc = editor.doc.subscribe(request);
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", request);
    vv?.addEventListener("scroll", request);
    window.addEventListener("resize", request);
    return () => {
      offState();
      offDoc();
      vv?.removeEventListener("resize", request);
      vv?.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, store]);

  // After every render (new pins, a popover opening), place things before paint.
  useLayoutEffect(() => {
    update.current();
  });

  // Watch the popover's size so it stays inside the window as replies arrive.
  const popoverRef = useCallback((el: HTMLElement | null) => {
    popover.current = el;
    if (!el) return;
    const observer = new ResizeObserver(() => schedule.current());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The comment tool: a click (or touch tap after slop) on the canvas drops a pin instead of reaching the canvas.
  useEffect(() => {
    const host = root.current?.parentElement;
    if (!host) return;
    const TAP_SLOP = 8;
    let touchTap: {
      pointerId: number;
      startX: number;
      startY: number;
      canvas: HTMLElement;
    } | null = null;

    const placePin = (canvas: HTMLElement, clientX: number, clientY: number) => {
      const cs = store.state.get();
      if (cs.draft && cs.draft.text.trim() !== "") {
        // Keep unsent words: send focus back to them instead of dropping a new pin.
        (popover.current ?? document.querySelector(".mobile-sheet"))
          ?.querySelector("textarea")
          ?.focus();
        return;
      }
      const pageId = editor.s.pageId;
      if (!pageId) return;
      const rect = canvas.getBoundingClientRect();
      const point = editor.s.camera.toPage({ x: clientX - rect.left, y: clientY - rect.top });
      store.startDraft(pageId, anchorAt(editor.scene, pageId, point));
    };

    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const canvas = target?.closest<HTMLElement>(".canvas");
      if (!canvas) return;
      const cs = store.state.get();
      const panning =
        e.button !== 0 || interaction.cursor === "grab" || interaction.cursor === "grabbing";
      if (editor.s.tool === "comment" && !panning) {
        if (e.pointerType === "touch") {
          // On touch, decide on release after slop so a pan never drops a pin and the
          // sheet scrim never mounts under the active touch.
          e.stopPropagation();
          touchTap = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, canvas };
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        placePin(canvas, e.clientX, e.clientY);
        return;
      }
      // Any other click on the canvas closes the open thread; a draft with words stays.
      if (cs.openId) store.close();
      if (cs.draft && cs.draft.text.trim() === "") store.cancelDraft();
    };

    const onMove = (e: PointerEvent) => {
      if (!touchTap || e.pointerId !== touchTap.pointerId) return;
      if (Math.hypot(e.clientX - touchTap.startX, e.clientY - touchTap.startY) > TAP_SLOP) {
        touchTap = null;
      }
    };

    let suppressClickTimer: number | null = null;
    let suppressClickPoint: { x: number; y: number } | null = null;
    const clearSuppressedClick = () => {
      suppressClickPoint = null;
      if (suppressClickTimer !== null) {
        window.clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
      }
    };
    const onSuppressedClick = (e: MouseEvent) => {
      if (!suppressClickPoint) return;
      const hit =
        Math.hypot(e.clientX - suppressClickPoint.x, e.clientY - suppressClickPoint.y) <=
        TAP_SLOP * 2;
      clearSuppressedClick();
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!touchTap || e.pointerId !== touchTap.pointerId) return;
      const tap = touchTap;
      touchTap = null;
      if (editor.s.tool !== "comment") return;
      if (Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY) > TAP_SLOP) return;
      e.stopPropagation();
      // Swallow the trailing compatibility click from this touch tap so mounting the
      // bottom sheet under the tapped spot never triggers Cancel, Close or the scrim.
      clearSuppressedClick();
      suppressClickPoint = { x: e.clientX, y: e.clientY };
      suppressClickTimer = window.setTimeout(clearSuppressedClick, 350);
      placePin(tap.canvas, e.clientX, e.clientY);
    };

    const onCancel = (e: PointerEvent) => {
      if (touchTap && e.pointerId === touchTap.pointerId) touchTap = null;
    };

    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("click", onSuppressedClick, true);
    return () => {
      clearSuppressedClick();
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("click", onSuppressedClick, true);
    };
  }, [editor, interaction, store]);

  const closeAndRefocus = useCallback(() => {
    const cs = store.state.get();
    const pin = cs.openId ? pins.current.get(cs.openId) : null;
    if (cs.openId) store.close();
    if (cs.draft) store.cancelDraft();
    if (isPhone && editor.s.tool === "comment") editor.setTool("select");
    if (pin && !pin.hidden) pin.focus();
  }, [editor, isPhone, store]);

  // Escape closes the open thread or draft wherever focus is, then leaves the comment tool.
  // It listens in the capture phase so it runs before the editor's own Escape handling;
  // inside a popover or phone sheet, those surfaces handle Escape themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target instanceof Node ? e.target : null;
      if (target && popover.current?.contains(target)) return;
      if (isPhone && (store.state.get().openId || store.state.get().draft)) return;
      // A field elsewhere (the command bar, a rename) owns its own Escape.
      const el = target instanceof HTMLElement ? target : null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const cs = store.state.get();
      if (cs.openId || cs.draft) {
        e.stopPropagation();
        closeAndRefocus();
        return;
      }
      if (editor.s.tool === "comment") {
        e.stopPropagation();
        editor.setTool("select");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, isPhone, store, closeAndRefocus]);

  // Moving pins: drag with the pointer, or arrow keys while a pin has focus.
  // Authors move their own threads; editors can move anyone's.
  const canMove = (thread: CommentThread) =>
    role !== "viewer" || (me !== null && thread.author?.id === me);
  const drag = useRef<{
    id: string;
    pointerId: number;
    start: { x: number; y: number };
    /** Pointer minus pin anchor, in layer pixels, so the pin doesn't jump. */
    grab: { x: number; y: number };
    screen: { x: number; y: number } | null;
  } | null>(null);
  const dragged = useRef<string | null>(null);
  const keyMove = useRef<{ id: string; timer: number; point: { x: number; y: number } } | null>(
    null,
  );

  const layerPoint = (e: { clientX: number; clientY: number }) => {
    const rect = root.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const commitMove = useCallback(
    (threadId: string, page: { x: number; y: number }) => {
      const thread = store.state.get().threads.get(threadId);
      if (!thread) return;
      store.move(threadId, anchorAt(editor.scene, thread.pageId, page)).catch((error: unknown) => {
        editor.notify(
          error instanceof Error ? error.message : "Couldn't move the comment. Try again.",
        );
      });
    },
    [editor, store],
  );

  const commitMoveRef = useRef(commitMove);
  commitMoveRef.current = commitMove;

  // A pending keyboard move saves now if the layer goes away.
  useEffect(
    () => () => {
      const pending = keyMove.current;
      if (!pending) return;
      window.clearTimeout(pending.timer);
      commitMoveRef.current(pending.id, pending.point);
    },
    [],
  );

  const pinHandlers = (thread: CommentThread) => {
    if (!canMove(thread)) return {};
    return {
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        const pos = resolveAnchor(editor.scene, thread.anchor, thread.pageId);
        const anchor = editor.s.camera.toScreen(pos.point);
        const p = layerPoint(e);
        drag.current = {
          id: thread.id,
          pointerId: e.pointerId,
          start: p,
          grab: { x: p.x - anchor.x, y: p.y - anchor.y },
          screen: null,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const p = layerPoint(e);
        if (!d.screen && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 4) return;
        d.screen = { x: p.x - d.grab.x, y: p.y - d.grab.y };
        const el = e.currentTarget;
        el.dataset.moving = "";
        el.style.transform = `translate3d(${Math.round(d.screen.x)}px, ${Math.round(d.screen.y)}px, 0) scale(1.08)`;
      },
      onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        drag.current = null;
        delete e.currentTarget.dataset.moving;
        if (!d.screen) return;
        // The click that ends a drag doesn't open the thread.
        dragged.current = d.id;
        commitMove(d.id, editor.s.camera.toPage(d.screen));
      },
      onLostPointerCapture: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        drag.current = null;
        delete e.currentTarget.dataset.moving;
        schedule.current();
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
        const step = (e.shiftKey ? 10 : 1) / editor.s.camera.zoom;
        const d: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = d[e.key];
        if (!delta) return;
        // Arrows move the pin, not the selected layers.
        e.preventDefault();
        e.stopPropagation();
        const current =
          keyMove.current?.id === thread.id
            ? keyMove.current.point
            : resolveAnchor(editor.scene, thread.anchor, thread.pageId).point;
        const point = { x: current.x + delta[0], y: current.y + delta[1] };
        const screen = editor.s.camera.toScreen(point);
        const el = e.currentTarget;
        el.dataset.moving = "";
        el.style.transform = `translate3d(${Math.round(screen.x)}px, ${Math.round(screen.y)}px, 0)`;
        if (keyMove.current) window.clearTimeout(keyMove.current.timer);
        // Save once the keys rest, not on every press.
        keyMove.current = {
          id: thread.id,
          point,
          timer: window.setTimeout(() => {
            keyMove.current = null;
            delete el.dataset.moving;
            commitMove(thread.id, point);
          }, 400),
        };
      },
    };
  };

  const myInitials = personInitials(store.me);

  return (
    <section
      ref={root}
      className="comments-layer"
      data-dragging={dragging || undefined}
      aria-label="Comment pins"
    >
      {shown.map((thread) => {
        const resolved = thread.resolvedAt !== null;
        const replies = thread.messages.length - 1;
        const isOpen = thread.id === openId;
        const calm = focusMode && thread.author?.id !== me && !isOpen;
        const name = displayName(thread.author);
        return (
          <button
            key={thread.id}
            ref={(el) => {
              if (el) pins.current.set(thread.id, el);
              else pins.current.delete(thread.id);
            }}
            type="button"
            className="comment-pin"
            data-open={isOpen || undefined}
            data-resolved={resolved || undefined}
            data-calm={calm || undefined}
            style={colorStyle(thread.author?.id)}
            hidden
            aria-label={`${resolved ? "Resolved comment" : "Comment"} by ${name}${
              replies > 0 ? `, ${replies} ${replies === 1 ? "reply" : "replies"}` : ""
            }`}
            aria-expanded={isOpen}
            aria-roledescription={canMove(thread) ? "movable comment pin" : undefined}
            data-movable={canMove(thread) || undefined}
            {...pinHandlers(thread)}
            onClick={() => {
              if (dragged.current === thread.id) {
                dragged.current = null;
                return;
              }
              if (isOpen) store.close();
              else store.open(thread.id);
            }}
          >
            {resolved && !isOpen ? (
              <Icon name="check" size={12} />
            ) : (
              <span aria-hidden="true">{personInitials(thread.author)}</span>
            )}
          </button>
        );
      })}
      {draft ? (
        <span
          ref={draftPin}
          className="comment-pin comment-pin--draft"
          data-open
          hidden
          aria-hidden="true"
        >
          {myInitials}
        </span>
      ) : null}
      {open ? (
        isPhone ? (
          <ThreadPopover
            key={open.id}
            store={store}
            thread={open}
            label={anchorLabel(editor.scene, open.anchor, open.pageId)}
            people={people}
            role={role}
            presentation="sheet"
            onBack={onPhoneBackToList}
            returnFocusTo={() => {
              const pin = pins.current.get(open.id);
              if (pin && !pin.hidden && pin.isConnected) return pin;
              return phoneReturnFocusTo?.() ?? null;
            }}
            onClose={closeAndRefocus}
          />
        ) : (
          <ThreadPopover
            key={open.id}
            ref={popoverRef}
            store={store}
            thread={open}
            label={anchorLabel(editor.scene, open.anchor, open.pageId)}
            people={people}
            role={role}
            onClose={closeAndRefocus}
          />
        )
      ) : draft ? (
        isPhone ? (
          <MobileSheet
            title={anchorLabel(editor.scene, draft.anchor, draft.pageId)}
            ariaLabel={`New comment on ${anchorLabel(editor.scene, draft.anchor, draft.pageId)}`}
            closeLabel="Close comment"
            variant="thread"
            focusInside
            returnFocusTo={phoneReturnFocusTo}
            onScrimClick={() => {
              // Match desktop: keep unsent words when tapping outside the draft sheet.
              if (store.state.get().draft?.text.trim()) {
                document
                  .querySelector<HTMLTextAreaElement>(".mobile-sheet textarea")
                  ?.focus({ preventScroll: true });
                return;
              }
              closeAndRefocus();
            }}
            onClose={closeAndRefocus}
          >
            <DraftPopover
              store={store}
              text={draft.text}
              label={anchorLabel(editor.scene, draft.anchor, draft.pageId)}
              people={people}
              presentation="sheet"
              showCancel
              onCreated={() => {
                if (editor.s.tool === "comment") editor.setTool("select");
              }}
              onCancel={closeAndRefocus}
            />
          </MobileSheet>
        ) : (
          <DraftPopover
            ref={popoverRef}
            store={store}
            text={draft.text}
            label={anchorLabel(editor.scene, draft.anchor, draft.pageId)}
            people={people}
            showCancel={isTouchWorkspace}
            onCancel={closeAndRefocus}
          />
        )
      ) : null}
    </section>
  );
}
