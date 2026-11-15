/**
 * Camera motion: the smooth zoom and pan path (exact ends, steady progress,
 * no NaN), and the editor playing it frame by frame: any other camera change
 * stops it, a new one takes over, reduced motion jumps, followers still follow.
 */
import type { Peer } from "@drawpane/model";
import { ROOT_ID } from "@drawpane/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import {
  cameraPath,
  easeOut,
  MOTION_MAX_MS,
  MOTION_MIN_MS,
  motionDuration,
} from "../src/camera-motion";
import { Editor, type FrameClock } from "../src/editor";

const ANCHOR = { x: 500, y: 300 };
const SPAN = 1000;

/** The page point at the anchor: where the view is looking. */
const centre = (c: Camera) => c.toPage(ANCHOR);

const camera = fc
  .record({
    x: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
    y: fc.double({ min: -1e5, max: 1e5, noNaN: true }),
    zoom: fc.double({ min: 0.02, max: 256, noNaN: true }),
  })
  .map(({ x, y, zoom }) => new Camera(x, y, zoom));

describe("cameraPath", () => {
  it("starts and ends exactly on the cameras given", () => {
    fc.assert(
      fc.property(camera, camera, (from, to) => {
        const path = cameraPath(from, to, ANCHOR, SPAN);
        expect(path.at(0)).toBe(from);
        expect(path.at(1)).toBe(to);
        expect(path.at(-0.5)).toBe(from);
        expect(path.at(2)).toBe(to);
      }),
    );
  });

  it("never yields NaN or a zero zoom along the way", () => {
    fc.assert(
      fc.property(camera, camera, fc.double({ min: 0, max: 1, noNaN: true }), (from, to, t) => {
        const c = cameraPath(from, to, ANCHOR, SPAN).at(t);
        expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
        expect(c.zoom).toBeGreaterThan(0);
        expect(Number.isFinite(c.zoom)).toBe(true);
      }),
    );
  });

  it("moves the view steadily towards the target, never back", () => {
    fc.assert(
      fc.property(camera, camera, (from, to) => {
        const path = cameraPath(from, to, ANCHOR, SPAN);
        const a = centre(from);
        const b = centre(to);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d === 0) return;
        let last = Number.POSITIVE_INFINITY;
        for (let i = 0; i <= 20; i++) {
          const p = centre(path.at(i / 20));
          const left = Math.hypot(b.x - p.x, b.y - p.y);
          expect(left).toBeLessThanOrEqual(last + d * 1e-6);
          last = left;
        }
      }),
    );
  });

  it("zooms geometrically about the middle when only the zoom changes", () => {
    const from = new Camera(0, 0, 1).zoomAt(ANCHOR, 1);
    const to = from.zoomAt(ANCHOR, 4);
    const path = cameraPath(from, to, ANCHOR, SPAN);
    // Halfway along a 1× → 4× zoom is 2×, not 2.5×: each step feels the same.
    expect(path.at(0.5).zoom).toBeCloseTo(2, 9);
    let last = 1;
    for (let i = 1; i <= 10; i++) {
      const c = path.at(i / 10);
      expect(c.zoom).toBeGreaterThanOrEqual(last);
      last = c.zoom;
      // The point in the middle stays put.
      expect(centre(c).x).toBeCloseTo(centre(from).x, 6);
      expect(centre(c).y).toBeCloseTo(centre(from).y, 6);
    }
  });

  it("pulls back on a long jump so both ends are in view, and barely on a short one", () => {
    const from = new Camera(0, 0, 1);
    const far = cameraPath(from, from.pan(-20_000, 0), ANCHOR, SPAN);
    const near = cameraPath(from, from.pan(-200, 0), ANCHOR, SPAN);
    expect(far.at(0.5).zoom).toBeLessThan(0.1);
    expect(near.at(0.5).zoom).toBeGreaterThan(0.9);
    expect(far.length).toBeGreaterThan(near.length);
  });

  it("is a jump for the same camera or a broken one", () => {
    const c = new Camera(10, 20, 2);
    expect(cameraPath(c, new Camera(10, 20, 2), ANCHOR, SPAN).length).toBe(0);
    const broken = cameraPath(c, new Camera(Number.NaN, 0, 1), ANCHOR, SPAN);
    expect(broken.length).toBe(0);
    expect(cameraPath(c, new Camera(0, 0, 1), ANCHOR, 0).length).toBe(0);
  });
});

describe("easeOut and motionDuration", () => {
  it("eases out from exactly 0 to exactly 1, always forwards", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(3)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = easeOut(i / 100);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // Ease out: most of the way in the first half.
    expect(easeOut(0.5)).toBeGreaterThan(0.8);
  });

  it("takes longer for longer moves, within bounds", () => {
    expect(motionDuration(0)).toBe(0);
    expect(motionDuration(0.01)).toBeGreaterThanOrEqual(MOTION_MIN_MS);
    expect(motionDuration(1)).toBeLessThan(motionDuration(2));
    expect(motionDuration(1000)).toBe(MOTION_MAX_MS);
  });
});

/** A clock the test steps by hand, one frame at a time. */
function manualFrames() {
  let now = 1000;
  let queued: Array<{ id: number; fn: (now: number) => void }> = [];
  let next = 1;
  const clock: FrameClock = {
    request(fn) {
      const id = next++;
      queued.push({ id, fn });
      return id;
    },
    cancel(handle) {
      queued = queued.filter((q) => q.id !== handle);
    },
  };
  return {
    clock,
    get pending() {
      return queued.length;
    },
    /** Runs one frame `ms` after the last. */
    step(ms = 16) {
      now += ms;
      const run = queued;
      queued = [];
      for (const q of run) q.fn(now);
    },
  };
}

function setup(reduced = false) {
  const frames = manualFrames();
  const editor = new Editor({
    measurer: { width: () => 0 },
    clientId: "t",
    frames: frames.clock,
    reducedMotion: () => reduced,
  });
  editor.state.set({
    role: "editor",
    viewport: { width: 1000, height: 600 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  editor.doc.apply([
    { op: "create", id: "p1", type: "page", parent: ROOT_ID, key: "a0", props: {} },
  ]);
  editor.setPage("p1");
  return { editor, frames };
}

const fitOf = (editor: Editor, id: string) => {
  const b = editor.scene.bounds(id);
  if (!b) throw new Error("no bounds");
  return editor.s.camera.fit(b, editor.s.viewport, 64, 8, editor.s.insets);
};

describe("Editor camera animation", () => {
  it("glides over several frames and lands exactly on the fit", () => {
    const { editor, frames } = setup();
    const id = editor.createLayer("rect", { x: 3000, y: 2000, width: 120, height: 80 }, "p1");
    if (!id) throw new Error("no layer");
    const target = fitOf(editor, id);
    const undo = editor.history.canUndo;
    editor.zoomToLayers([id], { animate: true });
    expect(editor.cameraAnimating).toBe(true);
    const seen: Camera[] = [];
    for (let i = 0; i < 60 && editor.cameraAnimating; i++) {
      frames.step();
      seen.push(editor.s.camera);
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.length).toBeLessThanOrEqual(Math.ceil(MOTION_MAX_MS / 16) + 1);
    expect(editor.s.camera.equals(target)).toBe(true);
    expect(frames.pending).toBe(0);
    // Camera moves aren't edits.
    expect(editor.history.canUndo).toBe(undo);
  });

  it("stops where it is when anything else moves the camera", () => {
    const { editor, frames } = setup();
    const id = editor.createLayer("rect", { x: 3000, y: 2000, width: 120, height: 80 }, "p1");
    if (!id) throw new Error("no layer");
    editor.zoomToLayers([id], { animate: true });
    frames.step();
    frames.step();
    // A wheel zoom goes through setCamera, from wherever the view is now.
    editor.zoomBy(1.1);
    const after = editor.s.camera;
    expect(editor.cameraAnimating).toBe(false);
    expect(frames.pending).toBe(0);
    frames.step();
    expect(editor.s.camera).toBe(after);
  });

  it("lets a new glide take over from wherever the view is", () => {
    const { editor, frames } = setup();
    const a = editor.createLayer("rect", { x: 3000, y: 0, width: 100, height: 100 }, "p1");
    const b = editor.createLayer("rect", { x: -3000, y: 0, width: 50, height: 50 }, "p1");
    if (!a || !b) throw new Error("no layer");
    editor.zoomToLayers([a], { animate: true });
    frames.step();
    frames.step();
    editor.zoomToLayers([b], { animate: true });
    expect(frames.pending).toBe(1);
    for (let i = 0; i < 60 && editor.cameraAnimating; i++) frames.step();
    expect(editor.s.camera.equals(fitOf(editor, b))).toBe(true);
  });

  it("jumps straight there with reduced motion", () => {
    const { editor, frames } = setup(true);
    const id = editor.createLayer("rect", { x: 3000, y: 2000, width: 120, height: 80 }, "p1");
    if (!id) throw new Error("no layer");
    const target = fitOf(editor, id);
    editor.zoomToLayers([id], { animate: true });
    expect(editor.cameraAnimating).toBe(false);
    expect(frames.pending).toBe(0);
    expect(editor.s.camera.equals(target)).toBe(true);
  });

  it("fits hidden and zero-size layers by the box they have, never NaN", () => {
    const { editor, frames } = setup();
    const line = editor.createLayer("rect", { x: 400, y: 400, width: 0, height: 0 }, "p1");
    const hidden = editor.createLayer("rect", { x: -900, y: 50, width: 40, height: 30 }, "p1", {
      visible: false,
    });
    if (!line || !hidden) throw new Error("no layer");
    for (const id of [line, hidden]) {
      editor.zoomToLayers([id], { animate: true });
      for (let i = 0; i < 60 && editor.cameraAnimating; i++) {
        frames.step();
        const c = editor.s.camera;
        expect([c.x, c.y, c.zoom].every(Number.isFinite)).toBe(true);
      }
      expect(editor.s.camera.equals(fitOf(editor, id))).toBe(true);
    }
    // Nothing to fit: nothing happens.
    const before = editor.s.camera;
    editor.zoomToLayers(["missing"], { animate: true });
    expect(editor.s.camera).toBe(before);
    expect(editor.cameraAnimating).toBe(false);
  });

  it("stops following someone, and a leader's move stops the glide", () => {
    const { editor, frames } = setup();
    const id = editor.createLayer("rect", { x: 3000, y: 2000, width: 120, height: 80 }, "p1");
    if (!id) throw new Error("no layer");
    const lena: Peer = {
      sessionId: "lena",
      userId: "u-lena",
      name: "Lena Park",
      color: 2,
      kind: "person",
      presence: {
        cursor: null,
        pageId: "p1",
        selection: [],
        viewport: { x: 0, y: 0, width: 500, height: 300 },
      },
    };
    editor.state.set({ peers: new Map([["lena", lena]]) });
    editor.follow("lena");
    expect(editor.s.following).toBe("lena");
    editor.zoomToLayers([id], { animate: true });
    expect(editor.s.following).toBe(null);
    frames.step();

    // Following again: the leader's view replaces the glide at once.
    editor.follow("lena");
    expect(editor.cameraAnimating).toBe(false);
    const shown = editor.visibleArea();
    expect(shown && Math.round(shown.width)).toBe(500);
    frames.step();
    expect(editor.s.following).toBe("lena");
  });

  it("zoomToSelection jumps unless asked to glide", () => {
    const { editor } = setup();
    const id = editor.createLayer("rect", { x: 3000, y: 2000, width: 120, height: 80 }, "p1");
    if (!id) throw new Error("no layer");
    editor.select([id]);
    editor.zoomToSelection();
    expect(editor.cameraAnimating).toBe(false);
    expect(editor.s.camera.equals(fitOf(editor, id))).toBe(true);
  });
});
