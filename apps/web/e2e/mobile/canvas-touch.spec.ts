/**
 * Touch gesture arbitration on phones and tablets using real Chromium CDP touch
 * (`Input.dispatchTouchEvent`) and stylus (`Input.dispatchMouseEvent` with
 * `pointerType: "pen"`) injection.
 *
 * Verifies:
 * - Phone (393 x 852): tap selects for Inspect, one-finger drag pans camera
 *   at constant zoom even over selected layers, two-finger translation moves
 *   camera at constant zoom, two-finger pinch zooms around its centroid,
 *   stationary hold starts a comment draft, two-finger gesture preserves
 *   selection/geometry/undo/comments, and touchcancel cleans up cleanly.
 * - Tablet (1024 x 768 & 768 x 1024): tap selects, one-finger drag on a layer
 *   moves it, one-finger drag on empty canvas marquees in Move tool and pans
 *   in Hand tool, two-finger gestures over a selected layer or its resize
 *   handles (both within slop and mid-drag rollback) leave node geometry,
 *   selection, undo/redo depth, server revision, and comment drafts unchanged,
 *   lifting and re-adding a second finger mid-pinch never starts a tool
 *   action, stationary long-press opens the context menu at the finger,
 *   touchcancel rolls back uncommitted drags, and Apple Pencil (`pointerType:
 *   "pen"`) draws precisely while fingers switch to navigation-only palm
 *   rejection.
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

async function touchEnd(cdp: CDPSession, remaining: readonly Pt[] = []) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: remaining.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
  });
}

async function touchCancel(cdp: CDPSession) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
}

async function cdpTap(cdp: CDPSession, x: number, y: number, id = 1) {
  await touchStart(cdp, [{ id, x, y }]);
  await touchEnd(cdp, []);
}

async function cdpDrag(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
  id = 1,
) {
  await touchStart(cdp, [{ id, x: from.x, y: from.y }]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touchMove(cdp, [
      { id, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
    ]);
  }
  await touchEnd(cdp, []);
}

async function cdpTwoFingerPan(
  cdp: CDPSession,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  dx: number,
  dy: number,
  steps = 8,
) {
  await touchStart(cdp, [{ id: 1, x: p1.x, y: p1.y }]);
  await touchStart(cdp, [
    { id: 1, x: p1.x, y: p1.y },
    { id: 2, x: p2.x, y: p2.y },
  ]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touchMove(cdp, [
      { id: 1, x: p1.x + dx * t, y: p1.y + dy * t },
      { id: 2, x: p2.x + dx * t, y: p2.y + dy * t },
    ]);
  }
  await touchEnd(cdp, [{ id: 1, x: p1.x + dx, y: p1.y + dy }]);
  await touchEnd(cdp, []);
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
  await touchStart(cdp, [f1(startHalfSpan)]);
  await touchStart(cdp, [f1(startHalfSpan), f2(startHalfSpan)]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const half = startHalfSpan + (endHalfSpan - startHalfSpan) * t;
    await touchMove(cdp, [f1(half), f2(half)]);
  }
  await touchEnd(cdp, [f1(endHalfSpan)]);
  await touchEnd(cdp, []);
}

async function readSnapshot(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const ed = (window as unknown as DebugWindow).drawpane;
    const node = ed.doc.get(id);
    const props = node?.props ?? {};
    return {
      camera: { x: ed.s.camera.x, y: ed.s.camera.y, zoom: ed.s.camera.zoom },
      selection: [...ed.s.selection],
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

  test("phone: tap selects, 1-finger drag pans, 2-finger pan/pinch anchors cleanly, long-press starts comment, touchcancel recovers", async ({
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
      // Position camera at 100% centered on rectA so coordinates are deterministic.
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
      await touchStart(cdp, [{ id: 1, x: pinchCenter.x - 50, y: pinchCenter.y }]);
      await touchStart(cdp, [
        { id: 1, x: pinchCenter.x - 50, y: pinchCenter.y },
        { id: 2, x: pinchCenter.x + 50, y: pinchCenter.y },
      ]);
      const commitsBeforePinchMoves = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      for (let i = 1; i <= 10; i++) {
        const half = 50 + 50 * (i / 10);
        await touchMove(cdp, [
          { id: 1, x: pinchCenter.x - half, y: pinchCenter.y },
          { id: 2, x: pinchCenter.x + half, y: pinchCenter.y },
        ]);
      }
      const commitsAfterPinchMoves = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      expect(commitsAfterPinchMoves - commitsBeforePinchMoves).toBe(0);
      await touchEnd(cdp, [{ id: 1, x: pinchCenter.x - 100, y: pinchCenter.y }]);
      await touchEnd(cdp, []);
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
      await touchStart(cdp, [{ id: 1, x: 150, y: 400 }]);
      await touchMove(cdp, [{ id: 1, x: 190, y: 400 }]);
      await touchCancel(cdp);
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
      // Dismiss the draft sheet cleanly.
      await page.getByRole("button", { name: "Close comment" }).tap();
      await expect(commentBox).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("tablet: 1-finger move/marquee/hand, 2-finger rollback over handles & comment drafts, lift/re-add finger, long-press menu, pen + palm rejection", async ({
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
      // Collapse both side panels so the full 1024 x 768 canvas is unobstructed, zoom 100% centered.
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([]);
      });
      await page.waitForTimeout(80);

      const rectScreen = async (id: string) =>
        page.evaluate((nid) => {
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

      // 1. Tap selects rectA; one-finger drag on rectA moves it.
      const a0 = await rectScreen(rectAId);
      await cdpTap(cdp, a0.cx, a0.cy);
      expect((await readSnapshot(page, rectAId)).selection).toEqual([rectAId]);

      const beforeMove = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: a0.cx, y: a0.cy }, { x: a0.cx + 50, y: a0.cy + 30 }, 8);
      const afterMove = await readSnapshot(page, rectAId);
      expect(afterMove.node?.x).toBeCloseTo((beforeMove.node?.x ?? 0) + 50, 0);
      expect(afterMove.node?.y).toBeCloseTo((beforeMove.node?.y ?? 0) + 30, 0);
      expect(afterMove.undoDepth).toBe(beforeMove.undoDepth + 1);

      // Undo back to original position and wait for sync to settle.
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.undo());
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 10_000 });
      await page.waitForTimeout(100);

      // 2. One-finger drag on empty canvas marquee-selects in Select tool.
      const a1 = await rectScreen(rectAId);
      const b1 = await rectScreen(rectBId);
      await cdpDrag(
        cdp,
        { x: a1.left - 30, y: a1.top - 30 },
        { x: b1.right + 30, y: b1.bottom + 30 },
        8,
      );
      const afterMarquee = await readSnapshot(page, rectAId);
      expect(afterMarquee.selection.sort()).toEqual([rectAId, rectBId].sort());

      // 3. In Hand tool, one-finger drag pans camera without moving layers.
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("hand"));
      const beforeHand = await readSnapshot(page, rectAId);
      await cdpDrag(cdp, { x: a1.cx, y: a1.cy }, { x: a1.cx + 40, y: a1.cy - 20 }, 6);
      const afterHand = await readSnapshot(page, rectAId);
      expect(afterHand.camera.x - beforeHand.camera.x).toBeCloseTo(40, 0);
      expect(afterHand.camera.y - beforeHand.camera.y).toBeCloseTo(-20, 0);
      expect(afterHand.node).toEqual(beforeHand.node);
      // Restore Select tool and recenter.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.setTool("select");
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await page.waitForTimeout(100);

      // 4. Two-finger pinch starting OVER the selected layer's SE resize handle (within slop):
      // Must NOT resize the 160x100 rectangle and must leave selection, undo depth, and revn unchanged.
      const handleBox = await rectScreen(rectAId);
      const se = { x: handleBox.right, y: handleBox.bottom };
      const other = { x: handleBox.left, y: handleBox.top };
      const beforeHandlePinch = await readSnapshot(page, rectAId);
      await touchStart(cdp, [{ id: 1, x: se.x, y: se.y }]);
      await touchStart(cdp, [
        { id: 1, x: se.x, y: se.y },
        { id: 2, x: other.x, y: other.y },
      ]);
      // Pinch inward aggressively (what previously shrank 160 -> 83 px) with zero React re-renders.
      const tabletCommitsBefore = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        await touchMove(cdp, [
          { id: 1, x: se.x - 45 * t, y: se.y - 25 * t },
          { id: 2, x: other.x + 20 * t, y: other.y + 15 * t },
        ]);
      }
      const tabletCommitsAfter = await page.evaluate(
        () => (window as unknown as { __reactCommits?: number }).__reactCommits ?? 0,
      );
      expect(tabletCommitsAfter - tabletCommitsBefore).toBe(0);
      await touchEnd(cdp, [{ id: 2, x: other.x + 20, y: other.y + 15 }]);
      await touchEnd(cdp, []);
      await page.waitForTimeout(120);
      const afterHandlePinch = await readSnapshot(page, rectAId);
      expect(afterHandlePinch.camera.zoom).toBeLessThan(beforeHandlePinch.camera.zoom * 0.8);
      expect(afterHandlePinch.node).toEqual(beforeHandlePinch.node);
      expect(afterHandlePinch.selection).toEqual(beforeHandlePinch.selection);
      expect(afterHandlePinch.undoDepth).toBe(beforeHandlePinch.undoDepth);
      expect(afterHandlePinch.redoDepth).toBe(beforeHandlePinch.redoDepth);
      expect(afterHandlePinch.revn).toBe(beforeHandlePinch.revn);
      expect(afterHandlePinch.pendingCount).toBe(0);

      // 5. Mid-drag second-finger rollback: finger 1 drags the SE handle 40 px inward (past slop,
      // actively resizing locally!), THEN finger 2 lands and pinches. Rollback must restore exact
      // width/height, undoDepth, redoDepth, selection, and send ZERO transactions to server.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await page.waitForTimeout(100);
      const midBox = await rectScreen(rectAId);
      const beforeMidRollback = await readSnapshot(page, rectAId);
      await touchStart(cdp, [{ id: 1, x: midBox.right, y: midBox.bottom }]);
      await touchMove(cdp, [{ id: 1, x: midBox.right - 20, y: midBox.bottom }]);
      await touchMove(cdp, [{ id: 1, x: midBox.right - 40, y: midBox.bottom }]);
      // Confirm resize actually engaged locally before finger 2 lands.
      const duringDrag = await readSnapshot(page, rectAId);
      expect(duringDrag.node?.width).toBeLessThan(160);
      expect(duringDrag.holding).toBe(true);
      // Now finger 2 lands and expands to zoom in.
      await touchStart(cdp, [
        { id: 1, x: midBox.right - 40, y: midBox.bottom },
        { id: 2, x: midBox.left, y: midBox.top },
      ]);
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        await touchMove(cdp, [
          { id: 1, x: midBox.right - 40 + 40 * t, y: midBox.bottom + 20 * t },
          { id: 2, x: midBox.left - 30 * t, y: midBox.top - 20 * t },
        ]);
      }
      // Lift finger 2 mid-pinch, drag finger 1 over the layer (must NOT move/resize it!), then re-add finger 2.
      await touchEnd(cdp, [{ id: 1, x: midBox.right, y: midBox.bottom + 20 }]);
      await touchMove(cdp, [{ id: 1, x: midBox.right + 45, y: midBox.bottom + 35 }]);
      await touchStart(cdp, [
        { id: 1, x: midBox.right + 45, y: midBox.bottom + 35 },
        { id: 3, x: midBox.left, y: midBox.top },
      ]);
      await touchMove(cdp, [
        { id: 1, x: midBox.right + 65, y: midBox.bottom + 45 },
        { id: 3, x: midBox.left - 20, y: midBox.top - 10 },
      ]);
      await touchEnd(cdp, [{ id: 1, x: midBox.right + 65, y: midBox.bottom + 45 }]);
      await touchEnd(cdp, []);
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
      // Zoom pill updated live in DOM without React per-move renders.
      const zoomText = await page.locator(".zoom__value").textContent();
      expect(zoomText).toBe(`${Math.round(afterMidRollback.camera.zoom * 100)}%`);
      await maybeShot(page, "tablet-after-pinch-rollback.png");

      // 6. Touchcancel mid-drag rolls back uncommitted move cleanly.
      await page.evaluate((id) => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.select([id]);
      }, rectAId);
      await page.waitForTimeout(80);
      const cancelBox = await rectScreen(rectAId);
      const beforeCancelDrag = await readSnapshot(page, rectAId);
      await touchStart(cdp, [{ id: 1, x: cancelBox.cx, y: cancelBox.cy }]);
      await touchMove(cdp, [{ id: 1, x: cancelBox.cx + 45, y: cancelBox.cy + 25 }]);
      expect((await readSnapshot(page, rectAId)).node?.x).not.toBe(beforeCancelDrag.node?.x);
      await touchCancel(cdp);
      await page.waitForTimeout(100);
      const afterCancelDrag = await readSnapshot(page, rectAId);
      expect(afterCancelDrag.node).toEqual(beforeCancelDrag.node);
      expect(afterCancelDrag.undoDepth).toBe(beforeCancelDrag.undoDepth);
      expect(afterCancelDrag.revn).toBe(beforeCancelDrag.revn);

      // 7. Two-finger pan/pinch leaves an open comment draft popover unchanged.
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
      // Cancel draft and switch back to Select tool.
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("select"));

      // 8. Stationary long-press on tablet opens context menu at the finger; lifting does not close or click it.
      const menuBox = await rectScreen(rectAId);
      await touchStart(cdp, [{ id: 1, x: menuBox.cx, y: menuBox.cy }]);
      await page.waitForTimeout(600);
      await touchEnd(cdp, []);
      const menu = page.getByRole("menu", { name: /actions/i });
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await maybeShot(page, "tablet-longpress-contextmenu.png");
      // Dismiss menu by tapping empty canvas.
      await cdpTap(cdp, 280, 140);
      await expect(menu).toBeHidden();

      // 9. Apple Pencil (pointerType: "pen") draws precisely while concurrent palm is ignored,
      // and subsequent finger touches switch to navigation-only (palm rejection).
      await page.evaluate(() => {
        const ed = (window as unknown as DebugWindow).drawpane;
        ed.zoomTo(1);
        ed.centerOn({ x: 380, y: 250 });
        ed.setTool("rect");
      });
      await page.waitForTimeout(80);
      const beforePen = await readSnapshot(page, rectAId);
      // Pen starts drawing a rectangle while a palm touch lands and slides nearby.
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
      // Concurrent palm did not pan the camera during the pen stroke.
      expect(afterPen.camera).toEqual(beforePen.camera);

      // Now penSeen is true: switch back to rect tool and drag with a FINGER.
      // Finger must PAN the camera (never draw another rectangle, never open menu on hold).
      await page.evaluate(() => (window as unknown as DebugWindow).drawpane.setTool("rect"));
      const beforePalmNav = await readSnapshot(page, rectAId);
      // Stationary finger hold must not open context menu in palm-rejection mode.
      await touchStart(cdp, [{ id: 1, x: 400, y: 300 }]);
      await page.waitForTimeout(600);
      await touchEnd(cdp, []);
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect((await readSnapshot(page, rectAId)).childCount).toBe(beforePalmNav.childCount);

      // Finger drag pans camera instead of drawing a rect.
      await cdpDrag(cdp, { x: 400, y: 300 }, { x: 480, y: 350 }, 6);
      const afterPalmNav = await readSnapshot(page, rectAId);
      expect(afterPalmNav.childCount).toBe(beforePalmNav.childCount);
      expect(afterPalmNav.camera.x - beforePalmNav.camera.x).toBeCloseTo(80, 0);
      expect(afterPalmNav.camera.y - beforePalmNav.camera.y).toBeCloseTo(50, 0);
      expect(afterPalmNav.camera.zoom).toBeCloseTo(beforePalmNav.camera.zoom, 4);
    } finally {
      await context.close();
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
      // Exposed canvas on right side of the single default left panel (240 px + margins).
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
