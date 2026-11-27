/**
 * Mobile file view (phones 360-430 px) and tablet workspace layout (768-1194 px).
 *
 * Covers small and larger files opened from scratch across phone and tablet viewports,
 * canvas auto-fit against real visible insets, page switching, tap-to-select and
 * read-only Inspect, deep-linked comment threads with touch submit, injected
 * visualViewport keyboard geometry, owner and viewer roles, rotation, collapsed
 * panes, 44 px minimum touch targets for primary actions, and zero horizontal page
 * scroll.
 */
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { addPasskey, freshInstance, type Instance } from "../fresh-instance";

interface DeviceProfile {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

const PHONE_360: DeviceProfile = {
  name: "phone-360",
  viewport: { width: 360, height: 800 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const PHONE_393: DeviceProfile = {
  name: "phone-393",
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const PHONE_412: DeviceProfile = {
  name: "phone-412",
  viewport: { width: 412, height: 839 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

const PHONE_430: DeviceProfile = {
  name: "phone-430",
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const TABLET_768_PORTRAIT: DeviceProfile = {
  name: "tablet-768-portrait",
  viewport: { width: 768, height: 1024 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const TABLET_768_LANDSCAPE: DeviceProfile = {
  name: "tablet-768-landscape",
  viewport: { width: 1024, height: 768 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const TABLET_1194_LANDSCAPE: DeviceProfile = {
  name: "tablet-1194-landscape",
  viewport: { width: 1194, height: 834 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const ALL_PHONES: readonly DeviceProfile[] = [PHONE_360, PHONE_393, PHONE_412, PHONE_430];

/** Optional output directory for PR before/after screenshots; unset in normal runs. */
const SHOTS_DIR = process.env.MOBILE_SHOTS_DIR ?? "";

interface DebugEditor {
  readonly s: {
    readonly pageId: string;
    readonly role: string;
    readonly readOnly: boolean;
    readonly tool: string;
    readonly selection: readonly string[];
    readonly editingText: string | null;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly camera: {
      readonly x: number;
      readonly y: number;
      readonly zoom: number;
      toScreen(p: { x: number; y: number }): { x: number; y: number };
      toPage(p: { x: number; y: number }): { x: number; y: number };
    };
    readonly viewport: { readonly width: number; readonly height: number };
    readonly insets: {
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly left: number;
    };
  };
  readonly doc: {
    readonly version: number;
    get(id: string): { id: string; type: string; props: Record<string, unknown> } | undefined;
    childIds(id: string): readonly string[];
    pageIds(): readonly string[];
  };
  readonly scene: {
    bounds(id: string): { x: number; y: number; width: number; height: number } | null;
    unionBounds(
      ids: Iterable<string>,
    ): { x: number; y: number; width: number; height: number } | null;
  };
  addPage(): void;
  setPage(id: string): void;
  rename(id: string, name: string): void;
  select(ids: string[]): void;
  setProp(ids: string[], prop: string, value: unknown): void;
  startTextEdit(id: string): void;
  zoomTo(zoom: number): void;
  undo(): void;
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
}

interface MockVisualViewportOverride {
  width?: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
}

type DebugWindow = Window & {
  drawpane: DebugEditor;
  __setMockVisualViewport?: (next: MockVisualViewportOverride | null) => void;
};

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("Expected element to have a visible bounding box");
  return b;
}

async function maybeShot(page: Page, filename: string) {
  if (!SHOTS_DIR) return;
  await page.screenshot({ path: join(SHOTS_DIR, filename) });
}

/**
 * Installs a controllable `window.visualViewport` mock on a BrowserContext so tests
 * can simulate on-screen keyboard geometry and offsetTop scrolling deterministically.
 */
async function installMockVisualViewport(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const target = new EventTarget();
    let override: MockVisualViewportOverride | null = null;

    const mock = {
      get width() {
        return override?.width ?? window.innerWidth;
      },
      get height() {
        return override?.height ?? window.innerHeight;
      },
      get offsetLeft() {
        return override?.offsetLeft ?? 0;
      },
      get offsetTop() {
        return override?.offsetTop ?? 0;
      },
      get pageLeft() {
        return override?.offsetLeft ?? 0;
      },
      get pageTop() {
        return override?.offsetTop ?? 0;
      },
      get scale() {
        return 1;
      },
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };

    try {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        get: () => mock,
      });
    } catch {
      // Fall back to real visualViewport if non-configurable.
    }

    window.addEventListener("resize", () => {
      if (!override) target.dispatchEvent(new Event("resize"));
    });

    (window as unknown as DebugWindow).__setMockVisualViewport = (next) => {
      override = next;
      target.dispatchEvent(new Event("resize"));
      target.dispatchEvent(new Event("scroll"));
    };
  });
}

async function setKeyboardViewport(page: Page, next: MockVisualViewportOverride | null) {
  await page.evaluate((value) => {
    (window as unknown as DebugWindow).__setMockVisualViewport?.(value);
  }, next);
}

async function openDeviceContext(
  browser: Browser,
  baseURL: string,
  profile: DeviceProfile,
  storageState: StorageState,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    storageState,
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("drawpane:debug", "1");
    } catch {
      // Ignore opaque origins before navigation.
    }
  });
  await installMockVisualViewport(context);
  const page = await context.newPage();
  return { context, page };
}

async function waitForEditorReady(page: Page) {
  await expect(page.locator(".editor")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          return Boolean(e?.s.pageId && e.s.viewport.width > 0);
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(
    metrics.innerWidth,
  );
}

/**
 * Verifies that the current page's content is fitted cleanly inside the actual exposed
 * canvas area (clear of visible top/bottom/side chrome) and well above the old broken 2% zoom.
 */
async function expectContentFitsExposedCanvas(page: Page, label: string) {
  // The DOM can rotate before the canvas ResizeObserver updates the editor's viewport and fit.
  await expect(async () => {
    const info = await page.evaluate(() => {
      const e = (window as unknown as DebugWindow).drawpane;
      const canvas = document.querySelector(".canvas");
      if (!e || !canvas) throw new Error("The editor canvas has not mounted yet");
      const bounds = e.scene.unionBounds(e.doc.childIds(e.s.pageId));
      if (!bounds || bounds.width <= 0 || bounds.height <= 0)
        throw new Error("Expected non-empty page bounds");
      const { width, height } = canvas.getBoundingClientRect();
      const { camera, viewport, insets } = e.s;
      const tl = camera.toScreen({ x: bounds.x, y: bounds.y });
      const br = camera.toScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      const exposedLeft = insets.left;
      const exposedRight = viewport.width - insets.right;
      const exposedTop = insets.top;
      const exposedBottom = viewport.height - insets.bottom;
      const exposedW = Math.max(1, exposedRight - exposedLeft);
      const exposedH = Math.max(1, exposedBottom - exposedTop);
      const fillRatio = Math.max((br.x - tl.x) / exposedW, (br.y - tl.y) / exposedH);
      const rectOf = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0
          ? { top: r.top, right: r.right, bottom: r.bottom, left: r.left }
          : null;
      };
      const domTop = Math.max(rectOf(".phone-topbar")?.bottom ?? 0, rectOf(".topbar")?.bottom ?? 0);
      const dockRect = rectOf(".phone-dock");
      const barRect = rectOf(".bottom-bar");
      const domBottom = Math.min(
        dockRect ? dockRect.top : viewport.height,
        barRect ? barRect.top : viewport.height,
      );
      const domLeft = rectOf(".pane--left")?.right ?? 0;
      const rightPane = rectOf(".pane--right");
      const domRight = rightPane ? rightPane.left : viewport.width;
      return {
        viewport,
        canvasSize: { width, height },
        zoom: camera.zoom,
        tl,
        br,
        exposedLeft,
        exposedRight,
        exposedTop,
        exposedBottom,
        domLeft,
        domRight,
        domTop,
        domBottom,
        fillRatio,
      };
    });

    expect(info.viewport, `${label}: editor viewport matches the canvas`).toEqual(info.canvasSize);
    // Never the broken 2% MIN_ZOOM fallback.
    expect(info.zoom, `${label}: zoom`).toBeGreaterThan(0.05);
    // Content sits inside both reported insets and actual rendered DOM chrome (2 px rounding tolerance).
    expect(info.tl.x, `${label}: content left inside exposed canvas`).toBeGreaterThanOrEqual(
      Math.max(info.exposedLeft, info.domLeft) - 2,
    );
    expect(info.br.x, `${label}: content right inside exposed canvas`).toBeLessThanOrEqual(
      Math.min(info.exposedRight, info.domRight) + 2,
    );
    expect(info.tl.y, `${label}: content top inside exposed canvas`).toBeGreaterThanOrEqual(
      Math.max(info.exposedTop, info.domTop) - 2,
    );
    expect(info.br.y, `${label}: content bottom inside exposed canvas`).toBeLessThanOrEqual(
      Math.min(info.exposedBottom, info.domBottom) + 2,
    );
    // Content occupies a meaningful portion of the exposed area (unless already at 100%).
    if (info.zoom < 0.99) {
      expect(info.fillRatio, `${label}: fill ratio`).toBeGreaterThan(0.5);
    }
  }).toPass({ timeout: 10_000 });
}

async function expectTouchTargetAtLeast44(locator: Locator, label: string) {
  await expect(locator, `${label}: visible`).toBeVisible();
  const b = await box(locator);
  expect(b.width, `${label}: width >= 44`).toBeGreaterThanOrEqual(44);
  expect(b.height, `${label}: height >= 44`).toBeGreaterThanOrEqual(44);
}

test.describe
  .serial("Mobile phone view and tablet workspace layout", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let ownerState: StorageState;
    let viewerState: StorageState;
    let smallFilePath: string;
    let largeFilePath: string;
    let heroBannerId: string;
    let heroTitleId: string;
    let deepLinkThreadId: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000);
      instance = await freshInstance(browser, { port: 18930, inspectorPort: 19430 });
      const ana = instance.page;
      await ana.evaluate(() => localStorage.setItem("drawpane:debug", "1"));

      // 1. Seed a small multi-page file with frames, shapes, text and a real anchored comment.
      await ana.getByRole("button", { name: "New file", exact: true }).first().click();
      await waitForEditorReady(ana);
      smallFilePath = new URL(ana.url()).pathname;
      const smallFileId = smallFilePath.split("/").at(-1) as string;

      await ana.evaluate(async (fid) => {
        await fetch(`/api/files/${fid}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Mobile Checkout" }),
        });
      }, smallFileId);

      const seededSmall = await ana.evaluate(() => {
        const e = (window as unknown as DebugWindow).drawpane;
        const solid = (color: string) => [{ type: "solid", color }];
        const page1 = e.s.pageId;
        const frame = e.createLayer("frame", { x: 0, y: 0, width: 390, height: 640 }, page1, {
          name: "Checkout Screen",
          fills: solid("#f7f5f0"),
        }) as string;
        const banner = e.createLayer("rect", { x: 24, y: 24, width: 342, height: 180 }, frame, {
          name: "Hero banner",
          cornerRadius: 12,
          fills: solid("#2b4fd6"),
        }) as string;
        const title = e.createLayer("text", { x: 24, y: 232, width: 342, height: 48 }, frame, {
          name: "Hero title",
          fills: solid("#1c1b1a"),
        }) as string;
        e.setProp([title], "characters", "Review your order");
        e.createLayer("rect", { x: 24, y: 310, width: 220, height: 56 }, frame, {
          name: "Primary CTA",
          cornerRadius: 10,
          fills: solid("#e0531f"),
        });

        // Second page for page switching verification.
        e.addPage();
        const page2 = e.s.pageId;
        e.rename(page2, "Components");
        const grid = e.createLayer("frame", { x: 80, y: 60, width: 720, height: 460 }, page2, {
          name: "Icon Grid",
          fills: solid("#eef3ff"),
        }) as string;
        e.createLayer("rect", { x: 120, y: 110, width: 180, height: 180 }, grid, {
          name: "Swatch Primary",
          fills: solid("#2b4fd6"),
        });
        e.createLayer("ellipse", { x: 350, y: 110, width: 180, height: 180 }, grid, {
          name: "Swatch Accent",
          fills: solid("#0f8a7e"),
        });
        e.setPage(page1);
        e.select([]);
        return { page1, banner, title };
      });
      heroBannerId = seededSmall.banner;
      heroTitleId = seededSmall.title;
      await expect(ana.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });

      // Create an anchored comment thread on Hero banner so we have a real deep link.
      deepLinkThreadId = await ana.evaluate(
        async ({ fid, pageId, nodeId }) => {
          const res = await fetch(`/api/files/${fid}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pageId,
              x: 195,
              y: 114,
              nodeId,
              offset: { x: 0.5, y: 0.5 },
              body: "Check hero contrast on phones",
              mentions: [],
            }),
          });
          if (!res.ok) throw new Error(`Comment create failed: ${res.status}`);
          const data = (await res.json()) as { thread: { id: string } };
          return data.thread.id;
        },
        { fid: smallFileId, pageId: seededSmall.page1, nodeId: heroBannerId },
      );
      expect(deepLinkThreadId).toBeTruthy();

      // 2. Seed a larger multi-board file (12 boards, ~160 nodes) from scratch.
      await ana.goto(instance.url);
      await expect(ana.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await ana.getByRole("button", { name: "New file", exact: true }).first().click();
      await waitForEditorReady(ana);
      largeFilePath = new URL(ana.url()).pathname;
      const largeFileId = largeFilePath.split("/").at(-1) as string;

      await ana.evaluate(async (fid) => {
        await fetch(`/api/files/${fid}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Design System Kit" }),
        });
      }, largeFileId);

      await ana.evaluate(() => {
        const e = (window as unknown as DebugWindow).drawpane;
        const solid = (color: string) => [{ type: "solid", color }];
        const palette = ["#2b4fd6", "#0f8a7e", "#e0531f", "#6d28d9"];
        const page1 = e.s.pageId;
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 4; col++) {
            const bx = col * 520;
            const by = row * 940;
            const board = e.createLayer("frame", { x: bx, y: by, width: 390, height: 820 }, page1, {
              name: `Screen ${row * 4 + col + 1}`,
              fills: solid("#ffffff"),
            }) as string;
            e.createLayer("rect", { x: bx + 20, y: by + 20, width: 350, height: 140 }, board, {
              name: `Banner ${row}-${col}`,
              cornerRadius: 12,
              fills: solid(palette[(row + col) % palette.length] as string),
            });
            for (let c = 0; c < 4; c++) {
              e.createLayer(
                "rect",
                { x: bx + 20, y: by + 188 + c * 145, width: 350, height: 120 },
                board,
                {
                  name: `Card ${row}-${col}-${c}`,
                  cornerRadius: 10,
                  fills: solid("#f3f1ec"),
                },
              );
              const label = e.createLayer(
                "text",
                { x: bx + 36, y: by + 204 + c * 145, width: 280, height: 28 },
                board,
                { name: `Heading ${c}`, fills: solid("#1c1b1a") },
              ) as string;
              e.setProp([label], "characters", `Section ${c + 1}`);
            }
          }
        }
        e.addPage();
        const page2 = e.s.pageId;
        e.rename(page2, "Desktop Flows");
        for (let i = 0; i < 4; i++) {
          const bx = i * 1600;
          const board = e.createLayer("frame", { x: bx, y: 0, width: 1440, height: 900 }, page2, {
            name: `Desktop ${i + 1}`,
            fills: solid("#f7f5f0"),
          }) as string;
          e.createLayer("rect", { x: bx + 80, y: 80, width: 1280, height: 220 }, board, {
            name: `Hero ${i + 1}`,
            fills: solid("#2b4fd6"),
          });
        }
        e.setPage(page1);
        e.select([]);
      });
      await expect(ana.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });

      ownerState = await instance.context.storageState();

      // 3. Invite and sign up a viewer (Bo Chen) once, then reuse session cookies across contexts.
      const inviteUrl = await ana.evaluate(async () => {
        const { teams } = (await (await fetch("/api/teams")).json()) as {
          teams: { id: string }[];
        };
        const res = await fetch(`/api/teams/${teams[0]?.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "viewer" }),
        });
        return ((await res.json()) as { url: string }).url;
      });
      const boCtx = await browser.newContext({ baseURL: instance.url });
      try {
        const boPage = await boCtx.newPage();
        await addPasskey(boCtx, boPage);
        await boPage.goto(new URL(inviteUrl).pathname);
        await boPage.getByLabel("Your name").fill("Bo Chen");
        await boPage.getByLabel("Email").fill("bo@example.com");
        await boPage.getByRole("button", { name: "Create account with a passkey" }).click();
        await expect(boPage.getByRole("heading", { name: "Recent files" })).toBeVisible({
          timeout: 15_000,
        });
        viewerState = await boCtx.storageState();
      } finally {
        await boCtx.close();
      }
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("phones (360, 393, 412, 430 px): small and larger files fit exposed canvas with >= 44 px targets and no horizontal scroll", async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      for (const profile of ALL_PHONES) {
        const { context, page } = await openDeviceContext(
          browser,
          instance.url,
          profile,
          ownerState,
        );
        try {
          // Small file opened from scratch.
          await page.goto(smallFilePath);
          await waitForEditorReady(page);

          await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "phone");
          await expect(page.locator(".pane--left")).toHaveCount(0);
          await expect(page.locator(".pane--right")).toHaveCount(0);
          await expect(page.locator(".toolbar")).toHaveCount(0);

          await expectNoHorizontalScroll(page, `${profile.name} small`);
          await expectContentFitsExposedCanvas(page, `${profile.name} small`);

          // Primary targets on topbar and dock are >= 44 px.
          await expectTouchTargetAtLeast44(
            page.getByRole("link", { name: "Back to files" }),
            `${profile.name} back`,
          );
          await expectTouchTargetAtLeast44(
            page.getByRole("button", { name: "Zoom to fit" }),
            `${profile.name} fit`,
          );
          await expectTouchTargetAtLeast44(
            page.getByRole("button", { name: "Share", exact: true }),
            `${profile.name} share`,
          );
          for (const dockLabel of ["Pages", "Inspect", "Comments", "Play"]) {
            await expectTouchTargetAtLeast44(
              page
                .locator(".phone-dock")
                .getByRole("button", { name: new RegExp(`^${dockLabel}`) }),
              `${profile.name} dock ${dockLabel}`,
            );
          }

          if (profile.name === "phone-393") {
            await maybeShot(page, "after-phone-393-editor.png");
          }

          // Larger file opened fresh from scratch.
          await page.goto(largeFilePath);
          await waitForEditorReady(page);
          await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "phone");
          await expectNoHorizontalScroll(page, `${profile.name} large`);
          await expectContentFitsExposedCanvas(page, `${profile.name} large`);

          if (profile.name === "phone-412") {
            await maybeShot(page, "after-phone-412-large.png");
          }
        } finally {
          await context.close();
        }
      }
    });

    test("phone workspace: switch pages, tap select and inspect, read-only guards for owner, rename with Done/Cancel, and rotation", async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const { context, page } = await openDeviceContext(
        browser,
        instance.url,
        PHONE_393,
        ownerState,
      );
      try {
        await page.goto(smallFilePath);
        await waitForEditorReady(page);

        // Even for the owner, phone mode enforces readOnly so document-changing edits are disabled.
        const stateBefore = await page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          return { role: e.s.role, readOnly: e.s.readOnly };
        });
        expect(stateBefore.role).toBe("owner");
        expect(stateBefore.readOnly).toBe(true);

        // Tap Hero banner on the canvas to select it for inspection.
        const bannerScreen = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          const b = e.scene.bounds(id);
          if (!b) throw new Error("Missing Hero banner bounds");
          return e.s.camera.toScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
        }, heroBannerId);
        await page.touchscreen.tap(bannerScreen.x, bannerScreen.y);

        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as DebugWindow).drawpane.s.selection[0] ?? null),
          )
          .toBe(heroBannerId);

        // Dragging on canvas and authoring shortcuts (R, Delete) must NOT mutate the document.
        const posBefore = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          const b = e.scene.bounds(id);
          return b ? { x: b.x, y: b.y } : null;
        }, heroBannerId);
        await page.mouse.move(bannerScreen.x, bannerScreen.y);
        await page.mouse.down();
        await page.mouse.move(bannerScreen.x + 60, bannerScreen.y + 40, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.press("r");
        await page.keyboard.press("Delete");
        const afterAttempt = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          const b = e.scene.bounds(id);
          return {
            exists: Boolean(e.doc.get(id)),
            tool: e.s.tool,
            pos: b ? { x: b.x, y: b.y } : null,
          };
        }, heroBannerId);
        expect(afterAttempt.exists).toBe(true);
        expect(afterAttempt.tool).toBe("select");
        expect(afterAttempt.pos).toEqual(posBefore);

        // Open Inspect sheet: shows read-only properties for Hero banner, dismiss returns focus.
        const inspectTrigger = page
          .locator(".phone-dock")
          .getByRole("button", { name: /^Inspect/ });
        await inspectTrigger.tap();
        const inspectSheet = page.getByRole("dialog", { name: "Inspect" });
        await expect(inspectSheet).toBeVisible();
        await expect(inspectSheet.getByRole("heading", { name: "Hero banner" })).toBeVisible();
        await expect(inspectSheet.getByRole("button", { name: "Copy code" })).toBeVisible();
        // Backdrop scrim is hidden from assistive tech so there is only one Close Inspect button.
        await expect(page.getByRole("button", { name: "Close Inspect" })).toHaveCount(1);
        await maybeShot(page, "after-phone-393-inspect.png");
        // Pressing Escape even with focus on body closes Inspect without changing the selection.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("Escape");
        await expect(inspectSheet).toBeHidden();
        expect(
          await page.evaluate(
            () => (window as unknown as DebugWindow).drawpane.s.selection[0] ?? null,
          ),
        ).toBe(heroBannerId);

        // Re-open Inspect and close via its button to verify focus restoration.
        await inspectTrigger.tap();
        await expect(inspectSheet).toBeVisible();
        await inspectSheet.getByRole("button", { name: "Close Inspect" }).tap();
        await expect(inspectSheet).toBeHidden();
        await expect(inspectTrigger).toBeFocused();

        // Open Pages sheet: Escape closes it even with nothing selected and focus on body.
        await page.evaluate(() => (window as unknown as DebugWindow).drawpane.select([]));
        const pagesTrigger = page.locator(".phone-dock").getByRole("button", { name: /^Pages/ });
        await pagesTrigger.tap();
        const pagesSheet = page.getByRole("dialog", { name: "Pages" });
        await expect(pagesSheet).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press("Escape");
        await expect(pagesSheet).toBeHidden();

        // Open Pages sheet again: switch to Components page, sheet dismisses and page re-fits.
        await pagesTrigger.tap();
        await expect(pagesSheet).toBeVisible();
        await expect(pagesSheet.getByRole("button", { name: "Components" })).toBeVisible();
        await maybeShot(page, "after-phone-393-pages.png");
        await pagesSheet.getByRole("button", { name: "Components" }).tap();
        await expect(pagesSheet).toBeHidden();
        await expect(pagesTrigger).toBeFocused();
        await expectContentFitsExposedCanvas(page, "phone-393 switched to Components");

        // Switch back to Page 1.
        await pagesTrigger.tap();
        await page
          .getByRole("dialog", { name: "Pages" })
          .getByRole("button", { name: "Page 1" })
          .tap();
        await expectContentFitsExposedCanvas(page, "phone-393 back to Page 1");

        // Owner file rename with explicit Cancel and Done controls.
        const renameBtn = page.getByRole("button", { name: /Rename file Mobile Checkout/ });
        await renameBtn.tap();
        const renameInput = page.getByRole("textbox", { name: "File name" });
        await expect(renameInput).toBeVisible();
        await renameInput.fill("Discarded Name");
        await page.locator(".phone-topbar").getByRole("button", { name: "Cancel" }).tap();
        await expect(
          page.getByRole("button", { name: /Rename file Mobile Checkout/ }),
        ).toBeVisible();

        await page.getByRole("button", { name: /Rename file Mobile Checkout/ }).tap();
        await page.getByRole("textbox", { name: "File name" }).fill("Mobile Checkout v2");
        await page.locator(".phone-topbar").getByRole("button", { name: "Done" }).tap();
        await expect(
          page.getByRole("button", { name: /Rename file Mobile Checkout v2/ }),
        ).toBeVisible();

        // Rotate phone to landscape (852 x 393): untouched auto-fit re-fits, no overflow.
        await page.setViewportSize({ width: 852, height: 393 });
        await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "phone");
        await expectNoHorizontalScroll(page, "phone-393 rotated landscape");
        await expectContentFitsExposedCanvas(page, "phone-393 rotated landscape");

        // Rotate back to portrait (393 x 852).
        await page.setViewportSize({ width: 393, height: 852 });
        await expectNoHorizontalScroll(page, "phone-393 rotated portrait");
        await expectContentFitsExposedCanvas(page, "phone-393 rotated portrait");

        // Once the user zooms in manually, rotation preserves their zoom and centred page point.
        const customFocusBefore = await page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          e.zoomTo(2.2);
          const { viewport, insets, camera } = e.s;
          const cx = insets.left + (viewport.width - insets.left - insets.right) / 2;
          const cy = insets.top + (viewport.height - insets.top - insets.bottom) / 2;
          return { zoom: camera.zoom, focus: camera.toPage({ x: cx, y: cy }) };
        });
        await page.setViewportSize({ width: 852, height: 393 });
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as DebugWindow).drawpane.s.viewport.width),
          )
          .toBe(852);
        const customFocusAfter = await page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          const { viewport, insets, camera } = e.s;
          const cx = insets.left + (viewport.width - insets.left - insets.right) / 2;
          const cy = insets.top + (viewport.height - insets.top - insets.bottom) / 2;
          return { zoom: camera.zoom, focus: camera.toPage({ x: cx, y: cy }) };
        });
        expect(customFocusAfter.zoom).toBeCloseTo(customFocusBefore.zoom, 2);
        expect(Math.abs(customFocusAfter.focus.x - customFocusBefore.focus.x)).toBeLessThan(2);
        expect(Math.abs(customFocusAfter.focus.y - customFocusBefore.focus.y)).toBeLessThan(2);
        await page.setViewportSize({ width: 393, height: 852 });

        // After an explicit Zoom to fit, rotating refits automatically again.
        await page.getByRole("button", { name: "Zoom to fit" }).tap();
        await expectContentFitsExposedCanvas(page, "phone-393 after explicit zoom to fit");
        await page.setViewportSize({ width: 852, height: 393 });
        await expectContentFitsExposedCanvas(page, "phone-393 rotated after explicit zoom to fit");
        await page.setViewportSize({ width: 393, height: 852 });

        // File drops on a phone are swallowed so the browser does not navigate away or mutate the file.
        const dropResult = await page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          const versionBefore = e.doc.version;
          const dt = new DataTransfer();
          dt.items.add(new File(["hello"], "drop.png", { type: "image/png" }));
          const over = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          });
          const drop = new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          });
          const target = document.querySelector(".canvas") ?? document.body;
          target.dispatchEvent(over);
          target.dispatchEvent(drop);
          return {
            overPrevented: over.defaultPrevented,
            dropPrevented: drop.defaultPrevented,
            unchanged: e.doc.version === versionBefore,
          };
        });
        expect(dropResult).toEqual({
          overPrevented: true,
          dropPrevented: true,
          unchanged: true,
        });

        // viewport-fit=cover is active inside the editor and removed when leaving to dashboard.
        const editorMeta = await page.evaluate(
          () => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
        );
        expect(editorMeta).toContain("viewport-fit=cover");
        await page.getByRole("link", { name: "Back to files" }).tap();
        await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible({
          timeout: 15_000,
        });
        const dashboardMeta = await page.evaluate(
          () => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
        );
        expect(dashboardMeta).not.toContain("viewport-fit=cover");
      } finally {
        await context.close();
      }
    });

    test("phone deep-linked comment thread, touch pin placement, draft preservation, landscape keyboard geometry, and viewer role", async ({
      browser,
    }) => {
      test.setTimeout(150_000);
      // Open the deep-linked thread as viewer (Bo Chen) on 412 px phone.
      const { context, page } = await openDeviceContext(
        browser,
        instance.url,
        PHONE_412,
        viewerState,
      );
      try {
        await page.goto(`${smallFilePath}?thread=${deepLinkThreadId}`);
        await waitForEditorReady(page);
        await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "phone");

        // Viewer gets View only badge and cannot rename the file.
        await expect(page.locator(".phone-topbar").getByText("View only")).toBeVisible();
        await expect(page.getByRole("button", { name: /Rename file/ })).toHaveCount(0);

        // Deep link opens the focused Thread sheet directly without a desktop side panel.
        const threadSheet = page.getByRole("dialog", { name: /Thread on Hero banner/ });
        await expect(threadSheet).toBeVisible({ timeout: 15_000 });
        await expect(threadSheet.getByText("Check hero contrast on phones")).toBeVisible();
        await expectNoHorizontalScroll(page, "phone-412 deep-link thread");

        // Simulate on-screen keyboard shrinking visualViewport with an offsetTop scroll.
        await setKeyboardViewport(page, { height: 380, offsetTop: 18 });
        await expect
          .poll(() =>
            page.evaluate(() =>
              getComputedStyle(document.querySelector(".editor") as HTMLElement)
                .getPropertyValue("--vv-height")
                .trim(),
            ),
          )
          .toBe("380px");

        const replyBox = threadSheet.getByRole("combobox", { name: "Reply" });
        const submitBtn = threadSheet.getByRole("button", { name: "Reply", exact: true });
        await expectTouchTargetAtLeast44(submitBtn, "phone comment touch submit");

        const sheetBox = await box(threadSheet);
        const composerBox = await box(replyBox);
        const submitBox = await box(submitBtn);
        // Sheet, composer, and touch submit stay inside visualViewport [18, 398] x [0, 412].
        expect(sheetBox.y).toBeGreaterThanOrEqual(17);
        expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(399);
        expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(399);
        expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(412);
        expect(submitBox.y).toBeGreaterThanOrEqual(17);
        expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(399);

        await maybeShot(page, "after-phone-412-comment-keyboard.png");

        // Post a reply using the visible touch submit button while the keyboard is open.
        await replyBox.fill("Looks crisp on mobile!");
        await submitBtn.tap();
        await expect(
          threadSheet.getByRole("list", { name: "Messages" }).getByText("Looks crisp on mobile!"),
        ).toBeVisible({
          timeout: 10_000,
        });

        // Landscape phone (852 x 393) with 45% on-screen keyboard: Android (offsetTop 0)
        // and iOS (offsetTop 120) both keep the sheet and 44 px Reply button inside visualViewport.
        await page.setViewportSize({ width: 852, height: 393 });
        await setKeyboardViewport(page, { width: 852, height: 216, offsetTop: 0 });
        await expect
          .poll(() =>
            page.evaluate(() => document.querySelector(".editor")?.getAttribute("data-short-vv")),
          )
          .toBe("true");
        const androidSheet = await box(threadSheet);
        const androidSubmit = await box(submitBtn);
        expect(androidSheet.y).toBeGreaterThanOrEqual(0);
        expect(androidSheet.y + androidSheet.height).toBeLessThanOrEqual(217);
        expect(androidSubmit.height).toBeGreaterThanOrEqual(44);
        expect(androidSubmit.y + androidSubmit.height).toBeLessThanOrEqual(217);
        await maybeShot(page, "after-phone-landscape-comment-keyboard.png");

        await setKeyboardViewport(page, { width: 852, height: 216, offsetTop: 120 });
        await expect
          .poll(() =>
            page.evaluate(() =>
              getComputedStyle(document.querySelector(".editor") as HTMLElement)
                .getPropertyValue("--vv-top")
                .trim(),
            ),
          )
          .toBe("120px");
        const iosSheet = await box(threadSheet);
        const iosSubmit = await box(submitBtn);
        expect(iosSheet.y).toBeGreaterThanOrEqual(119);
        expect(iosSheet.y + iosSheet.height).toBeLessThanOrEqual(337);
        expect(iosSubmit.y).toBeGreaterThanOrEqual(119);
        expect(iosSubmit.y + iosSubmit.height).toBeLessThanOrEqual(337);

        // Return to portrait, dismiss keyboard, and close thread sheet.
        await setKeyboardViewport(page, null);
        await page.setViewportSize(PHONE_412.viewport);
        await threadSheet.getByRole("button", { name: "Close comment" }).tap();
        await expect(threadSheet).toBeHidden();

        // Real touch placement of a brand-new comment on a phone (F1 + F6):
        // tap Comments -> Add comment -> touchscreen.tap on canvas keeps Draft sheet open.
        const commentsTrigger = page
          .locator(".phone-dock")
          .getByRole("button", { name: /^Comments/ });
        await commentsTrigger.tap();
        const commentsSheet = page.getByRole("dialog", { name: "Comments" });
        await expect(commentsSheet).toBeVisible();
        await commentsSheet.getByRole("button", { name: "Add comment" }).tap();
        await expect(commentsSheet).toBeHidden();
        await expect(page.getByText("Tap the canvas to place a comment")).toBeVisible();

        await page.touchscreen.tap(210, 340);
        const draftSheet = page.getByRole("dialog", { name: /^New comment on / });
        await expect(draftSheet).toBeVisible({ timeout: 5_000 });
        const draftInput = draftSheet.getByRole("combobox", { name: "Comment" });
        // Trailing compatibility mousedown/click from the touch tap must not steal focus onto the scrim.
        await expect(draftInput).toBeFocused();
        await draftInput.fill("Touch pin @An");
        const mentionList = page.getByRole("listbox", { name: "People" });
        await expect(mentionList).toBeVisible();

        // Escape dismisses the @mention list first without closing the draft sheet or losing words.
        await page.keyboard.press("Escape");
        await expect(mentionList).toBeHidden();
        await expect(draftSheet).toBeVisible();
        await expect(draftInput).toHaveValue("Touch pin @An");

        // Tapping the backdrop scrim with unsent words keeps the draft sheet and words intact.
        await page.touchscreen.tap(24, 90);
        await expect(draftSheet).toBeVisible();
        await expect(draftInput).toHaveValue("Touch pin @An");

        // Posting via the 44 px Comment button creates and opens the new thread sheet.
        const postBtn = draftSheet.getByRole("button", { name: "Comment", exact: true });
        await expectTouchTargetAtLeast44(postBtn, "phone new comment post");
        await postBtn.tap();
        const createdThread = page.getByRole("dialog", { name: /^Thread on / });
        await expect(createdThread).toBeVisible({ timeout: 10_000 });
        await expect(
          createdThread.getByRole("list", { name: "Messages" }).getByText("Touch pin @An"),
        ).toBeVisible();
        await createdThread.getByRole("button", { name: "Close comment" }).tap();
        await expect(createdThread).toBeHidden();

        // Viewer can still inspect a selected layer on phone.
        await page.evaluate((id) => {
          (window as unknown as DebugWindow).drawpane.select([id]);
        }, heroBannerId);
        const inspectTrigger = page
          .locator(".phone-dock")
          .getByRole("button", { name: /^Inspect/ });
        await inspectTrigger.tap();
        const inspectSheet = page.getByRole("dialog", { name: "Inspect" });
        await expect(inspectSheet).toBeVisible();
        await expect(inspectSheet.getByRole("heading", { name: "Hero banner" })).toBeVisible();
        await inspectSheet.getByRole("button", { name: "Close Inspect" }).tap();
        await expect(inspectTrigger).toBeFocused();
      } finally {
        await context.close();
      }
    });

    test("tablet 768 portrait and landscape: one pane by default in portrait, collapsible panes, rotation, editing with Done/Cancel, and keyboard geometry", async ({
      browser,
    }) => {
      test.setTimeout(150_000);
      const { context, page } = await openDeviceContext(
        browser,
        instance.url,
        TABLET_768_PORTRAIT,
        ownerState,
      );
      try {
        await page.goto(smallFilePath);
        await waitForEditorReady(page);

        await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "tablet");
        await expect(page.locator(".editor")).toHaveAttribute("data-compact-tablet", "true");
        await expectNoHorizontalScroll(page, "tablet-768 portrait small");

        // Cramped portrait opens ONE panel by default (left open, right closed) so the canvas stays wide.
        const leftPane = page.locator(".pane--left");
        const rightPane = page.locator(".pane--right");
        await expect(leftPane).toBeVisible();
        await expect(rightPane).toHaveCount(0);
        await expectContentFitsExposedCanvas(page, "tablet-768 portrait default");
        await maybeShot(page, "after-tablet-768-portrait.png");

        // Primary actions on tablet (including More shapes and layer row controls) are at least 44 px.
        const leftToggle = page.getByRole("button", { name: /layers panel/i });
        const rightToggle = page.getByRole("button", { name: /inspector panel/i });
        await expectTouchTargetAtLeast44(leftToggle, "tablet left toggle");
        await expectTouchTargetAtLeast44(rightToggle, "tablet right toggle");
        await expectTouchTargetAtLeast44(
          page.getByRole("button", { name: "Share", exact: true }),
          "tablet share",
        );
        await expectTouchTargetAtLeast44(
          page.locator(".toolbar").getByRole("button", { name: "Move" }),
          "tablet Move tool",
        );
        await expectTouchTargetAtLeast44(
          page.locator(".toolbar__more"),
          "tablet More shapes trigger",
        );
        await expectTouchTargetAtLeast44(
          leftPane.locator(".dp-layer__toggle").first(),
          "tablet layer row Lock/Hide toggle",
        );

        // Opening right panel in cramped portrait closes left panel (mutual exclusion).
        await rightToggle.tap();
        await expect(rightPane).toBeVisible();
        await expect(leftPane).toHaveCount(0);

        // Tapping right toggle again collapses both panels for full canvas.
        await rightToggle.tap();
        await expect(leftPane).toHaveCount(0);
        await expect(rightPane).toHaveCount(0);
        await expectContentFitsExposedCanvas(page, "tablet-768 portrait both collapsed");

        // Full editor works on tablet: text editing Done/Cancel clears zoom pill, never deletes
        // a cleared layer on Cancel, and leaves undo/redo clean (F2).
        await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          e.select([id]);
          e.startTextEdit(id);
        }, heroTitleId);
        const textBar = page.getByRole("toolbar", { name: "Text editing actions" });
        await expect(textBar).toBeVisible();

        // With no keyboard up, text action bar sits clear above the bottom zoom pill.
        const textBarNoKb = await box(textBar);
        const zoomPillBox = await box(page.locator(".zoom"));
        expect(textBarNoKb.y + textBarNoKb.height).toBeLessThanOrEqual(zoomPillBox.y + 1);

        // Clearing all text and tapping Cancel restores original text, keeps layer, and leaves redo empty.
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Backspace");
        const cancelTextBtn = textBar.getByRole("button", { name: "Cancel" });
        await expectTouchTargetAtLeast44(cancelTextBtn, "tablet text Cancel");
        await cancelTextBtn.tap();
        await expect(textBar).toBeHidden();
        const afterClearCancel = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          const node = e.doc.get(id);
          return {
            exists: Boolean(node),
            characters: node?.props.characters,
            canRedo: e.s.canRedo,
          };
        }, heroTitleId);
        expect(afterClearCancel).toEqual({
          exists: true,
          characters: "Review your order",
          canRedo: false,
        });

        // Typing then tapping Cancel restores exact pre-edit text with nothing pushed onto redo.
        await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          e.select([id]);
          e.startTextEdit(id);
        }, heroTitleId);
        await expect(textBar).toBeVisible();
        await page.keyboard.type(" discarded");
        await cancelTextBtn.tap();
        await expect(textBar).toBeHidden();
        const afterTypeCancel = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          return {
            characters: e.doc.get(id)?.props.characters,
            canRedo: e.s.canRedo,
          };
        }, heroTitleId);
        expect(afterTypeCancel).toEqual({
          characters: "Review your order",
          canRedo: false,
        });

        // Typing with keyboard up and tapping Done commits cleanly and undoes in one step.
        await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          e.select([id]);
          e.startTextEdit(id);
        }, heroTitleId);
        await expect(textBar).toBeVisible();
        await setKeyboardViewport(page, { height: 520, offsetTop: 0 });
        await expect
          .poll(async () => {
            const b = await box(textBar);
            return b.y + b.height;
          })
          .toBeLessThanOrEqual(520);

        await page.keyboard.press("Control+a");
        await page.keyboard.type("Confirmed order");
        const doneTextBtn = textBar.getByRole("button", { name: "Done" });
        await expectTouchTargetAtLeast44(doneTextBtn, "tablet text Done");
        await doneTextBtn.tap();
        await expect(textBar).toBeHidden();
        await setKeyboardViewport(page, null);
        const afterDoneAndUndo = await page.evaluate((id) => {
          const e = (window as unknown as DebugWindow).drawpane;
          const committed = e.doc.get(id)?.props.characters;
          e.undo();
          const undone = e.doc.get(id)?.props.characters;
          return { committed, undone };
        }, heroTitleId);
        expect(afterDoneAndUndo).toEqual({
          committed: "Confirmed order",
          undone: "Review your order",
        });

        // Comment popover on tablet stays inside visualViewport when keyboard opens.
        const pin = page.getByRole("button", { name: /^Comment by Ana Lima/ }).first();
        await expect(pin).toBeVisible();
        await pin.tap();
        const popover = page.getByRole("dialog", { name: /Thread on Hero banner/ });
        await expect(popover).toBeVisible();
        await setKeyboardViewport(page, { height: 480, offsetTop: 12 });
        await expect
          .poll(async () => {
            const b = await box(popover);
            return b.y >= 11 && b.y + b.height <= 493 && b.x + b.width <= 768;
          })
          .toBe(true);
        await setKeyboardViewport(page, null);
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();

        // Rotate to 768 landscape (1024 x 768): leaves cramped mode, re-fits, no overflow.
        await page.setViewportSize(TABLET_768_LANDSCAPE.viewport);
        await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "tablet");
        await expect(page.locator(".editor")).not.toHaveAttribute("data-compact-tablet", "true");
        await expectNoHorizontalScroll(page, "tablet-768 landscape");
        await expectContentFitsExposedCanvas(page, "tablet-768 landscape");

        // Can open both panes side by side in landscape, and collapse them independently.
        await leftToggle.tap();
        await rightToggle.tap();
        await expect(leftPane).toBeVisible();
        await expect(rightPane).toBeVisible();
        await leftToggle.tap();
        await expect(leftPane).toHaveCount(0);
        await expect(rightPane).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("tablet 1194 landscape iPad (larger file, zoom preservation, title width, owner & viewer) and fine-pointer classification", async ({
      browser,
    }) => {
      test.setTimeout(150_000);
      // 1. 1194 x 834 landscape iPad opening the larger file from scratch as owner.
      const { context, page } = await openDeviceContext(
        browser,
        instance.url,
        TABLET_1194_LANDSCAPE,
        ownerState,
      );
      try {
        await page.goto(largeFilePath);
        await waitForEditorReady(page);
        await expect(page.locator(".editor")).toHaveAttribute("data-workspace", "tablet");
        await expectNoHorizontalScroll(page, "tablet-1194 landscape large");
        await expectContentFitsExposedCanvas(page, "tablet-1194 landscape large");
        // Wide landscape tablet gives the file title room instead of pinching it to 150 px.
        const titleBox = await box(page.locator(".file-title__name"));
        expect(titleBox.width).toBeGreaterThanOrEqual(100);
        await maybeShot(page, "after-tablet-1194-landscape.png");

        // Both panels start open on wide landscape tablet and collapse cleanly.
        const leftPane = page.locator(".pane--left");
        const rightPane = page.locator(".pane--right");
        await expect(leftPane).toBeVisible();
        await expect(rightPane).toBeVisible();

        const leftToggle = page.getByRole("button", { name: /layers panel/i });
        const rightToggle = page.getByRole("button", { name: /inspector panel/i });
        await expectTouchTargetAtLeast44(leftToggle, "ipad-1194 left toggle");
        await expectTouchTargetAtLeast44(rightToggle, "ipad-1194 right toggle");

        await leftToggle.tap();
        await rightToggle.tap();
        await expect(leftPane).toHaveCount(0);
        await expect(rightPane).toHaveCount(0);
        await expectContentFitsExposedCanvas(page, "tablet-1194 both collapsed");

        // User zoom is preserved across width resize (F4).
        await page.evaluate(() => {
          (window as unknown as DebugWindow).drawpane.zoomTo(3.5);
        });
        await page.setViewportSize({ width: 1040, height: 834 });
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as DebugWindow).drawpane.s.viewport.width),
          )
          .toBe(1040);
        const zoomAfterResize = await page.evaluate(
          () => (window as unknown as DebugWindow).drawpane.s.camera.zoom,
        );
        expect(zoomAfterResize).toBeCloseTo(3.5, 2);

        // A resize during text editing never fires a postponed refit when tapping Done (F4).
        const firstTextId = await page.evaluate(() => {
          const e = (window as unknown as DebugWindow).drawpane;
          const findText = (parentId: string): string | null => {
            for (const id of e.doc.childIds(parentId)) {
              const node = e.doc.get(id);
              if (node?.type === "text") return id;
              const nested = findText(id);
              if (nested) return nested;
            }
            return null;
          };
          const tid = findText(e.s.pageId);
          if (tid) {
            e.select([tid]);
            e.startTextEdit(tid);
          }
          return tid;
        });
        expect(firstTextId).toBeTruthy();
        const textBar = page.getByRole("toolbar", { name: "Text editing actions" });
        await expect(textBar).toBeVisible();
        await page.setViewportSize({ width: 1194, height: 834 });
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as DebugWindow).drawpane.s.viewport.width),
          )
          .toBe(1194);
        const camBeforeDone = await page.evaluate(() => {
          const c = (window as unknown as DebugWindow).drawpane.s.camera;
          return { x: c.x, y: c.y, zoom: c.zoom };
        });
        await textBar.getByRole("button", { name: "Done" }).tap();
        await expect(textBar).toBeHidden();
        const camAfterDone = await page.evaluate(() => {
          const c = (window as unknown as DebugWindow).drawpane.s.camera;
          return { x: c.x, y: c.y, zoom: c.zoom };
        });
        expect(camAfterDone).toEqual(camBeforeDone);
      } finally {
        await context.close();
      }

      // 2. Viewer on 1194 landscape iPad lands in tablet mode with View only & Inspect.
      const viewer = await openDeviceContext(
        browser,
        instance.url,
        TABLET_1194_LANDSCAPE,
        viewerState,
      );
      try {
        await viewer.page.goto(smallFilePath);
        await waitForEditorReady(viewer.page);
        await expect(viewer.page.locator(".editor")).toHaveAttribute("data-workspace", "tablet");
        await expect(viewer.page.locator(".file-title").getByText("View only")).toBeVisible();
        await expectNoHorizontalScroll(viewer.page, "tablet-1194 viewer");
      } finally {
        await viewer.context.close();
      }

      // 3. F3: Android phone with stylus/paired mouse (coarse + any-pointer: fine, shortSide < 600)
      // stays in phone mode, while a 768 px iPad with Pencil/trackpad stays in tablet mode.
      const installPointerMedia = async (ctx: BrowserContext) => {
        await ctx.addInitScript(() => {
          try {
            localStorage.setItem("drawpane:debug", "1");
          } catch {
            // Ignore opaque origin.
          }
          const orig = window.matchMedia.bind(window);
          window.matchMedia = ((query: string) => {
            if (query === "(pointer: coarse)" || query === "(any-pointer: fine)") {
              return {
                matches: true,
                media: query,
                onchange: null,
                addEventListener() {},
                removeEventListener() {},
                addListener() {},
                removeListener() {},
                dispatchEvent: () => false,
              } as unknown as MediaQueryList;
            }
            return orig(query);
          }) as typeof window.matchMedia;
        });
      };

      const stylusPhoneCtx = await browser.newContext({
        baseURL: instance.url,
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
        storageState: ownerState,
      });
      await installPointerMedia(stylusPhoneCtx);
      try {
        const stylusPhonePage = await stylusPhoneCtx.newPage();
        await stylusPhonePage.goto(smallFilePath);
        await waitForEditorReady(stylusPhonePage);
        await expect(stylusPhonePage.locator(".editor")).toHaveAttribute("data-workspace", "phone");
        const readOnly = await stylusPhonePage.evaluate(
          () => (window as unknown as DebugWindow).drawpane.s.readOnly,
        );
        expect(readOnly).toBe(true);
      } finally {
        await stylusPhoneCtx.close();
      }

      const pencilIpadCtx = await browser.newContext({
        baseURL: instance.url,
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: true,
        storageState: ownerState,
      });
      await installPointerMedia(pencilIpadCtx);
      try {
        const pencilPage = await pencilIpadCtx.newPage();
        await pencilPage.goto(smallFilePath);
        await waitForEditorReady(pencilPage);
        await expect(pencilPage.locator(".editor")).toHaveAttribute("data-workspace", "tablet");
        const readOnly = await pencilPage.evaluate(
          () => (window as unknown as DebugWindow).drawpane.s.readOnly,
        );
        expect(readOnly).toBe(false);
      } finally {
        await pencilIpadCtx.close();
      }
    });
  });
