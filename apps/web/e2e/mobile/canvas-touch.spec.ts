/**
 * Touch gesture arbitration on phones and tablets using real Chromium CDP touch
 * (`Input.dispatchTouchEvent`) and stylus (`Input.dispatchMouseEvent` with
 * `pointerType: "pen"`) injection.
 *
 * Verifies:
 * - Phone (393 x 852): tap selects for Inspect, one-finger drag pans camera
 *   at constant zoom even over selected layers, stylus drag pans camera,
 *   two-finger translation moves camera at constant zoom, two-finger pinch
 *   zooms around its centroid with 0 React commits per move, stationary hold
 *   starts a comment draft, and touchcancel recovers cleanly.
 * - Tablet (1024 x 768 & 768 x 1024): tap selects (including a 5 px layer
 *   4 px right of a selection at 50% zoom), one-finger drag on a layer moves
 *   it, empty-canvas drag marquees in Select tool and pans in Hand tool or
 *   when read-only, two-finger pinch over resize handles (both within slop
 *   and mid-drag rollback) or with one finger on the Selection Lens / text
 *   editing box / side panel leaves geometry, selection, undo/redo, and
 *   comment drafts unchanged, lifting finger 2 mid-pinch stays in 1:1 pan
 *   tail and re-adding finger 3 resumes pinch without jumping, long-press
 *   opens the context menu, Apple Pencil draws with concurrent palm rejection
 *   and expires ~1 s after pen lift so fingers select again, and a two-client
 *   drag holds for 200 ms then streams live (and syncs the revert if a second
 *   finger cancels after 200 ms).
 */
import { join } from "node:path";
import { type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";

const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR ?? "";

interface DeviceProfile {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

const PHONE_393: DeviceProfile = {
  name: "phone-393",
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const TABLET_1024: DeviceProfile = {
  name: "tablet-1024-landscape",
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const TABLET_768: DeviceProfile = {
  name: "tablet-768-portrait",
  viewport: { width: 768, height: 1024 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

interface DebugEditor {
  readonly s: {
    readonly pageId: string;
    readonly role: string;
    readonly readOnly: boolean;
    readonly tool: string;
    readonly selection: readonly string[];
    readonly editingText: string | null;
    readonly gesture: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly camera: {
      readonly x: number;
      readonly y: number;
      readonly zoom: number;
      toScreen(p: { x: number; y: number }): { x: number; y: number };
      toPage(p: { x: number; y: number }): { x: number; y: number };
    };
  };
  readonly history: {
    readonly undoDepth: number;
    readonly redoDepth: number;
  };
  readonly sync: {
    readonly revn: number | null;
    readonly pendingCount: number;
    readonly holding: boolean;
  };
  readonly doc: {
    readonly version: number;
    get(id: string): { id: string; type: string; props: Record<string, unknown> } | undefined;
    childIds(id: string): readonly string[];
  };
  readonly scene: {
    bounds(id: string): { x: number; y: number; width: number; height: number } | null;
  };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  setTool(tool: string): void;
  setReadOnly(readOnly: boolean): void;
  startTextEdit(id: string): void;
  endTextEdit(): void;
  zoomTo(zoom: number): void;
  centerOn(p: { x: number; y: number }): void;
  undo(): void;
}

type DebugWindow = Window & { drawpane: DebugEditor };
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

async function maybeShot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  await page.screenshot({ path: join(SHOTS_DIR, name) });
}

interface Pt {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

async function touchStart(cdp: CDPSession, points: readonly Pt[]) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
  });
}

async function touchMove(cdp: CDPSession, points: readonly Pt[]) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
  });
}

/** Releases the listed touch points (empty array releases all active touch points). */
async function touchEnd(cdp: CDPSession, released: readonly Pt[] = []) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: released.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
  });
}

async function touchCancel(cdp: CDPSession) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
}

async function cdpTap(cdp: CDPSession, x: number, y: number, id = 1) {
  // Pipeline touchStart + touchEnd on the same CDP session so CPU spikes cannot insert
  // a >500 ms stall that would misclassify a tap as a long-press.
  await Promise.all([touchStart(cdp, [{ id, x, y }]), touchEnd(cdp, [])]);
}

async function cdpDrag(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
  id = 1,
) {
  const ops: Promise<unknown>[] = [touchStart(cdp, [{ id, x: from.x, y: from.y }])];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ops.push(
      touchMove(cdp, [{ id, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }]),
    );
  }
  ops.push(touchEnd(cdp, []));
  await Promise.all(ops);
}

async function cdpTwoFingerPan(
  cdp: CDPSession,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  dx: number,
  dy: number,
  steps = 8,
) {
  const ops: Promise<unknown>[] = [
    touchStart(cdp, [{ id: 1, x: p1.x, y: p1.y }]),
    touchStart(cdp, [
      { id: 1, x: p1.x, y: p1.y },
      { id: 2, x: p2.x, y: p2.y },
    ]),
  ];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ops.push(
      touchMove(cdp, [
        { id: 1, x: p1.x + dx * t, y: p1.y + dy * t },
        { id: 2, x: p2.x + dx * t, y: p2.y + dy * t },
      ]),
    );
  }
  ops.push(touchEnd(cdp, [{ id: 2, x: p2.x + dx, y: p2.y + dy }]));
  ops.push(touchEnd(cdp, [{ id: 1, x: p1.x + dx, y: p1.y + dy }]));
  await Promise.all(ops);
}

async function cdpPinch(
  cdp: CDPSession,
  center: { x: number; y: number },
  startHalfSpan: number,
  endHalfSpan: number,
  steps = 8,
) {
  const f1 = (half: number) => ({ id: 1, x: center.x - half, y: center.y });
  const f2 = (half: number) => ({ id: 2, x: center.x + half, y: center.y });
  const ops: Promise<unknown>[] = [
    touchStart(cdp, [f1(startHalfSpan)]),
    touchStart(cdp, [f1(startHalfSpan), f2(startHalfSpan)]),
  ];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const half = startHalfSpan + (endHalfSpan - startHalfSpan) * t;
    ops.push(touchMove(cdp, [f1(half), f2(half)]));
  }
  ops.push(touchEnd(cdp, [f2(endHalfSpan)]));
  ops.push(touchEnd(cdp, [f1(endHalfSpan)]));
  await Promise.all(ops);
}

async function waitFrames(page: Page, count = 2) {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const step = () => {
          if (--left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    count,
  );
}

async function rectScreenBox(page: Page, id: string) {
  return page.evaluate((nid) => {
    const ed = (window as unknown as DebugWindow).drawpane;
    const b = ed.scene.bounds(nid);
    if (!b) throw new Error("missing bounds");
    const tl = ed.s.camera.toScreen({ x: b.x, y: b.y });
    const br = ed.s.camera.toScreen({ x: b.x + b.width, y: b.y + b.height });
    return {
      left: tl.x,
      top: tl.y,
      right: br.x,
      bottom: br.y,
      cx: (tl.x + br.x) / 2,
      cy: (tl.y + br.y) / 2,
    };
  }, id);
}

async function readSnapshot(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const ed = (window as unknown as DebugWindow).drawpane;
    const node = ed.doc.get(id);
    const props = node?.props ?? {};
    return {
      camera: { x: ed.s.camera.x, y: ed.s.camera.y, zoom: ed.s.camera.zoom },
      selection: [...ed.s.selection],
      editingText: ed.s.editingText,
      tool: ed.s.tool,
      readOnly: ed.s.readOnly,
      gesture: ed.s.gesture,
      undoDepth: ed.history.undoDepth,
      redoDepth: ed.history.redoDepth,
      revn: ed.sync.revn,
      pendingCount: ed.sync.pendingCount,
      holding: ed.sync.holding,
      childCount: ed.doc.childIds(ed.s.pageId).length,
      node: node
        ? {
            x: Number(props.x),
            y: Number(props.y),
            width: Number(props.width),
            height: Number(props.height),
          }
        : null,
    };
  }, nodeId);
}

async function openTouchPage(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  baseURL: string,
  storageState: StorageState,
  profile: DeviceProfile,
  fileUrl: string,
) {
  const context = await browser.newContext({
    baseURL,
    storageState,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  });
  await context.addInitScript(() => {
    localStorage.setItem("drawpane:debug", "1");
    // Count React commits during touch moves (React calls onCommitFiberRoot even in prod builds).
    const w = window as unknown as {
      __reactCommits?: number;
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        supportsFiber: boolean;
        inject: () => number;
        onCommitFiberRoot: () => void;
        onCommitFiberUnmount: () => void;
      };
    };
    w.__reactCommits = 0;
    if (!w.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      let nextId = 1;
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        inject: () => nextId++,
        onCommitFiberRoot: () => {
          w.__reactCommits = (w.__reactCommits ?? 0) + 1;
        },
        onCommitFiberUnmount: () => {},
      };
    }
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(fileUrl);
  await page.waitForFunction(
    () => {
      const ed = (window as unknown as Partial<DebugWindow>).drawpane;
      return Boolean(ed?.s.pageId && ed.doc.childIds(ed.s.pageId).length > 0);
    },
    undefined,
    { timeout: 15_000 },
  );
  // Wait for sync live + initial layout fit.
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await page.waitForTimeout(150);
  return { context, page, cdp };
}

test.describe("Mobile and tablet touch gesture arbitration", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

  let instance: Instance;
  let storageState: StorageState;
  let fileUrl: string;
  let rectAId: string;
  let rectBId: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const port = Number(process.env.TOUCH_E2E_PORT ?? 8842);
    instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
    const page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await page.getByRole("button", { name: "New file", exact: true }).first().click();
    await expect(page).toHaveURL(/\/f\//);
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
    fileUrl = page.url();

    const ids = await page.evaluate(() => {
      const ed = (window as unknown as DebugWindow).drawpane;
      const pageId = ed.s.pageId;
      const a = ed.createLayer("rect", { x: 200, y: 200, width: 160, height: 100 }, pageId, {
        name: "Primary Card",
        fills: [{ type: "solid", color: "#3b82f6" }],
      }) as string;
      const b = ed.createLayer("rect", { x: 440, y: 200, width: 120, height: 100 }, pageId, {
        name: "Secondary Card",
        fills: [{ type: "solid", color: "#10b981" }],
      }) as string;
      return { a, b };
    });
    rectAId = ids.a;
    rectBId = ids.b;
    await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
    storageState = await instance.context.storageState();
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  test("phone: tap selects, 1-finger and stylus drag pan, 2-finger pan/pinch anchors cleanly, long-press starts comment, touchcancel recovers", async ({
    browser,
  }) => {
    const { context, page, cdp } = await openTouchPage(
      browser,
      instance.url,
      storageState,
      PHONE_393,
      fileUrl,
    );
    try {
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 280, y: 250 });
        ed.select([]);
      });
      await page.waitForTimeout(80);

      const rectCenter = await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        const b = ed.scene.bounds(id);
        if (!b) throw new Error("missing bounds");
        return ed.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      }, rectAId);

      // 1. Tap selects layer for Inspect.
      const beforeTap = await readSnapshot(page, rectAId);
      expect(beforeTap.readOnly).toBe(true);
      await cdpTap(cdp, rectCenter.x, rectCenter.y);
      const afterTap = await readSnapshot(page, rectAId);
      expect(afterTap.selection).toEqual([rectAId]);
      expect(afterTap.camera).toEqual(beforeTap.camera);
      expect(afterTap.node).toEqual(beforeTap.node);

      // 2. One-finger drag starting right over the selected layer pans the camera at constant zoom.
      await cdpDrag(
        cdp,
        { x: rectCenter.x, y: rectCenter.y },
        { x: rectCenter.x + 70, y: rectCenter.y + 45 },
      );
      const afterOneFingerPan = await readSnapshot(page, rectAId);
      expect(afterOneFingerPan.camera.zoom).toBeCloseTo(afterTap.camera.zoom, 4);
      expect(afterOneFingerPan.camera.x - afterTap.camera.x).toBeCloseTo(70, 0);
      expect(afterOneFingerPan.camera.y - afterTap.camera.y).toBeCloseTo(45, 0);
      expect(afterOneFingerPan.node).toEqual(beforeTap.node);
      expect(afterOneFingerPan.undoDepth).toBe(beforeTap.undoDepth);

      // 2b. Stylus (pointerType: "pen") drag on a phone also pans the camera.
      const beforePhonePen = await readSnapshot(page, rectAId);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 160,
        y: 380,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "pen",
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 215,
        y: 420,
        button: "left",
        buttons: 1,
        pointerType: "pen",
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 215,
        y: 420,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "pen",
      });
      const afterPhonePen = await readSnapshot(page, rectAId);
      expect(afterPhonePen.camera.x - beforePhonePen.camera.x).toBeCloseTo(55, 0);
      expect(afterPhonePen.camera.y - beforePhonePen.camera.y).toBeCloseTo(40, 0);
      expect(afterPhonePen.camera.zoom).toBeCloseTo(beforePhonePen.camera.zoom, 4);

      // 3. Two-finger translation moves camera at constant zoom, leaving layer & selection untouched.
      const beforeTwoPan = await readSnapshot(page, rectAId);
      await cdpTwoFingerPan(cdp, { x: 140, y: 360 }, { x: 250, y: 360 }, -60, -40);
      const afterTwoPan = await readSnapshot(page, rectAId);
      expect(afterTwoPan.camera.zoom).toBeCloseTo(beforeTwoPan.camera.zoom, 4);
      expect(afterTwoPan.camera.x - beforeTwoPan.camera.x).toBeCloseTo(-60, 0);
      expect(afterTwoPan.camera.y - beforeTwoPan.camera.y).toBeCloseTo(-40, 0);
      expect(afterTwoPan.node).toEqual(beforeTap.node);
      expect(afterTwoPan.selection).toEqual([rectAId]);
      expect(afterTwoPan.undoDepth).toBe(beforeTap.undoDepth);

      // 4. Two-finger pinch zooms around its centroid with zero React re-renders per move.
      const pinchCenter = { x: 196, y: 400 };
      const pageAnchorBefore = await page.evaluate((pt) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        return {
          page: ed.s.camera.toPage(pt),
          zoom: ed.s.camera.zoom,
        };
      }, pinchCenter);
      await Promise.all([
        touchStart(cdp, [{ id: 1, x: pinchCenter.x - 50, y: pinchCenter.y }]),
        touchStart(cdp, [
          { id: 1, x: pinchCenter.x - 50, y: pinchCenter.y },
          { id: 2, x: pinchCenter.x + 50, y: pinchCenter.y },
        ]),
        // Move 1 starts the pinch and lets gesture-start UI state settle.
        touchMove(cdp, [
          { id: 1, x: pinchCenter.x - 55, y: pinchCenter.y },
          { id: 2, x: pinchCenter.x + 55, y: pinchCenter.y },
        ]),
      ]);
      await waitFrames(page, 2);
      const commitsBeforePinchMoves = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      const phoneMoves: Promise<unknown>[] = [];
      for (let i = 2; i <= 10; i++) {
        const half = 50 + 50 * (i / 10);
        phoneMoves.push(
          touchMove(cdp, [
            { id: 1, x: pinchCenter.x - half, y: pinchCenter.y },
            { id: 2, x: pinchCenter.x + half, y: pinchCenter.y },
          ]),
        );
      }
      await Promise.all(phoneMoves);
      const commitsAfterPinchMoves = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      expect(commitsAfterPinchMoves - commitsBeforePinchMoves).toBe(0);
      await Promise.all([
        touchEnd(cdp, [{ id: 2, x: pinchCenter.x + 100, y: pinchCenter.y }]),
        touchEnd(cdp, [{ id: 1, x: pinchCenter.x - 100, y: pinchCenter.y }]),
      ]);
      const afterPinch = await page.evaluate((pt) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        return {
          page: ed.s.camera.toPage(pt),
          zoom: ed.s.camera.zoom,
        };
      }, pinchCenter);
      expect(afterPinch.zoom / pageAnchorBefore.zoom).toBeCloseTo(2, 1);
      expect(afterPinch.page.x).toBeCloseTo(pageAnchorBefore.page.x, 0);
      expect(afterPinch.page.y).toBeCloseTo(pageAnchorBefore.page.y, 0);
      const snapAfterPinch = await readSnapshot(page, rectAId);
      expect(snapAfterPinch.node).toEqual(beforeTap.node);
      expect(snapAfterPinch.undoDepth).toBe(beforeTap.undoDepth);
      await maybeShot(page, "phone-after-pinch.png");

      // 5. Touchcancel mid-gesture recovers cleanly without leaving stuck pointers.
      await Promise.all([
        touchStart(cdp, [{ id: 1, x: 150, y: 400 }]),
        touchMove(cdp, [{ id: 1, x: 190, y: 400 }]),
        touchCancel(cdp),
      ]);
      const afterCancel = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: 150, y: 400 }, { x: 190, y: 400 }, 6);
      const afterRecoveryPan = await readSnapshot(page, rectAId);
      expect(afterRecoveryPan.camera.x - afterCancel.camera.x).toBeCloseTo(40, 0);

      // 6. Stationary long-press on phone starts a comment draft at that point (no browser menu).
      const beforeHold = await readSnapshot(page, rectAId);
      await touchStart(cdp, [{ id: 1, x: 196, y: 380 }]);
      await page.waitForTimeout(600);
      await touchEnd(cdp, []);
      const commentBox = page.locator(".mobile-sheet textarea");
      await expect(commentBox).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole("menu")).toHaveCount(0);
      const afterHold = await readSnapshot(page, rectAId);
      expect(afterHold.node).toEqual(beforeHold.node);
      expect(afterHold.camera).toEqual(beforeHold.camera);
      await maybeShot(page, "phone-longpress-comment.png");
      await page.getByRole("button", { name: "Close comment" }).tap();
      await expect(commentBox).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("tablet: 1-finger move, marquee, hand, read-only pan, and 50% zoom tiny-layer tap", async ({
    browser,
  }) => {
    const { context, page, cdp } = await openTouchPage(
      browser,
      instance.url,
      storageState,
      TABLET_1024,
      fileUrl,
    );
    try {
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([]);
      });
      await page.waitForTimeout(80);

      // 1. Tap selects rectA; one-finger drag on rectA moves it.
      const a0 = await rectScreenBox(page, rectAId);
      await cdpTap(cdp, a0.cx, a0.cy);
      expect((await readSnapshot(page, rectAId)).selection).toEqual([rectAId]);

      const beforeMove = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: a0.cx, y: a0.cy }, { x: a0.cx + 50, y: a0.cy + 30 }, 8);
      const afterMove = await readSnapshot(page, rectAId);
      expect(afterMove.node?.x).toBeCloseTo((beforeMove.node?.x ?? 0) + 50, 0);
      expect(afterMove.node?.y).toBeCloseTo((beforeMove.node?.y ?? 0) + 30, 0);
      expect(afterMove.undoDepth).toBe(beforeMove.undoDepth + 1);

      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.undo());
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 });
      await page.waitForTimeout(100);

      // 2. One-finger drag on empty canvas marquee-selects in Select tool.
      const a1 = await rectScreenBox(page, rectAId);
      const b1 = await rectScreenBox(page, rectBId);
      await cdpDrag(
        cdp,
        { x: a1.left - 30, y: a1.top - 30 },
        { x: b1.right + 30, y: b1.bottom + 30 },
        8,
      );
      const afterMarquee = await readSnapshot(page, rectAId);
      expect(afterMarquee.selection.sort()).toEqual([rectAId, rectBId].sort());

      // 3. In Hand tool and in read-only mode, one-finger drag pans camera without editing or marqueeing.
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("hand"));
      const beforeHand = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: a1.cx, y: a1.cy }, { x: a1.cx + 40, y: a1.cy - 20 }, 6);
      const afterHand = await readSnapshot(page, rectAId);
      expect(afterHand.camera.x - beforeHand.camera.x).toBeCloseTo(40, 0);
      expect(afterHand.camera.y - beforeHand.camera.y).toBeCloseTo(-20, 0);
      expect(afterHand.node).toEqual(beforeHand.node);

      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setTool("select");
        ed.select([id]);
        ed.setReadOnly(true);
      }, rectAId);
      const beforeReadOnlyPan = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: 400, y: 400 }, { x: 460, y: 430 }, 6);
      const afterReadOnlyPan = await readSnapshot(page, rectAId);
      expect(afterReadOnlyPan.camera.x - beforeReadOnlyPan.camera.x).toBeCloseTo(60, 0);
      expect(afterReadOnlyPan.camera.y - beforeReadOnlyPan.camera.y).toBeCloseTo(30, 0);
      expect(afterReadOnlyPan.selection).toEqual([rectAId]);

      // 4. At 50% zoom, tapping a 5 px layer 4 px right of selection selects it (F4).
      const tinyId = await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setReadOnly(false);
        ed.setTool("select");
        const b = ed.scene.bounds(id);
        if (!b) throw new Error("missing bounds");
        const tiny = ed.createLayer(
          "rect",
          { x: b.x + b.width + 4, y: b.y + 45, width: 5, height: 10 },
          ed.s.pageId,
          { name: "Tiny Neighbour", fills: [{ type: "solid", color: "#f59e0b" }] },
        ) as string;
        ed.zoomTo(0.5);
        ed.centerOn({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        ed.select([id]);
        return tiny;
      }, rectAId);
      const tinyPt = await rectScreenBox(page, tinyId);
      await cdpTap(cdp, tinyPt.cx, tinyPt.cy);
      expect((await readSnapshot(page, rectAId)).selection).toEqual([tinyId]);
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.undo());
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  test("tablet: 2-finger pinch over handles (0 React commits), floating Lens, text edit, and side panel", async ({
    browser,
  }) => {
    const { context, page, cdp } = await openTouchPage(
      browser,
      instance.url,
      storageState,
      TABLET_1024,
      fileUrl,
    );
    try {
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setTool("select");
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      const lensEl = page.locator(".lens-anchor");
      await expect(lensEl).toBeVisible({ timeout: 2_000 });
      // Wait past the Lens's 350 ms settle timer before measuring per-move React commits (N4).
      await page.waitForTimeout(450);

      // 1. Two-finger pinch over the selected layer's SE resize handle: 0 React commits per move.
      const handleBox = await rectScreenBox(page, rectAId);
      const se = { x: handleBox.right, y: handleBox.bottom };
      const other = { x: handleBox.left, y: handleBox.top };
      const beforeHandlePinch = await readSnapshot(page, rectAId);
      await Promise.all([
        touchStart(cdp, [{ id: 1, x: se.x, y: se.y }]),
        touchStart(cdp, [
          { id: 1, x: se.x, y: se.y },
          { id: 2, x: other.x, y: other.y },
        ]),
        // Move 1 flushes the one-time Lens hide commit on cameraGesture start.
        touchMove(cdp, [
          { id: 1, x: se.x - 5, y: se.y - 3 },
          { id: 2, x: other.x + 2, y: other.y + 2 },
        ]),
      ]);
      await waitFrames(page, 2);
      const tabletCommitsBefore = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      const tabletMoves: Promise<unknown>[] = [];
      for (let i = 2; i <= 10; i++) {
        const t = i / 10;
        tabletMoves.push(
          touchMove(cdp, [
            { id: 1, x: se.x - 45 * t, y: se.y - 25 * t },
            { id: 2, x: other.x + 20 * t, y: other.y + 15 * t },
          ]),
        );
      }
      await Promise.all(tabletMoves);
      const tabletCommitsAfter = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      expect(tabletCommitsAfter - tabletCommitsBefore).toBe(0);
      await Promise.all([
        touchEnd(cdp, [{ id: 1, x: se.x - 45, y: se.y - 25 }]),
        touchEnd(cdp, [{ id: 2, x: other.x + 20, y: other.y + 15 }]),
      ]);
      await page.waitForTimeout(120);
      const afterHandlePinch = await readSnapshot(page, rectAId);
      expect(afterHandlePinch.camera.zoom).toBeLessThan(beforeHandlePinch.camera.zoom * 0.8);
      expect(afterHandlePinch.node).toEqual(beforeHandlePinch.node);
      expect(afterHandlePinch.selection).toEqual(beforeHandlePinch.selection);
      expect(afterHandlePinch.undoDepth).toBe(beforeHandlePinch.undoDepth);
      expect(afterHandlePinch.redoDepth).toBe(beforeHandlePinch.redoDepth);
      expect(afterHandlePinch.revn).toBe(beforeHandlePinch.revn);
      expect(afterHandlePinch.pendingCount).toBe(0);

      // 2. Pinch with Finger 1 on SE handle + Finger 2 on floating Selection Lens (F1): zooms without resizing.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await expect(lensEl).toBeVisible({ timeout: 2_000 });
      const lensBox1 = await lensEl.boundingBox();
      if (!lensBox1) throw new Error("missing lens bounding box");
      const boxF1a = await rectScreenBox(page, rectAId);
      const beforeLensPinchA = await readSnapshot(page, rectAId);
      const f2Lens = { x: lensBox1.x + lensBox1.width / 2, y: lensBox1.y + lensBox1.height / 2 };
      const f1aOps: Promise<unknown>[] = [
        touchStart(cdp, [{ id: 1, x: boxF1a.right, y: boxF1a.bottom }]),
        touchStart(cdp, [
          { id: 1, x: boxF1a.right, y: boxF1a.bottom },
          { id: 2, x: f2Lens.x, y: f2Lens.y },
        ]),
      ];
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        f1aOps.push(
          touchMove(cdp, [
            { id: 1, x: boxF1a.right + 25 * t, y: boxF1a.bottom - 20 * t },
            { id: 2, x: f2Lens.x - 25 * t, y: f2Lens.y + 20 * t },
          ]),
        );
      }
      f1aOps.push(touchEnd(cdp, []));
      await Promise.all(f1aOps);
      await page.waitForTimeout(100);
      const afterLensPinchA = await readSnapshot(page, rectAId);
      expect(afterLensPinchA.camera.zoom).toBeGreaterThan(beforeLensPinchA.camera.zoom * 1.15);
      expect(afterLensPinchA.node).toEqual(beforeLensPinchA.node);
      expect(afterLensPinchA.undoDepth).toBe(beforeLensPinchA.undoDepth);

      // 3. Pinch with Finger 1 on floating Lens + Finger 2 on rectA center (F1): zooms without moving.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await expect(lensEl).toBeVisible({ timeout: 2_000 });
      const lensBox2 = await lensEl.boundingBox();
      if (!lensBox2) throw new Error("missing lens bounding box");
      const boxF1b = await rectScreenBox(page, rectAId);
      const beforeLensPinchB = await readSnapshot(page, rectAId);
      const f1Lens = { x: lensBox2.x + lensBox2.width / 2, y: lensBox2.y + lensBox2.height / 2 };
      const f1bOps: Promise<unknown>[] = [
        touchStart(cdp, [{ id: 1, x: f1Lens.x, y: f1Lens.y }]),
        touchStart(cdp, [
          { id: 1, x: f1Lens.x, y: f1Lens.y },
          { id: 2, x: boxF1b.cx, y: boxF1b.cy },
        ]),
      ];
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        f1bOps.push(
          touchMove(cdp, [
            { id: 1, x: f1Lens.x - 25 * t, y: f1Lens.y + 20 * t },
            { id: 2, x: boxF1b.cx + 25 * t, y: boxF1b.cy - 20 * t },
          ]),
        );
      }
      f1bOps.push(touchEnd(cdp, []));
      await Promise.all(f1bOps);
      await page.waitForTimeout(100);
      const afterLensPinchB = await readSnapshot(page, rectAId);
      expect(afterLensPinchB.camera.zoom).toBeGreaterThan(beforeLensPinchB.camera.zoom * 1.15);
      expect(afterLensPinchB.node).toEqual(beforeLensPinchB.node);
      expect(afterLensPinchB.undoDepth).toBe(beforeLensPinchB.undoDepth);

      // 3b. Lens W-label touch scrub taken over by a second finger (N1):
      // drifts under 8 px touch slop (3 px, 6 px) write nothing, and a drift past slop (15 px)
      // starts scrubbing and cancels cleanly on pinch takeover with zero undo entry.
      for (const drift of [3, 6, 15]) {
        await page.evaluate((id) => {
          const ed = (window as unknown as DebugWindow).drawpane;
          ed.zoomTo(1);
          ed.centerOn({ x: 380, y: 250 });
          ed.select([id]);
        }, rectAId);
        await expect(lensEl).toBeVisible({ timeout: 2_000 });
        await page.waitForTimeout(450);
        const wLabel = lensEl
          .locator(".dp-field")
          .filter({ has: page.getByRole("spinbutton", { name: "Width" }) })
          .locator(".dp-field__label")
          .first();
        const wBox = await wLabel.boundingBox();
        if (!wBox) throw new Error("missing Lens W label bounding box");
        const targetBox = await rectScreenBox(page, rectAId);
        const beforeScrubPinch = await readSnapshot(page, rectAId);
        const f1 = { x: wBox.x + wBox.width / 2, y: wBox.y + wBox.height / 2 };
        const f2 = { x: targetBox.cx, y: targetBox.cy };
        await touchStart(cdp, [{ id: 1, x: f1.x, y: f1.y }]);
        await touchMove(cdp, [{ id: 1, x: f1.x + drift, y: f1.y }]);
        const midWidth = (await readSnapshot(page, rectAId)).node?.width;
        if (drift >= 8) {
          expect(midWidth).toBeGreaterThan(beforeScrubPinch.node?.width ?? 0);
        } else {
          expect(midWidth).toBe(beforeScrubPinch.node?.width);
        }
        const midX = (f1.x + drift + f2.x) / 2;
        const midY = (f1.y + f2.y) / 2;
        const dx = f1.x + drift - midX;
        const dy = f1.y - midY;
        const len = Math.hypot(dx, dy) || 1;
        const ux = (dx / len) * 35;
        const uy = (dy / len) * 35;
        const scrubPinchOps: Promise<unknown>[] = [
          touchStart(cdp, [
            { id: 1, x: f1.x + drift, y: f1.y },
            { id: 2, x: f2.x, y: f2.y },
          ]),
        ];
        for (let i = 1; i <= 6; i++) {
          const t = i / 6;
          scrubPinchOps.push(
            touchMove(cdp, [
              { id: 1, x: f1.x + drift + ux * t, y: f1.y + uy * t },
              { id: 2, x: f2.x - ux * t, y: f2.y - uy * t },
            ]),
          );
        }
        scrubPinchOps.push(touchEnd(cdp, []));
        await Promise.all(scrubPinchOps);
        await page.waitForTimeout(150);
        const afterScrubPinch = await readSnapshot(page, rectAId);
        expect(afterScrubPinch.node).toEqual(beforeScrubPinch.node);
        expect(afterScrubPinch.undoDepth).toBe(beforeScrubPinch.undoDepth);
        expect(afterScrubPinch.redoDepth).toBe(beforeScrubPinch.redoDepth);
        expect(afterScrubPinch.camera.zoom).toBeGreaterThan(beforeScrubPinch.camera.zoom * 1.15);
      }

      // 4. Pinch while drag-selecting inside a text edit box keeps text editing open and zooms (F1).
      const textId = await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        const id = ed.createLayer("text", { x: 260, y: 360, width: 180, height: 40 }, ed.s.pageId, {
          characters: "Pinch while editing",
        }) as string;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 320 });
        ed.select([id]);
        ed.startTextEdit(id);
        return id;
      });
      const textBoxEl = page.locator(".canvas__text-editing");
      await expect(textBoxEl).toBeVisible({ timeout: 2_000 });
      const tb = await textBoxEl.boundingBox();
      if (!tb) throw new Error("missing text edit box");
      const beforeTextPinch = await readSnapshot(page, rectAId);
      const f1cOps: Promise<unknown>[] = [
        touchStart(cdp, [{ id: 1, x: tb.x + 20, y: tb.y + tb.height / 2 }]),
        touchMove(cdp, [{ id: 1, x: tb.x + 50, y: tb.y + tb.height / 2 }]),
        touchStart(cdp, [
          { id: 1, x: tb.x + 50, y: tb.y + tb.height / 2 },
          { id: 2, x: tb.x + 150, y: tb.y - 60 },
        ]),
      ];
      for (let i = 1; i <= 5; i++) {
        const t = i / 5;
        f1cOps.push(
          touchMove(cdp, [
            { id: 1, x: tb.x + 50 - 25 * t, y: tb.y + tb.height / 2 + 15 * t },
            { id: 2, x: tb.x + 150 + 25 * t, y: tb.y - 60 - 15 * t },
          ]),
        );
      }
      f1cOps.push(touchEnd(cdp, []));
      await Promise.all(f1cOps);
      const afterTextPinch = await readSnapshot(page, rectAId);
      expect(afterTextPinch.editingText).toBe(textId);
      expect(afterTextPinch.camera.zoom).toBeGreaterThan(beforeTextPinch.camera.zoom * 1.15);
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.endTextEdit();
        ed.undo();
      });
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 });

      // 5. Finger 1 drags a layer on canvas while Finger 2 lands on a non-canvas side panel:
      // rolls back the uncommitted drag and blocks without pinching or committing (F1).
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      const sidePane = page.locator(".pane--left, .pane--right").first();
      const paneBox = await sidePane.boundingBox();
      if (paneBox) {
        const boxF1d = await rectScreenBox(page, rectAId);
        const beforeSideCancel = await readSnapshot(page, rectAId);
        await page.evaluate((id) => {
          const ed = (window as unknown as DebugWindow).drawpane as DebugEditor & {
            doc: { subscribe(fn: () => void): () => void };
          };
          const w = window as unknown as {
            __sideMoved?: boolean;
            __sideOff?: () => void;
          };
          w.__sideMoved = false;
          const startX = Number(ed.doc.get(id)?.props.x);
          w.__sideOff = ed.doc.subscribe(() => {
            if (Number(ed.doc.get(id)?.props.x) !== startX) w.__sideMoved = true;
          });
        }, rectAId);
        await Promise.all([
          touchStart(cdp, [{ id: 1, x: boxF1d.cx, y: boxF1d.cy }]),
          touchMove(cdp, [{ id: 1, x: boxF1d.cx + 30, y: boxF1d.cy }]),
          touchStart(cdp, [
            { id: 1, x: boxF1d.cx + 30, y: boxF1d.cy },
            { id: 2, x: paneBox.x + paneBox.width / 2, y: paneBox.y + paneBox.height / 2 },
          ]),
          touchMove(cdp, [
            { id: 1, x: boxF1d.cx + 60, y: boxF1d.cy + 20 },
            { id: 2, x: paneBox.x + paneBox.width / 2, y: paneBox.y + paneBox.height / 2 },
          ]),
          touchEnd(cdp, []),
        ]);
        const sideMoved = await page.evaluate(() => {
          const w = window as unknown as { __sideMoved?: boolean; __sideOff?: () => void };
          w.__sideOff?.();
          return Boolean(w.__sideMoved);
        });
        expect(sideMoved).toBe(true);
        await page.waitForTimeout(80);
        const afterSideCancel = await readSnapshot(page, rectAId);
        expect(afterSideCancel.node).toEqual(beforeSideCancel.node);
        expect(afterSideCancel.undoDepth).toBe(beforeSideCancel.undoDepth);
        expect(afterSideCancel.camera).toEqual(beforeSideCancel.camera);
      }
    } finally {
      await context.close();
    }
  });

  test("tablet: mid-drag rollback, true tail pan, touchcancel, comment draft, long-press menu, and time-boxed pen + palm", async ({
    browser,
  }) => {
    const { context, page, cdp } = await openTouchPage(
      browser,
      instance.url,
      storageState,
      TABLET_1024,
      fileUrl,
    );
    try {
      // 1. Mid-drag second-finger rollback + TRUE lift-finger-2 tail pan + re-add finger 3:
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setTool("select");
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await page.waitForTimeout(100);
      const midBox = await rectScreenBox(page, rectAId);
      const beforeMidRollback = await readSnapshot(page, rectAId);
      // Observe local preview resize + sync hold synchronously inside the page so IPC latency
      // can never let the 200 ms hold window elapse before finger 2 arrives.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane as DebugEditor & {
          doc: { subscribe(fn: () => void): () => void };
        };
        const w = window as unknown as {
          __midProbe?: { resized: boolean; held: boolean };
          __midOff?: () => void;
        };
        w.__midProbe = { resized: false, held: false };
        w.__midOff = ed.doc.subscribe(() => {
          const width = Number(ed.doc.get(id)?.props.width);
          if (width < 160 && w.__midProbe) {
            w.__midProbe.resized = true;
            if (ed.sync.holding) w.__midProbe.held = true;
          }
        });
      }, rectAId);
      const midPinchOps: Promise<unknown>[] = [
        touchStart(cdp, [{ id: 1, x: midBox.right, y: midBox.bottom }]),
        touchMove(cdp, [{ id: 1, x: midBox.right - 20, y: midBox.bottom }]),
        touchMove(cdp, [{ id: 1, x: midBox.right - 40, y: midBox.bottom }]),
        touchStart(cdp, [
          { id: 1, x: midBox.right - 40, y: midBox.bottom },
          { id: 2, x: midBox.left, y: midBox.top },
        ]),
      ];
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        midPinchOps.push(
          touchMove(cdp, [
            { id: 1, x: midBox.right - 40 + 40 * t, y: midBox.bottom + 20 * t },
            { id: 2, x: midBox.left - 30 * t, y: midBox.top - 20 * t },
          ]),
        );
      }
      await Promise.all(midPinchOps);
      const midProbe = await page.evaluate(() => {
        const w = window as unknown as {
          __midProbe?: { resized: boolean; held: boolean };
          __midOff?: () => void;
        };
        w.__midOff?.();
        return w.__midProbe ?? { resized: false, held: false };
      });
      expect(midProbe.resized).toBe(true);
      expect(midProbe.held).toBe(true);

      // Lift ONLY finger 2 (CDP touchEnd releases the points it lists!) and pan with finger 1 in tail.
      await touchEnd(cdp, [{ id: 2, x: midBox.left - 30, y: midBox.top - 20 }]);
      const camBeforeTail = (await readSnapshot(page, rectAId)).camera;
      await touchMove(cdp, [{ id: 1, x: midBox.right + 45, y: midBox.bottom + 35 }]);
      const camAfterTail = (await readSnapshot(page, rectAId)).camera;
      expect(camAfterTail.zoom).toBeCloseTo(camBeforeTail.zoom, 4);
      expect(camAfterTail.x - camBeforeTail.x).toBeCloseTo(45, 0);
      expect(camAfterTail.y - camBeforeTail.y).toBeCloseTo(15, 0);
      // Re-add finger 3 and keep pinching with zero jump.
      await touchStart(cdp, [
        { id: 1, x: midBox.right + 45, y: midBox.bottom + 35 },
        { id: 3, x: midBox.left, y: midBox.top },
      ]);
      const camAtReadd = (await readSnapshot(page, rectAId)).camera;
      expect(camAtReadd.zoom).toBeCloseTo(camAfterTail.zoom, 4);
      await Promise.all([
        touchMove(cdp, [
          { id: 1, x: midBox.right + 65, y: midBox.bottom + 45 },
          { id: 3, x: midBox.left - 20, y: midBox.top - 10 },
        ]),
        touchEnd(cdp, [{ id: 3, x: midBox.left - 20, y: midBox.top - 10 }]),
        touchEnd(cdp, [{ id: 1, x: midBox.right + 65, y: midBox.bottom + 45 }]),
      ]);
      await page.waitForTimeout(150);

      const afterMidRollback = await readSnapshot(page, rectAId);
      expect(afterMidRollback.node).toEqual(beforeMidRollback.node);
      expect(afterMidRollback.selection).toEqual(beforeMidRollback.selection);
      expect(afterMidRollback.undoDepth).toBe(beforeMidRollback.undoDepth);
      expect(afterMidRollback.redoDepth).toBe(beforeMidRollback.redoDepth);
      expect(afterMidRollback.revn).toBe(beforeMidRollback.revn);
      expect(afterMidRollback.pendingCount).toBe(0);
      expect(afterMidRollback.holding).toBe(false);
      expect(afterMidRollback.camera.zoom).toBeGreaterThan(beforeMidRollback.camera.zoom * 1.2);
      const zoomText = await page.locator(".zoom__value").textContent();
      expect(zoomText).toBe(`${Math.round(afterMidRollback.camera.zoom * 100)}%`);
      await maybeShot(page, "tablet-after-pinch-rollback.png");

      // 2. Touchcancel mid-drag rolls back uncommitted move cleanly.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await page.waitForTimeout(80);
      const cancelBox = await rectScreenBox(page, rectAId);
      const beforeCancelDrag = await readSnapshot(page, rectAId);
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane as DebugEditor & {
          doc: { subscribe(fn: () => void): () => void };
        };
        const w = window as unknown as { __cancelMoved?: boolean; __cancelOff?: () => void };
        w.__cancelMoved = false;
        const x0 = Number(ed.doc.get(id)?.props.x);
        w.__cancelOff = ed.doc.subscribe(() => {
          if (Number(ed.doc.get(id)?.props.x) !== x0) w.__cancelMoved = true;
        });
      }, rectAId);
      await Promise.all([
        touchStart(cdp, [{ id: 1, x: cancelBox.cx, y: cancelBox.cy }]),
        touchMove(cdp, [{ id: 1, x: cancelBox.cx + 45, y: cancelBox.cy + 25 }]),
        touchCancel(cdp),
      ]);
      const cancelMoved = await page.evaluate(() => {
        const w = window as unknown as { __cancelMoved?: boolean; __cancelOff?: () => void };
        w.__cancelOff?.();
        return Boolean(w.__cancelMoved);
      });
      expect(cancelMoved).toBe(true);
      await page.waitForTimeout(100);
      const afterCancelDrag = await readSnapshot(page, rectAId);
      expect(afterCancelDrag.node).toEqual(beforeCancelDrag.node);
      expect(afterCancelDrag.undoDepth).toBe(beforeCancelDrag.undoDepth);
      expect(afterCancelDrag.revn).toBe(beforeCancelDrag.revn);

      // 3. Two-finger pan/pinch leaves an open comment draft popover unchanged.
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("comment"));
      await cdpTap(cdp, 520, 420);
      const draftTextarea = page.locator(".comment-popover textarea, .comment-draft textarea");
      await expect(draftTextarea).toBeVisible({ timeout: 5_000 });
      await draftTextarea.fill("Keep this draft intact");
      const beforeDraftPinch = await readSnapshot(page, rectAId);
      await cdpTwoFingerPan(cdp, { x: 360, y: 260 }, { x: 460, y: 260 }, -40, 30);
      const afterDraftPinch = await readSnapshot(page, rectAId);
      expect(afterDraftPinch.camera.x - beforeDraftPinch.camera.x).toBeCloseTo(-40, 0);
      await expect(draftTextarea).toBeVisible();
      await expect(draftTextarea).toHaveValue("Keep this draft intact");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("select"));

      // 4. Stationary long-press on tablet opens context menu at the finger; lifting does not close or click it.
      const menuBox = await rectScreenBox(page, rectAId);
      await touchStart(cdp, [{ id: 1, x: menuBox.cx, y: menuBox.cy }]);
      await page.waitForTimeout(600);
      await touchEnd(cdp, []);
      const menu = page.getByRole("menu", { name: /actions/i });
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await maybeShot(page, "tablet-longpress-contextmenu.png");
      await cdpTap(cdp, 280, 140);
      await expect(menu).toBeHidden();

      // 5. Apple Pencil draws with concurrent palm rejection, then fingers select again after ~1 s (F3).
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.setTool("rect");
      });
      await page.waitForTimeout(80);
      const beforePen = await readSnapshot(page, rectAId);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 360,
        y: 440,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "pen",
      });
      await touchStart(cdp, [{ id: 9, x: 640, y: 520 }]);
      await touchMove(cdp, [{ id: 9, x: 700, y: 560 }]);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 480,
        y: 520,
        button: "left",
        buttons: 1,
        pointerType: "pen",
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 480,
        y: 520,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "pen",
      });
      await touchEnd(cdp, []);

      const afterPen = await readSnapshot(page, rectAId);
      expect(afterPen.childCount).toBe(beforePen.childCount + 1);
      expect(afterPen.camera).toEqual(beforePen.camera);

      // Immediately after pen lift (< 1 s): finger drag pans instead of drawing another rect.
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("rect"));
      const beforePalmNav = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: 400, y: 300 }, { x: 480, y: 350 }, 6);
      const afterPalmNav = await readSnapshot(page, rectAId);
      expect(afterPalmNav.childCount).toBe(beforePalmNav.childCount);
      expect(afterPalmNav.camera.x - beforePalmNav.camera.x).toBeCloseTo(80, 0);
      expect(afterPalmNav.camera.y - beforePalmNav.camera.y).toBeCloseTo(50, 0);
      expect(afterPalmNav.camera.zoom).toBeCloseTo(beforePalmNav.camera.zoom, 4);

      // After the ~1 s palm-rejection window expires, fingers select layers again!
      await page.waitForTimeout(1100);
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.undo(); // remove temporary pen-drawn rect
        ed.setTool("select");
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([]);
      });
      const bAfterPen = await rectScreenBox(page, rectBId);
      await cdpTap(cdp, bAfterPen.cx, bAfterPen.cy);
      expect((await readSnapshot(page, rectAId)).selection).toEqual([rectBId]);
    } finally {
      await context.close();
    }
  });

  test("tablet two-client collaboration: holds 200 ms then streams live, and second finger after 200 ms reverts for both", async ({
    browser,
  }) => {
    const tablet = await openTouchPage(browser, instance.url, storageState, TABLET_1024, fileUrl);
    const observer = await openTouchPage(browser, instance.url, storageState, TABLET_1024, fileUrl);
    try {
      await tablet.page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setTool("select");
        ed.zoomTo(1);
        ed.centerOn({ x: 440, y: 250 });
        ed.select([id]);
      }, rectBId);
      await tablet.page.waitForTimeout(100);

      const startBox = await tablet.page.evaluate((nid) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        const b = ed.scene.bounds(nid);
        if (!b) throw new Error("missing bounds");
        return ed.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      }, rectBId);
      const startX = (await readSnapshot(tablet.page, rectBId)).node?.x ?? 0;

      // 1. Drag smoothly across > 500 ms: held initially, then streams live BEFORE lift.
      await tablet.page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane as DebugEditor & {
          doc: { subscribe(fn: () => void): () => void };
        };
        const w = window as unknown as { __sawHoldOnMove?: boolean; __holdOff?: () => void };
        w.__sawHoldOnMove = false;
        const x0 = Number(ed.doc.get(id)?.props.x);
        w.__holdOff = ed.doc.subscribe(() => {
          if (Number(ed.doc.get(id)?.props.x) !== x0 && ed.sync.holding) {
            w.__sawHoldOnMove = true;
          }
        });
      }, rectBId);
      await Promise.all([
        touchStart(tablet.cdp, [{ id: 1, x: startBox.x, y: startBox.y }]),
        touchMove(tablet.cdp, [{ id: 1, x: startBox.x + 25, y: startBox.y }]),
      ]);
      const sawHoldOnMove = await tablet.page.evaluate(() => {
        const w = window as unknown as { __sawHoldOnMove?: boolean; __holdOff?: () => void };
        w.__holdOff?.();
        return Boolean(w.__sawHoldOnMove);
      });
      expect(sawHoldOnMove).toBe(true);

      // Keep dragging past 200 ms without lifting finger 1.
      for (let i = 2; i <= 8; i++) {
        await tablet.page.waitForTimeout(65);
        await touchMove(tablet.cdp, [{ id: 1, x: startBox.x + 15 * i, y: startBox.y }]);
      }
      // Observer sees live movement while finger 1 is STILL down!
      await expect
        .poll(async () => (await readSnapshot(observer.page, rectBId)).node?.x ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThan(startX + 40);

      // Lift finger 1 -> both clients agree on final position.
      await touchEnd(tablet.cdp, []);
      await expect
        .poll(async () => (await readSnapshot(observer.page, rectBId)).node?.x ?? 0, {
          timeout: 5_000,
        })
        .toBeCloseTo(startX + 120, 0);

      // Undo back to original position before testing post-200ms cancel.
      await tablet.page.evaluate(() => (window as unknown as DebugWindow).drawpane.undo());
      await expect
        .poll(async () => (await readSnapshot(observer.page, rectBId)).node?.x ?? 0, {
          timeout: 5_000,
        })
        .toBeCloseTo(startX, 0);

      // 2. Drag past 200 ms so collaborator sees it live, THEN land a second finger:
      // must revert like desktop Escape on BOTH clients with 0 undo/redo added.
      const beforeCancel = await readSnapshot(tablet.page, rectBId);
      await Promise.all([
        touchStart(tablet.cdp, [{ id: 1, x: startBox.x, y: startBox.y }]),
        touchMove(tablet.cdp, [{ id: 1, x: startBox.x + 18, y: startBox.y }]),
      ]);
      for (let i = 2; i <= 6; i++) {
        await tablet.page.waitForTimeout(55);
        await touchMove(tablet.cdp, [{ id: 1, x: startBox.x + 18 * i, y: startBox.y }]);
      }
      await expect
        .poll(async () => (await readSnapshot(observer.page, rectBId)).node?.x ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThan(startX + 30);

      // Second finger lands after 200 ms -> reverts locally AND syncs revert to observer.
      await Promise.all([
        touchStart(tablet.cdp, [
          { id: 1, x: startBox.x + 108, y: startBox.y },
          { id: 2, x: startBox.x - 80, y: startBox.y },
        ]),
        touchEnd(tablet.cdp, []),
      ]);

      const afterTablet = await readSnapshot(tablet.page, rectBId);
      expect(afterTablet.node?.x).toBeCloseTo(startX, 0);
      expect(afterTablet.undoDepth).toBe(beforeCancel.undoDepth);
      expect(afterTablet.redoDepth).toBe(beforeCancel.redoDepth);
      await expect
        .poll(async () => (await readSnapshot(observer.page, rectBId)).node?.x ?? 0, {
          timeout: 5_000,
        })
        .toBeCloseTo(startX, 0);
    } finally {
      await tablet.context.close();
      await observer.context.close();
    }
  });

  test("portrait tablet (768 x 1024): two-finger pinch and pan work over exposed canvas", async ({
    browser,
  }) => {
    const { context, page, cdp } = await openTouchPage(
      browser,
      instance.url,
      storageState,
      TABLET_768,
      fileUrl,
    );
    try {
      const before = await readSnapshot(page, rectAId);
      const center = { x: 520, y: 500 };
      await cdpPinch(cdp, center, 45, 90, 8);
      const after = await readSnapshot(page, rectAId);
      expect(after.camera.zoom).toBeGreaterThan(before.camera.zoom * 1.5);
      expect(after.node).toEqual(before.node);
      expect(after.undoDepth).toBe(before.undoDepth);
    } finally {
      await context.close();
    }
  });
});
