import type { ToolId } from "@drawpane/editor";
import { describe, expect, it } from "vitest";
import {
  type CameraSnapshot,
  COMPAT_SUPPRESS_MS,
  computeMultitouchCamera,
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  makeMultitouchAnchor,
  PEN_REJECTION_MS,
  shouldSingleTouchPan,
  TOUCH_SLOP_PX,
  TouchArbiter,
  type TouchPoint,
} from "./touch-arbitration";
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

function harness(
  initial: { mode?: WorkspaceMode; tool?: ToolId; camera?: CameraSnapshot; canEdit?: boolean } = {},
) {
  const clock = new FakeClock();
  let mode: WorkspaceMode = initial.mode ?? "phone";
  let tool: ToolId = initial.tool ?? "select";
  let canEdit = initial.canEdit ?? true;
  let camera: CameraSnapshot = initial.camera ?? { x: 0, y: 0, zoom: 1 };
  const log: string[] = [];

  const arbiter = new TouchArbiter({
    workspaceMode: () => mode,
    tool: () => tool,
    canEdit: () => canEdit,
    camera: () => camera,
    setCamera: (next) => {
      camera = next;
    },
    onCameraGestureStart: () => log.push("camera:start"),
    onCameraGestureEnd: () => log.push("camera:end"),
    onTap: (p, clicks) => log.push(`tap:${p.screen.x},${p.screen.y}:${clicks}`),
    onLongPress: (p, m) => log.push(`longpress:${m}:${p.screen.x},${p.screen.y}`),
    onToolDragStart: (s, c) =>
      log.push(`drag:start:${s.screen.x},${s.screen.y}->${c.screen.x},${c.screen.y}`),
    onToolDragMove: (p) => log.push(`drag:move:${p.screen.x},${p.screen.y}`),
    onToolDragEnd: (p) => log.push(`drag:end:${p.screen.x},${p.screen.y}`),
    onToolDragRollback: () => log.push("drag:rollback"),
    onPenDown: (p, clicks) => log.push(`pen:down:${p.screen.x},${p.screen.y}:${clicks}`),
    onPenMove: (p) => log.push(`pen:move:${p.screen.x},${p.screen.y}`),
    onPenUp: (p) => log.push(`pen:up:${p.screen.x},${p.screen.y}`),
    onPenCancel: () => log.push("pen:cancel"),
    onPromoteExternalTouches: (ids) => log.push(`promote:${ids.join(",")}`),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => clock.now,
  });

  const pt = (
    pointerId: number,
    x: number,
    y: number,
    pointerType: "touch" | "pen" | "mouse" = "touch",
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
    arbiter,
    clock,
    log,
    pt,
    get camera() {
      return camera;
    },
    setMode(m: WorkspaceMode) {
      mode = m;
    },
    setTool(t: ToolId) {
      tool = t;
    },
    setCanEdit(v: boolean) {
      canEdit = v;
    },
    setCamera(c: CameraSnapshot) {
      camera = c;
    },
  };
}

describe("shouldSingleTouchPan", () => {
  it("always pans on phones regardless of tool", () => {
    expect(shouldSingleTouchPan("phone", "select", false)).toBe(true);
    expect(shouldSingleTouchPan("phone", "comment", false)).toBe(true);
    expect(shouldSingleTouchPan("phone", "rect", false)).toBe(true);
  });

  it("uses tool gestures on editable tablets, pans when read-only or during pen rejection", () => {
    expect(shouldSingleTouchPan("tablet", "select", false, true)).toBe(false);
    expect(shouldSingleTouchPan("tablet", "rect", false, true)).toBe(false);
    expect(shouldSingleTouchPan("tablet", "pen", false, true)).toBe(false);
    expect(shouldSingleTouchPan("tablet", "hand", false, true)).toBe(true);
    expect(shouldSingleTouchPan("tablet", "comment", false, true)).toBe(true);
    expect(shouldSingleTouchPan("tablet", "text", false, true)).toBe(true);
    // Read-only tablet (viewer or read-only lock) pans with one finger instead of marquee.
    expect(shouldSingleTouchPan("tablet", "select", false, false)).toBe(true);
    // Palm rejection: while pen rejection is active on tablet, fingers always pan.
    expect(shouldSingleTouchPan("tablet", "select", true, true)).toBe(true);
    expect(shouldSingleTouchPan("tablet", "rect", true, true)).toBe(true);
    expect(shouldSingleTouchPan("tablet", "pen", true, true)).toBe(true);
  });
});

describe("multitouch camera geometry", () => {
  it("translates with bit-exact constant zoom when finger spacing stays constant", () => {
    const start: CameraSnapshot = { x: 40, y: -25, zoom: 1.5 };
    const anchor = makeMultitouchAnchor(start, [
      { x: 100, y: 200 },
      { x: 200, y: 200 },
    ]);
    const next = computeMultitouchCamera(anchor, [
      { x: 175, y: 140 },
      { x: 275, y: 140 },
    ]);
    expect(next.camera.zoom).toBe(1.5);
    expect(next.camera.x).toBeCloseTo(115, 10);
    expect(next.camera.y).toBeCloseTo(-85, 10);
  });

  it("keeps the anchored page point fixed under the centroid while pinching", () => {
    const start: CameraSnapshot = { x: 50, y: 80, zoom: 1 };
    const mid = { x: 200, y: 300 };
    const anchor = makeMultitouchAnchor(start, [
      { x: 150, y: 300 },
      { x: 250, y: 300 },
    ]);
    const pageAtStart = {
      x: (mid.x - start.x) / start.zoom,
      y: (mid.y - start.y) / start.zoom,
    };
    const next = computeMultitouchCamera(anchor, [
      { x: 100, y: 300 },
      { x: 300, y: 300 },
    ]);
    expect(next.camera.zoom).toBeCloseTo(2, 10);
    const pageAfter = {
      x: (mid.x - next.camera.x) / next.camera.zoom,
      y: (mid.y - next.camera.y) / next.camera.zoom,
    };
    expect(pageAfter.x).toBeCloseTo(pageAtStart.x, 10);
    expect(pageAfter.y).toBeCloseTo(pageAtStart.y, 10);
  });

  it("clamps zoom to bounds and avoids blowup when fingers start nearly coincident", () => {
    const anchor = makeMultitouchAnchor({ x: 0, y: 0, zoom: 1 }, [
      { x: 100, y: 100 },
      { x: 102, y: 100 },
    ]);
    const moved = computeMultitouchCamera(anchor, [
      { x: 120, y: 100 },
      { x: 220, y: 100 },
    ]);
    expect(moved.camera.zoom).toBe(1);
    expect(moved.reanchor).toBe(true);
  });
});

describe("TouchArbiter on phones", () => {
  it("classifies tap vs double-tap without moving the camera", () => {
    const h = harness({ mode: "phone" });
    h.arbiter.pointerDown(h.pt(1, 120, 200));
    expect(h.arbiter.phase).toBe("pending");
    expect(h.log).toEqual([]);
    h.arbiter.pointerMove(h.pt(1, 120 + TOUCH_SLOP_PX - 2, 202));
    h.arbiter.pointerUp(h.pt(1, 120 + TOUCH_SLOP_PX - 2, 202));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual([`tap:${120 + TOUCH_SLOP_PX - 2},202:1`]);

    h.clock.advance(120);
    h.arbiter.pointerDown(h.pt(2, 125, 205));
    h.arbiter.pointerUp(h.pt(2, 125, 205));
    expect(h.log.at(-1)).toBe("tap:125,205:2");

    h.clock.advance(DOUBLE_TAP_MS + 50);
    h.arbiter.pointerDown(h.pt(3, 125, 205));
    h.arbiter.pointerUp(h.pt(3, 125, 205));
    expect(h.log.at(-1)).toBe("tap:125,205:1");
  });

  it("pans the camera on one-finger drag past slop and cancels long-press", () => {
    const h = harness({ mode: "phone", camera: { x: 10, y: 20, zoom: 1.25 } });
    h.arbiter.pointerDown(h.pt(1, 100, 100));
    h.clock.advance(100);
    h.arbiter.pointerMove(h.pt(1, 120, 140));
    expect(h.arbiter.phase).toBe("single-pan");
    expect(h.camera).toEqual({ x: 30, y: 60, zoom: 1.25 });
    h.clock.advance(LONG_PRESS_MS + 100);
    h.arbiter.pointerUp(h.pt(1, 120, 140));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["camera:start", "camera:end"]);
  });

  it("routes a stylus on a phone through pan, tap, and long-press", () => {
    const h = harness({ mode: "phone", camera: { x: 0, y: 0, zoom: 1 } });
    expect(h.arbiter.pointerDown(h.pt(7, 100, 100, "pen"))).toBe(true);
    expect(h.arbiter.pointerMove(h.pt(7, 160, 140, "pen"))).toBe(true);
    expect(h.arbiter.phase).toBe("single-pan");
    expect(h.camera).toEqual({ x: 60, y: 40, zoom: 1 });
    expect(h.arbiter.pointerUp(h.pt(7, 160, 140, "pen"))).toBe(true);
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["camera:start", "camera:end"]);

    // Stylus tap on phone still selects.
    expect(h.arbiter.pointerDown(h.pt(8, 200, 220, "pen"))).toBe(true);
    expect(h.arbiter.pointerUp(h.pt(8, 200, 220, "pen"))).toBe(true);
    expect(h.log.at(-1)).toBe("tap:200,220:1");
  });

  it("fires phone long-press after dwell without panning or tapping on release", () => {
    const h = harness({ mode: "phone" });
    h.arbiter.pointerDown(h.pt(1, 180, 260));
    h.clock.advance(LONG_PRESS_MS - 1);
    expect(h.log).toEqual([]);
    h.clock.advance(1);
    expect(h.arbiter.phase).toBe("long-press-fired");
    expect(h.log).toEqual(["longpress:phone:180,260"]);
    expect(h.arbiter.shouldSuppressContextMenu({ x: 180, y: 260 })).toBe(true);
    expect(h.arbiter.shouldSuppressCompatMouse({ x: 180, y: 260 })).toBe(true);
    h.arbiter.pointerMove(h.pt(1, 240, 320));
    h.arbiter.pointerUp(h.pt(1, 240, 320));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["longpress:phone:180,260"]);
    expect(h.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("handles two-finger translation at constant zoom even with sequential pointermove events", () => {
    const h = harness({ mode: "phone", camera: { x: 0, y: 0, zoom: 1 } });
    h.arbiter.pointerDown(h.pt(1, 100, 200));
    h.arbiter.pointerDown(h.pt(2, 200, 200));
    expect(h.arbiter.phase).toBe("multitouch");

    h.arbiter.pointerMove(h.pt(1, 150, 240));
    h.arbiter.pointerMove(h.pt(2, 250, 240));
    expect(h.camera.zoom).toBe(1);
    expect(h.camera.x).toBeCloseTo(50, 10);
    expect(h.camera.y).toBeCloseTo(40, 10);

    h.arbiter.pointerUp(h.pt(1, 150, 240));
    h.arbiter.pointerUp(h.pt(2, 250, 240));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["camera:start", "camera:end"]);
  });
});

describe("TouchArbiter on tablets", () => {
  it("delays tool down until slop and rolls back mid-drag when a second finger lands", () => {
    const h = harness({ mode: "tablet", tool: "select", camera: { x: 0, y: 0, zoom: 1 } });
    h.arbiter.pointerDown(h.pt(1, 100, 100));
    expect(h.log).toEqual([]);

    h.arbiter.pointerMove(h.pt(1, 120, 100));
    expect(h.arbiter.phase).toBe("tool-drag");
    expect(h.log).toEqual(["drag:start:100,100->120,100"]);

    h.arbiter.pointerDown(h.pt(2, 220, 100));
    expect(h.arbiter.phase).toBe("multitouch");
    expect(h.log).toEqual(["drag:start:100,100->120,100", "drag:rollback", "camera:start"]);

    h.arbiter.pointerMove(h.pt(1, 70, 100));
    h.arbiter.pointerMove(h.pt(2, 270, 100));
    expect(h.camera.zoom).toBeCloseTo(2, 6);

    h.arbiter.pointerUp(h.pt(2, 270, 100));
    expect(h.arbiter.phase).toBe("multitouch-tail");
    const zoomAfterLift = h.camera.zoom;
    h.arbiter.pointerMove(h.pt(1, 90, 110));
    expect(h.camera.zoom).toBe(zoomAfterLift);

    h.arbiter.pointerDown(h.pt(3, 190, 110));
    expect(h.arbiter.phase).toBe("multitouch");

    h.arbiter.pointerUp(h.pt(3, 190, 110));
    h.arbiter.pointerUp(h.pt(1, 90, 110));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual([
      "drag:start:100,100->120,100",
      "drag:rollback",
      "camera:start",
      "camera:end",
    ]);
  });

  it("pans on one-finger drag when a tablet is read-only (viewer or read-only lock)", () => {
    const h = harness({ mode: "tablet", tool: "select", canEdit: false });
    h.arbiter.pointerDown(h.pt(1, 100, 100));
    h.arbiter.pointerMove(h.pt(1, 150, 130));
    expect(h.arbiter.phase).toBe("single-pan");
    expect(h.camera).toEqual({ x: 50, y: 30, zoom: 1 });
    h.arbiter.pointerUp(h.pt(1, 150, 130));
    expect(h.log).toEqual(["camera:start", "camera:end"]);
  });

  it("never invokes tool drag when a second finger lands within touch slop", () => {
    const h = harness({ mode: "tablet", tool: "rect" });
    h.arbiter.pointerDown(h.pt(1, 200, 200));
    h.arbiter.pointerMove(h.pt(1, 203, 202));
    h.arbiter.pointerDown(h.pt(2, 303, 202));
    expect(h.arbiter.phase).toBe("multitouch");
    h.arbiter.pointerMove(h.pt(1, 253, 252));
    h.arbiter.pointerMove(h.pt(2, 353, 252));
    h.arbiter.pointerUp(h.pt(1, 253, 252));
    h.arbiter.pointerUp(h.pt(2, 353, 252));
    expect(h.log).toEqual(["camera:start", "camera:end"]);
    expect(h.camera.x).toBeCloseTo(50, 10);
    expect(h.camera.y).toBeCloseTo(50, 10);
  });

  it("rolls back an uncommitted tool drag on pointercancel", () => {
    const h = harness({ mode: "tablet", tool: "select" });
    h.arbiter.pointerDown(h.pt(1, 100, 100));
    h.arbiter.pointerMove(h.pt(1, 130, 100));
    expect(h.arbiter.phase).toBe("tool-drag");
    h.arbiter.pointerCancel(1, "touch");
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["drag:start:100,100->130,100", "drag:rollback"]);
  });

  it("opens tablet context menu on stationary long-press", () => {
    const h = harness({ mode: "tablet", tool: "select" });
    h.arbiter.pointerDown(h.pt(1, 300, 250));
    h.clock.advance(LONG_PRESS_MS);
    expect(h.arbiter.phase).toBe("long-press-fired");
    expect(h.log).toEqual(["longpress:tablet:300,250"]);
    h.arbiter.pointerUp(h.pt(1, 300, 250));
    expect(h.arbiter.phase).toBe("idle");
  });

  it("time-boxes Apple Pencil palm rejection to active pen plus 1 s, then restores finger selection", () => {
    const h = harness({ mode: "tablet", tool: "rect" });
    // Palm lands first within slop, then Pencil touches down: palm is suppressed, pen draws.
    h.arbiter.pointerDown(h.pt(1, 400, 400, "touch"));
    h.arbiter.pointerDown(h.pt(10, 200, 200, "pen"));
    expect(h.arbiter.penRejectionActive).toBe(true);
    expect(h.arbiter.phase).toBe("pen-active");

    // Holding pen down longer than PEN_REJECTION_MS keeps palm rejection active the entire stroke.
    h.clock.advance(PEN_REJECTION_MS + 500);
    expect(h.arbiter.penRejectionActive).toBe(true);
    h.arbiter.pointerDown(h.pt(2, 420, 420, "touch"));
    h.arbiter.pointerMove(h.pt(1, 460, 460, "touch"));
    h.arbiter.pointerMove(h.pt(10, 280, 260, "pen"));
    h.arbiter.pointerUp(h.pt(10, 280, 260, "pen"));
    expect(h.arbiter.phase).toBe("palm-cooldown");

    // Resting palms moving/lifting after pen lift never pan or tap.
    h.arbiter.pointerMove(h.pt(1, 520, 520, "touch"));
    h.arbiter.pointerUp(h.pt(1, 520, 520, "touch"));
    h.arbiter.pointerUp(h.pt(2, 420, 420, "touch"));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.camera).toEqual({ x: 0, y: 0, zoom: 1 });

    // Within 1 s after pen lift: finger drag pans and tap/long-press are rejected.
    h.clock.advance(200);
    expect(h.arbiter.penRejectionActive).toBe(true);
    h.arbiter.pointerDown(h.pt(3, 100, 100, "touch"));
    h.arbiter.pointerMove(h.pt(3, 160, 130, "touch"));
    expect(h.arbiter.phase).toBe("single-pan");
    expect(h.camera).toEqual({ x: 60, y: 30, zoom: 1 });
    h.arbiter.pointerUp(h.pt(3, 160, 130, "touch"));

    // A palm resting down before the 1 s window expires and lifting after still cannot fire a tap.
    h.clock.advance(700); // 900 ms since pen up
    h.arbiter.pointerDown(h.pt(4, 150, 150, "touch"));
    h.clock.advance(300); // 1200 ms since pen up
    h.arbiter.pointerUp(h.pt(4, 150, 150, "touch"));
    expect(h.log.some((e) => e.startsWith("tap:"))).toBe(false);

    // Once past 1 s with no pen events, fingers select, drag tools, and long-press again!
    expect(h.arbiter.penRejectionActive).toBe(false);
    h.arbiter.pointerDown(h.pt(5, 180, 180, "touch"));
    h.arbiter.pointerUp(h.pt(5, 180, 180, "touch"));
    expect(h.log.at(-1)).toBe("tap:180,180:1");

    h.arbiter.pointerDown(h.pt(6, 200, 200, "touch"));
    h.clock.advance(LONG_PRESS_MS);
    expect(h.log.at(-1)).toBe("longpress:tablet:200,200");
    h.arbiter.pointerUp(h.pt(6, 200, 200, "touch"));
  });

  it("time-boxes pen hover palm rejection and tracks pen double-clicks", () => {
    const h = harness({ mode: "tablet", tool: "select" });
    expect(h.arbiter.penRejectionActive).toBe(false);
    h.arbiter.observePenHover("pen");
    expect(h.arbiter.penRejectionActive).toBe(true);
    // Finger drag pans while hover rejection is active.
    h.arbiter.pointerDown(h.pt(1, 100, 100, "touch"));
    h.arbiter.pointerMove(h.pt(1, 140, 120, "touch"));
    expect(h.arbiter.phase).toBe("single-pan");
    h.arbiter.pointerUp(h.pt(1, 140, 120, "touch"));

    // After 1 s without hover, finger tap selects again.
    h.clock.advance(PEN_REJECTION_MS);
    expect(h.arbiter.penRejectionActive).toBe(false);
    h.arbiter.pointerDown(h.pt(2, 120, 120, "touch"));
    h.arbiter.pointerUp(h.pt(2, 120, 120, "touch"));
    expect(h.log.at(-1)).toBe("tap:120,120:1");

    // Two quick pen taps within 6 px count as double-click; a far tap resets to 1.
    h.arbiter.pointerDown(h.pt(10, 200, 200, "pen"));
    h.arbiter.pointerUp(h.pt(10, 200, 200, "pen"));
    h.clock.advance(100);
    h.arbiter.pointerDown(h.pt(11, 202, 201, "pen"));
    h.arbiter.pointerUp(h.pt(11, 202, 201, "pen"));
    h.clock.advance(100);
    h.arbiter.pointerDown(h.pt(12, 260, 260, "pen"));
    h.arbiter.pointerUp(h.pt(12, 260, 260, "pen"));
    expect(h.log.filter((e) => e.startsWith("pen:down:"))).toEqual([
      "pen:down:200,200:1",
      "pen:down:202,201:2",
      "pen:down:260,260:1",
    ]);
  });
});

describe("page-wide touch arbitration (floating chrome & external panels)", () => {
  it("rolls back a canvas drag and enters pinch when finger 2 lands on floating chrome", () => {
    const h = harness({ mode: "tablet", tool: "select", camera: { x: 0, y: 0, zoom: 1 } });
    h.arbiter.pointerDown(h.pt(1, 200, 200));
    h.arbiter.pointerMove(h.pt(1, 230, 200));
    expect(h.arbiter.phase).toBe("tool-drag");

    // Finger 2 lands on Lens (usable floating chrome over canvas).
    expect(h.arbiter.externalTouchDown(h.pt(2, 130, 200), true)).toBe(true);
    expect(h.arbiter.phase).toBe("multitouch");
    expect(h.arbiter.isPromotedTouch(2)).toBe(true);
    expect(h.log).toEqual(["drag:start:200,200->230,200", "drag:rollback", "camera:start"]);

    // Spread fingers from 100 px -> 200 px => 2x zoom.
    h.arbiter.pointerMove(h.pt(1, 280, 200));
    h.arbiter.pointerMove(h.pt(2, 80, 200));
    expect(h.camera.zoom).toBeCloseTo(2, 6);

    // Lifting promoted finger 2 arms compat mouse suppression so chrome buttons don't click.
    h.arbiter.pointerUp(h.pt(2, 80, 200));
    expect(h.arbiter.shouldSuppressCompatMouse({ x: 80, y: 200 })).toBe(true);
    expect(h.arbiter.phase).toBe("multitouch-tail");
    h.arbiter.pointerUp(h.pt(1, 280, 200));
    expect(h.arbiter.phase).toBe("idle");
  });

  it("promotes finger 1 on floating chrome into pinch when finger 2 lands on canvas", () => {
    const h = harness({ mode: "tablet", tool: "select", camera: { x: 0, y: 0, zoom: 1 } });
    // Finger 1 lands on Lens (or TextEditor) and shifts slightly before finger 2 arrives.
    expect(h.arbiter.externalTouchDown(h.pt(1, 100, 200), true)).toBe(false);
    h.arbiter.externalTouchMove(h.pt(1, 110, 200));
    expect(h.arbiter.phase).toBe("idle");

    // Finger 2 lands on canvas: promotes finger 1, never starts pending/tool-drag.
    h.arbiter.pointerDown(h.pt(2, 210, 200));
    expect(h.arbiter.phase).toBe("multitouch");
    expect(h.arbiter.isPromotedTouch(1)).toBe(true);
    expect(h.log).toEqual(["promote:1", "camera:start"]);

    h.arbiter.pointerMove(h.pt(1, 60, 200));
    h.arbiter.pointerMove(h.pt(2, 260, 200));
    expect(h.camera.zoom).toBeCloseTo(2, 6);

    h.arbiter.pointerUp(h.pt(1, 60, 200));
    h.arbiter.pointerUp(h.pt(2, 260, 200));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["promote:1", "camera:start", "camera:end"]);
  });

  it("blocks canvas drags without pinching when another touch is on non-usable chrome", () => {
    const h = harness({ mode: "tablet", tool: "select", camera: { x: 0, y: 0, zoom: 1 } });
    // Finger 1 starts dragging a layer on canvas; finger 2 lands on Inspector (usable: false).
    h.arbiter.pointerDown(h.pt(1, 200, 200));
    h.arbiter.pointerMove(h.pt(1, 230, 200));
    expect(h.arbiter.phase).toBe("tool-drag");
    expect(h.arbiter.externalTouchDown(h.pt(2, 950, 300), false)).toBe(false);
    expect(h.arbiter.phase).toBe("blocked");
    expect(h.log).toEqual(["drag:start:200,200->230,200", "drag:rollback"]);

    // Further movement or lifting of finger 1 does NOT pan, drag, or tap.
    h.arbiter.pointerMove(h.pt(1, 280, 240));
    h.arbiter.externalTouchUp(2);
    h.arbiter.pointerUp(h.pt(1, 280, 240));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(h.log).toEqual(["drag:start:200,200->230,200", "drag:rollback"]);

    // Reverse order: finger 1 already on Inspector, finger 2 lands on canvas and drags -> blocked!
    expect(h.arbiter.externalTouchDown(h.pt(3, 950, 300), false)).toBe(false);
    h.arbiter.pointerDown(h.pt(4, 300, 300));
    expect(h.arbiter.phase).toBe("blocked");
    h.arbiter.pointerMove(h.pt(4, 360, 340));
    h.arbiter.pointerUp(h.pt(4, 360, 340));
    h.arbiter.externalTouchUp(3);
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log).toEqual(["drag:start:200,200->230,200", "drag:rollback"]);
  });
});

describe("desktop pass-through and duplicate suppression", () => {
  it("leaves desktop mouse and pen tablets completely untouched", () => {
    const h = harness({ mode: "desktop" });
    expect(h.arbiter.pointerDown(h.pt(1, 100, 100, "mouse"))).toBe(false);
    expect(h.arbiter.pointerDown(h.pt(2, 100, 100, "pen"))).toBe(false);
    h.arbiter.observePenHover("pen");
    expect(h.arbiter.penRejectionActive).toBe(false);
    expect(h.log).toEqual([]);
  });

  it("clears compatibility suppression on timeout or next pointerdown", () => {
    const h = harness({ mode: "phone" });
    h.arbiter.pointerDown(h.pt(1, 200, 200));
    h.arbiter.pointerUp(h.pt(1, 200, 200));
    expect(h.arbiter.shouldSuppressCompatMouse({ x: 205, y: 205 })).toBe(true);
    expect(h.arbiter.shouldSuppressCompatMouse({ x: 350, y: 350 })).toBe(false);
    h.clock.advance(COMPAT_SUPPRESS_MS + 1);
    expect(h.arbiter.shouldSuppressCompatMouse({ x: 205, y: 205 })).toBe(false);
    expect(h.arbiter.shouldSuppressContextMenu({ x: 205, y: 205 })).toBe(false);
  });

  it("handles three-finger re-anchoring, lostpointercapture rollback, and cancelAll cleanup", () => {
    const h = harness({ mode: "tablet", tool: "select", camera: { x: 0, y: 0, zoom: 1 } });
    h.arbiter.pointerDown(h.pt(1, 100, 200));
    h.arbiter.pointerDown(h.pt(2, 200, 200));
    expect(h.arbiter.phase).toBe("multitouch");
    h.arbiter.pointerDown(h.pt(3, 150, 300));
    expect(h.arbiter.activeTouchCount).toBe(3);
    h.arbiter.pointerMove(h.pt(3, 180, 330));
    expect(h.arbiter.phase).toBe("multitouch");
    h.arbiter.pointerUp(h.pt(3, 180, 330));
    expect(h.arbiter.phase).toBe("multitouch");
    expect(h.arbiter.activeTouchCount).toBe(2);
    h.arbiter.pointerUp(h.pt(2, 200, 200));
    h.arbiter.pointerUp(h.pt(1, 100, 200));
    expect(h.arbiter.phase).toBe("idle");
    expect(h.arbiter.cameraGestureActive).toBe(false);

    expect(h.arbiter.lostPointerCapture(999, "touch")).toBe(false);
    h.arbiter.pointerDown(h.pt(4, 100, 100));
    h.arbiter.pointerMove(h.pt(4, 140, 100));
    expect(h.arbiter.phase).toBe("tool-drag");
    expect(h.arbiter.lostPointerCapture(4, "touch")).toBe(true);
    expect(h.arbiter.phase).toBe("idle");
    expect(h.log.at(-1)).toBe("drag:rollback");

    h.arbiter.pointerDown(h.pt(5, 100, 100));
    h.arbiter.pointerMove(h.pt(5, 130, 100));
    expect(h.arbiter.phase).toBe("tool-drag");
    h.arbiter.cancelAll();
    expect(h.arbiter.phase).toBe("idle");
    expect(h.arbiter.hasActiveTouch).toBe(false);
    expect(h.log.at(-1)).toBe("drag:rollback");
  });
});
