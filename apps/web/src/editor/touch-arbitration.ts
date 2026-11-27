/**
 * Touch and stylus gesture arbitration for the design canvas.
 *
 * Tracks active pointers by id and type before any editor tool sees them,
 * classifies tap vs drag vs long-press using touch slop and dwell time,
 * rolls back uncommitted single-finger interactions when a second finger
 * lands, and owns centroid pan plus anchored pinch-zoom until all
 * participating fingers lift.
 *
 * Kept pure (zero DOM dependencies, injectable clock and timers) so the
 * state machine can be unit-tested exhaustively on its own.
 */
import { MAX_ZOOM, MIN_ZOOM, type ToolId } from "@drawpane/editor";
import type { WorkspaceMode } from "./workspace-mode";

/** Movement in CSS pixels before a stationary touch commits to a drag. */
export const TOUCH_SLOP_PX = 8;
/** Stationary dwell time in ms before long-press fires. */
export const LONG_PRESS_MS = 500;
/** Maximum gap between two taps (or pen taps) to count as a double-tap. */
export const DOUBLE_TAP_MS = 380;
/** Maximum distance in CSS pixels between two touch taps to count as a double-tap. */
export const DOUBLE_TAP_SLOP_PX = 24;
/** Maximum distance in CSS pixels between two pen clicks to count as a double-click. */
export const PEN_DOUBLE_CLICK_SLOP_PX = 6;
/** Minimum finger separation in CSS pixels before pinch scales zoom. */
export const MIN_PINCH_DIST_PX = 10;
/** Window in ms for suppressing browser duplicate contextmenu and synthetic mouse events. */
export const COMPAT_SUPPRESS_MS = 450;

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface CameraSnapshot {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface TouchPoint {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly screen: Point2D;
  readonly client: Point2D;
  readonly button: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
  readonly noSnap: boolean;
  readonly timeStamp: number;
}

export interface MultitouchAnchor {
  readonly camera: CameraSnapshot;
  readonly mid: Point2D;
  readonly dist: number;
  /** Page-space point under `mid` when anchored. */
  readonly page: Point2D;
}

export type ArbiterPhase =
  | "idle"
  | "pending"
  | "single-pan"
  | "tool-drag"
  | "multitouch"
  | "multitouch-tail"
  | "long-press-fired"
  | "pen-active"
  | "palm-cooldown";

export interface TouchArbiterHost {
  readonly workspaceMode: () => WorkspaceMode;
  readonly tool: () => ToolId;
  readonly camera: () => CameraSnapshot;
  readonly setCamera: (next: CameraSnapshot) => void;
  readonly onCameraGestureStart: () => void;
  readonly onCameraGestureEnd: () => void;
  readonly onTap: (point: TouchPoint, clicks: number) => void;
  readonly onLongPress: (point: TouchPoint, mode: WorkspaceMode) => void;
  readonly onToolDragStart: (start: TouchPoint, current: TouchPoint) => void;
  readonly onToolDragMove: (point: TouchPoint) => void;
  readonly onToolDragEnd: (point: TouchPoint) => void;
  readonly onToolDragRollback: () => void;
  readonly onPenDown: (point: TouchPoint, clicks: number) => void;
  readonly onPenMove: (point: TouchPoint) => void;
  readonly onPenUp: (point: TouchPoint) => void;
  readonly onPenCancel: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

/**
 * Whether a single-finger touch drag pans the camera instead of invoking the active tool.
 *
 * - Phones are read-only view-and-comment workspaces: 1-finger drag always pans.
 * - Tablets with an Apple Pencil / stylus seen enter palm-rejection mode: fingers only navigate.
 * - Hand, Comment, and Text tools pan on 1-finger drag so dragging never drops stray pins or boxes.
 * - Tablet Select (Move) and drawing tools act on the canvas with 1 finger while 2 fingers pan/pinch.
 */
export function shouldSingleTouchPan(mode: WorkspaceMode, tool: ToolId, penSeen: boolean): boolean {
  if (mode === "phone") return true;
  if (mode === "tablet" && penSeen) return true;
  return tool === "hand" || tool === "comment" || tool === "text";
}

/** Centroid and span (pair distance for 2 touches, mean diameter for 3+) of active touch points. */
export function touchCentroidAndSpread(points: readonly Point2D[]): { mid: Point2D; dist: number } {
  const n = points.length;
  if (n === 0) return { mid: { x: 0, y: 0 }, dist: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mid = { x: sx / n, y: sy / n };
  if (n === 2) {
    const a = points[0] as Point2D;
    const b = points[1] as Point2D;
    return { mid, dist: Math.hypot(b.x - a.x, b.y - a.y) };
  }
  let spread = 0;
  for (const p of points) spread += Math.hypot(p.x - mid.x, p.y - mid.y);
  return { mid, dist: (spread / n) * 2 };
}

/** Captures the camera and page point anchored at the current fingers' centroid. */
export function makeMultitouchAnchor(
  camera: CameraSnapshot,
  points: readonly Point2D[],
): MultitouchAnchor {
  const { mid, dist } = touchCentroidAndSpread(points);
  const page = {
    x: (mid.x - camera.x) / camera.zoom,
    y: (mid.y - camera.y) / camera.zoom,
  };
  return { camera, mid, dist, page };
}

/**
 * Computes the camera that maps the anchored page point onto the new centroid
 * while scaling zoom proportionally to the finger span ratio.
 */
export function computeMultitouchCamera(
  anchor: MultitouchAnchor,
  points: readonly Point2D[],
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
): { camera: CameraSnapshot; reanchor: boolean } {
  const { mid, dist } = touchCentroidAndSpread(points);
  let zoom = anchor.camera.zoom;
  let reanchor = false;
  if (anchor.dist >= MIN_PINCH_DIST_PX && dist >= MIN_PINCH_DIST_PX) {
    zoom = Math.min(maxZoom, Math.max(minZoom, anchor.camera.zoom * (dist / anchor.dist)));
  } else if (anchor.dist < MIN_PINCH_DIST_PX && dist >= MIN_PINCH_DIST_PX) {
    reanchor = true;
  }
  const x = mid.x - anchor.page.x * zoom;
  const y = mid.y - anchor.page.y * zoom;
  return { camera: { x, y, zoom }, reanchor };
}

export class TouchArbiter {
  readonly #host: TouchArbiterHost;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;

  #phase: ArbiterPhase = "idle";
  readonly #touches = new Map<number, TouchPoint>();
  readonly #suppressedPalms = new Set<number>();
  #primaryId: number | null = null;
  #startPoint: TouchPoint | null = null;
  #longPressHandle: unknown = null;
  #panAnchor: { camera: CameraSnapshot; screen: Point2D } | null = null;
  #multiAnchor: MultitouchAnchor | null = null;
  #cameraGestureActive = false;

  #activePenId: number | null = null;
  #penSeen = false;

  #lastTap: { at: number; client: Point2D; count: number } | null = null;
  #lastPenDown: { at: number; client: Point2D; count: number } | null = null;

  #lastTouchAt = Number.NEGATIVE_INFINITY;
  #lastTouchClient: Point2D | null = null;
  #compatSuppress: { until: number; client: Point2D } | null = null;

  constructor(host: TouchArbiterHost) {
    this.#host = host;
    this.#setTimer = host.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = host.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#now = host.now ?? (() => performance.now());
  }

  get phase(): ArbiterPhase {
    return this.#phase;
  }

  /** True when at least one touch pointer is currently tracked (including suppressed palms). */
  get hasActiveTouch(): boolean {
    return this.#touches.size > 0 || this.#suppressedPalms.size > 0;
  }

  /** True while a stylus/pen has been seen in tablet mode (enables finger-only navigation). */
  get penSeen(): boolean {
    return this.#penSeen;
  }

  /** True while a touch pan or pinch-zoom camera gesture owns the viewport. */
  get cameraGestureActive(): boolean {
    return this.#cameraGestureActive;
  }

  /** Number of currently tracked non-palm touch pointers. */
  get activeTouchCount(): number {
    return this.#touches.size;
  }

  /**
   * Observes pen hover (`pointermove` without button down) in tablet mode so
   * Apple Pencil Hover engages palm rejection before the tip touches glass.
   */
  observePenHover(pointerType: string): void {
    if (pointerType === "pen" && this.#host.workspaceMode() === "tablet") {
      this.#penSeen = true;
    }
  }

  /** Clears compatibility mouse suppression when any new real pointer press begins. */
  clearCompatSuppression(): void {
    this.#compatSuppress = null;
  }

  /** Arms compatibility mouse suppression around `client` after a touch tap or long-press. */
  armCompatSuppression(client: Point2D, now = this.#now()): void {
    this.#compatSuppress = { until: now + COMPAT_SUPPRESS_MS, client };
  }

  /** Whether a browser `contextmenu` event is a duplicate of a recent or active touch. */
  shouldSuppressContextMenu(client: Point2D, now = this.#now()): boolean {
    if (this.hasActiveTouch) return true;
    if (!this.#lastTouchClient) return false;
    return (
      now - this.#lastTouchAt <= COMPAT_SUPPRESS_MS &&
      Math.hypot(client.x - this.#lastTouchClient.x, client.y - this.#lastTouchClient.y) <= 48
    );
  }

  /** Whether a browser synthetic `mousedown`/`mouseup`/`click` matches an armed touch suppression. */
  shouldSuppressCompatMouse(client: Point2D, now = this.#now()): boolean {
    const s = this.#compatSuppress;
    if (!s) return false;
    if (now > s.until) {
      this.#compatSuppress = null;
      return false;
    }
    return Math.hypot(client.x - s.client.x, client.y - s.client.y) <= 32;
  }

  /**
   * Handles `pointerdown`. Returns true when the arbiter took ownership of the pointer
   * (`touch`, or `pen` on tablets); returns false for desktop mouse / desktop pen.
   */
  pointerDown(point: TouchPoint): boolean {
    this.clearCompatSuppression();
    const mode = this.#host.workspaceMode();
    if (point.pointerType === "pen" && mode === "tablet") {
      this.#handlePenDown(point);
      return true;
    }
    if (point.pointerType !== "touch") return false;
    this.#handleTouchDown(point);
    return true;
  }

  /** Handles `pointermove`. Returns true if this pointer belongs to the arbiter. */
  pointerMove(point: TouchPoint): boolean {
    if (point.pointerType === "pen" && this.#activePenId === point.pointerId) {
      this.#host.onPenMove(point);
      return true;
    }
    if (point.pointerType !== "touch") return false;
    this.#handleTouchMove(point);
    return true;
  }

  /** Handles `pointerup`. Returns true if this pointer belongs to the arbiter. */
  pointerUp(point: TouchPoint): boolean {
    if (point.pointerType === "pen" && this.#activePenId === point.pointerId) {
      this.#handlePenUp(point);
      return true;
    }
    if (point.pointerType !== "touch") return false;
    this.#handleTouchUp(point);
    return true;
  }

  /** Handles `pointercancel` (or unexpected `lostpointercapture`). Returns true if owned. */
  pointerCancel(pointerId: number, pointerType: string): boolean {
    if (pointerType === "pen" && this.#activePenId === pointerId) {
      this.#handlePenCancel();
      return true;
    }
    if (pointerType !== "touch") return false;
    this.#handleTouchCancel(pointerId);
    return true;
  }

  /** Handles `lostpointercapture` only if the pointer is still tracked as active. */
  lostPointerCapture(pointerId: number, pointerType: string): boolean {
    if (pointerType === "pen" && this.#activePenId === pointerId) {
      this.#handlePenCancel();
      return true;
    }
    if (
      pointerType === "touch" &&
      (this.#touches.has(pointerId) || this.#suppressedPalms.has(pointerId))
    ) {
      this.#handleTouchCancel(pointerId);
      return true;
    }
    return false;
  }

  /** Cancels every active touch/pen gesture (window blur, tab hidden, unmount). */
  cancelAll(): void {
    this.#clearLongPress();
    if (this.#phase === "tool-drag") {
      this.#host.onToolDragRollback();
    } else if (this.#phase === "pen-active") {
      this.#host.onPenCancel();
    }
    this.#touches.clear();
    this.#suppressedPalms.clear();
    this.#primaryId = null;
    this.#startPoint = null;
    this.#panAnchor = null;
    this.#multiAnchor = null;
    this.#activePenId = null;
    this.#phase = "idle";
    this.#endCameraGesture();
  }

  dispose(): void {
    this.cancelAll();
    this.#compatSuppress = null;
  }

  // -------------------------------------------------------------------------
  // Pen (tablet Apple Pencil / stylus with palm rejection)

  #handlePenDown(point: TouchPoint): void {
    this.#penSeen = true;
    this.#clearLongPress();
    // If a palm or finger touched down right before the Pencil tip landed,
    // immediately cancel/rollback the touch and suppress those contacts as palms.
    if (this.#phase === "tool-drag") {
      this.#host.onToolDragRollback();
    }
    if (this.#cameraGestureActive) {
      this.#endCameraGesture();
    }
    for (const id of this.#touches.keys()) this.#suppressedPalms.add(id);
    this.#touches.clear();
    this.#primaryId = null;
    this.#startPoint = null;
    this.#panAnchor = null;
    this.#multiAnchor = null;

    const now = point.timeStamp > 0 ? point.timeStamp : this.#now();
    const prev = this.#lastPenDown;
    const clicks =
      prev &&
      now - prev.at < DOUBLE_TAP_MS &&
      Math.hypot(point.client.x - prev.client.x, point.client.y - prev.client.y) <
        PEN_DOUBLE_CLICK_SLOP_PX
        ? prev.count + 1
        : 1;
    this.#lastPenDown = { at: now, client: point.client, count: clicks };

    this.#activePenId = point.pointerId;
    this.#phase = "pen-active";
    this.#host.onPenDown(point, clicks);
  }

  #handlePenUp(point: TouchPoint): void {
    this.#activePenId = null;
    this.#host.onPenUp(point);
    this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
  }

  #handlePenCancel(): void {
    this.#activePenId = null;
    this.#host.onPenCancel();
    this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
  }

  // -------------------------------------------------------------------------
  // Touch

  #noteTouch(point: TouchPoint): void {
    this.#lastTouchAt = this.#now();
    this.#lastTouchClient = point.client;
  }

  #handleTouchDown(point: TouchPoint): void {
    this.#noteTouch(point);
    // Active pen owns the canvas: ignore any simultaneous touch as palm contact.
    if (this.#phase === "pen-active") {
      this.#suppressedPalms.add(point.pointerId);
      return;
    }
    // Existing suppressed palms stay ignored; a brand-new touch after pen lift can navigate.
    if (this.#suppressedPalms.has(point.pointerId)) return;
    if (this.#phase === "palm-cooldown") {
      this.#phase = "idle";
    }

    this.#touches.set(point.pointerId, point);

    // Stay quiet while a long-press menu/sheet is already open under the held finger.
    if (this.#phase === "long-press-fired") return;

    if (this.#touches.size === 1) {
      // First finger down: delay tap vs drag vs long-press until slop or time decides.
      this.#primaryId = point.pointerId;
      this.#startPoint = point;
      this.#phase = "pending";
      this.#scheduleLongPress(point);
      return;
    }

    // Second (or additional) finger down: cancel/rollback any uncommitted single-finger interaction
    // and transition to (or re-anchor) centroid pan + anchored pinch-zoom.
    this.#clearLongPress();
    if (this.#phase === "tool-drag") {
      this.#host.onToolDragRollback();
    }
    this.#primaryId = null;
    this.#startPoint = null;
    this.#panAnchor = null;
    this.#phase = "multitouch";
    this.#beginCameraGesture();
    this.#reanchorMultitouch();
  }

  #handleTouchMove(point: TouchPoint): void {
    if (this.#suppressedPalms.has(point.pointerId)) return;
    if (!this.#touches.has(point.pointerId)) return;
    this.#noteTouch(point);
    this.#touches.set(point.pointerId, point);

    switch (this.#phase) {
      case "pending": {
        if (point.pointerId !== this.#primaryId || !this.#startPoint) return;
        const dist = Math.hypot(
          point.screen.x - this.#startPoint.screen.x,
          point.screen.y - this.#startPoint.screen.y,
        );
        if (dist < TOUCH_SLOP_PX) return;
        this.#clearLongPress();
        const mode = this.#host.workspaceMode();
        const tool = this.#host.tool();
        if (shouldSingleTouchPan(mode, tool, this.#penSeen)) {
          this.#phase = "single-pan";
          this.#panAnchor = { camera: this.#host.camera(), screen: this.#startPoint.screen };
          this.#beginCameraGesture();
          this.#applySinglePan(point.screen);
        } else {
          this.#phase = "tool-drag";
          this.#host.onToolDragStart(this.#startPoint, point);
        }
        return;
      }
      case "single-pan":
      case "multitouch-tail": {
        if (point.pointerId !== this.#primaryId) return;
        this.#applySinglePan(point.screen);
        return;
      }
      case "tool-drag": {
        if (point.pointerId !== this.#primaryId) return;
        this.#host.onToolDragMove(point);
        return;
      }
      case "multitouch": {
        this.#applyMultitouch();
        return;
      }
      case "long-press-fired":
      case "pen-active":
      case "palm-cooldown":
      case "idle":
        return;
    }
  }

  #handleTouchUp(point: TouchPoint): void {
    if (this.#suppressedPalms.delete(point.pointerId)) {
      if (this.#phase === "palm-cooldown" && this.#suppressedPalms.size === 0) {
        this.#phase = "idle";
      }
      return;
    }
    if (!this.#touches.has(point.pointerId)) return;
    this.#noteTouch(point);
    this.#touches.delete(point.pointerId);

    switch (this.#phase) {
      case "pending": {
        this.#clearLongPress();
        const mode = this.#host.workspaceMode();
        this.#primaryId = null;
        this.#startPoint = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        // Palm rejection: once a pen has been seen on tablet, finger taps do not edit or select.
        if (mode === "tablet" && this.#penSeen) return;
        const now = point.timeStamp > 0 ? point.timeStamp : this.#now();
        const prev = this.#lastTap;
        const clicks =
          prev &&
          now - prev.at < DOUBLE_TAP_MS &&
          Math.hypot(point.client.x - prev.client.x, point.client.y - prev.client.y) <=
            DOUBLE_TAP_SLOP_PX
            ? prev.count + 1
            : 1;
        this.#lastTap = { at: now, client: point.client, count: clicks };
        this.armCompatSuppression(point.client);
        this.#host.onTap(point, clicks);
        return;
      }
      case "tool-drag": {
        if (point.pointerId !== this.#primaryId) return;
        this.#primaryId = null;
        this.#startPoint = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.armCompatSuppression(point.client);
        this.#host.onToolDragEnd(point);
        return;
      }
      case "single-pan": {
        this.#primaryId = null;
        this.#startPoint = null;
        this.#panAnchor = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.#endCameraGesture();
        return;
      }
      case "multitouch": {
        if (this.#touches.size >= 2) {
          this.#reanchorMultitouch();
          return;
        }
        if (this.#touches.size === 1) {
          // Lifting one finger mid-pinch must NEVER start a tool action: stay in navigation-only tail.
          const remaining = this.#touches.values().next().value as TouchPoint;
          this.#primaryId = remaining.pointerId;
          this.#multiAnchor = null;
          this.#panAnchor = { camera: this.#host.camera(), screen: remaining.screen };
          this.#phase = "multitouch-tail";
          return;
        }
        this.#multiAnchor = null;
        this.#panAnchor = null;
        this.#primaryId = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.#endCameraGesture();
        return;
      }
      case "multitouch-tail": {
        if (this.#touches.size === 0) {
          this.#primaryId = null;
          this.#panAnchor = null;
          this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
          this.#endCameraGesture();
        }
        return;
      }
      case "long-press-fired": {
        this.armCompatSuppression(point.client);
        if (this.#touches.size === 0) {
          this.#primaryId = null;
          this.#startPoint = null;
          this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        }
        return;
      }
      default:
        return;
    }
  }

  #handleTouchCancel(pointerId: number): void {
    if (this.#suppressedPalms.delete(pointerId)) {
      if (this.#phase === "palm-cooldown" && this.#suppressedPalms.size === 0) {
        this.#phase = "idle";
      }
      return;
    }
    if (!this.#touches.has(pointerId)) return;
    this.#touches.delete(pointerId);

    switch (this.#phase) {
      case "pending": {
        this.#clearLongPress();
        this.#primaryId = null;
        this.#startPoint = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        return;
      }
      case "tool-drag": {
        this.#primaryId = null;
        this.#startPoint = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.#host.onToolDragRollback();
        return;
      }
      case "single-pan": {
        this.#primaryId = null;
        this.#startPoint = null;
        this.#panAnchor = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.#endCameraGesture();
        return;
      }
      case "multitouch": {
        if (this.#touches.size >= 2) {
          this.#reanchorMultitouch();
          return;
        }
        if (this.#touches.size === 1) {
          const remaining = this.#touches.values().next().value as TouchPoint;
          this.#primaryId = remaining.pointerId;
          this.#multiAnchor = null;
          this.#panAnchor = { camera: this.#host.camera(), screen: remaining.screen };
          this.#phase = "multitouch-tail";
          return;
        }
        this.#multiAnchor = null;
        this.#panAnchor = null;
        this.#primaryId = null;
        this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        this.#endCameraGesture();
        return;
      }
      case "multitouch-tail": {
        if (this.#touches.size === 0) {
          this.#primaryId = null;
          this.#panAnchor = null;
          this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
          this.#endCameraGesture();
        }
        return;
      }
      case "long-press-fired": {
        if (this.#touches.size === 0) {
          this.#primaryId = null;
          this.#startPoint = null;
          this.#phase = this.#suppressedPalms.size > 0 ? "palm-cooldown" : "idle";
        }
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers

  #scheduleLongPress(point: TouchPoint): void {
    this.#clearLongPress();
    const mode = this.#host.workspaceMode();
    // In tablet pen-seen palm-rejection mode, resting fingers/palms must never open menus.
    if (mode === "tablet" && this.#penSeen) return;
    this.#longPressHandle = this.#setTimer(() => {
      this.#longPressHandle = null;
      if (this.#phase !== "pending" || this.#primaryId !== point.pointerId) return;
      const latest = this.#touches.get(point.pointerId) ?? point;
      this.#phase = "long-press-fired";
      this.#lastTap = null;
      this.#noteTouch(latest);
      this.armCompatSuppression(latest.client);
      this.#host.onLongPress(latest, this.#host.workspaceMode());
    }, LONG_PRESS_MS);
  }

  #clearLongPress(): void {
    if (this.#longPressHandle !== null) {
      this.#clearTimer(this.#longPressHandle);
      this.#longPressHandle = null;
    }
  }

  #beginCameraGesture(): void {
    if (this.#cameraGestureActive) return;
    this.#cameraGestureActive = true;
    this.#host.onCameraGestureStart();
  }

  #endCameraGesture(): void {
    if (!this.#cameraGestureActive) return;
    this.#cameraGestureActive = false;
    this.#host.onCameraGestureEnd();
  }

  #applySinglePan(screen: Point2D): void {
    const anchor = this.#panAnchor;
    if (!anchor) return;
    this.#host.setCamera({
      x: anchor.camera.x + (screen.x - anchor.screen.x),
      y: anchor.camera.y + (screen.y - anchor.screen.y),
      zoom: anchor.camera.zoom,
    });
  }

  #reanchorMultitouch(): void {
    const screens = [...this.#touches.values()].map((t) => t.screen);
    this.#multiAnchor = makeMultitouchAnchor(this.#host.camera(), screens);
  }

  #applyMultitouch(): void {
    if (!this.#multiAnchor || this.#touches.size < 2) return;
    const screens = [...this.#touches.values()].map((t) => t.screen);
    const { camera, reanchor } = computeMultitouchCamera(this.#multiAnchor, screens);
    this.#host.setCamera(camera);
    if (reanchor) this.#reanchorMultitouch();
  }
}
