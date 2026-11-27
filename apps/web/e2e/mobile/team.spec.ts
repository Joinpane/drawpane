/**
 * Mobile and tablet web team routes, account entry and file browsing:
 * - 360 px phone, Pixel 8, iPhone 15 (Chromium with Playwright's iPhone 15
 *   descriptor, defaultBrowserType stripped), and 768 x 1024 touch tablet.
 * - Passkey sign-in, modal drawer keyboard nav, scroll-lock and Escape-with-menu,
 *   file search, compact tiles with visible touch overflow menus, rename-commits-
 *   exactly-once matrix (Enter, Escape, Cancel tap, Save tap, outside blur),
 *   long team/project name overflow checks, enabled Kit store, New file preset
 *   creation, Invite and account settings, and Inbox mention deep links.
 */
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { addPasskey, startWorker, type TestWorker } from "../fresh-instance";
import { type KitRegistry, serveKitRegistry } from "../kit-fixture";

type DebugWindow = {
  drawpane?: {
    s: { status: string; pageId: string };
    doc: {
      nodes(): Iterable<{
        id: string;
        type: string;
        parent: string;
        props: Record<string, unknown>;
      }>;
    };
  };
};

interface DeviceProfile {
  readonly name: string;
  readonly options: BrowserContextOptions;
}

/**
 * Strip `defaultBrowserType` so descriptors like `devices["iPhone 15"]` run in
 * this suite's Chromium project while keeping the device viewport, DPR, touch,
 * and user-agent settings.
 */
function deviceOptions(descriptor: (typeof devices)[string]): BrowserContextOptions {
  const { defaultBrowserType: _ignored, ...rest } = descriptor;
  return rest;
}

const PHONE_PROFILES: readonly DeviceProfile[] = [
  {
    name: "360 px phone",
    options: {
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    name: "Pixel 8",
    options: deviceOptions(devices["Pixel 8"]),
  },
  {
    // Runs in Chromium using Playwright's iPhone 15 device descriptor (not WebKit).
    name: "iPhone 15 (Chromium)",
    options: deviceOptions(devices["iPhone 15"]),
  },
];

const TABLET_PORTRAIT_PROFILE: DeviceProfile = {
  name: "768 px tablet portrait",
  options: {
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

const DESKTOP_PROFILE: DeviceProfile = {
  name: "1280 px desktop",
  options: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

async function assertNoHorizontalScroll(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function assertTouchTarget(
  locator: Locator,
  { minWidth = 44, minHeight = 44, maxHeight = 48 } = {},
) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minWidth);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minHeight);
  expect(box?.height ?? 0).toBeLessThanOrEqual(maxHeight);
}

async function assertInsideViewport(locator: Locator, viewportWidth: number) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewportWidth);
}

async function waitForLiveEditor(page: Page) {
  await page.waitForURL(/\/f\//);
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as DebugWindow).drawpane?.s.status ?? null),
      {
        timeout: 20_000,
      },
    )
    .toBe("live");
}

async function createDeviceContext(
  browser: Browser,
  baseURL: string,
  profile: DeviceProfile,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    reducedMotion: "reduce",
    ...profile.options,
  });
  const page = await context.newPage();
  await addPasskey(context, page);
  return { context, page };
}

test.describe
  .serial("Mobile team routes and file browsing", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let registry: KitRegistry;
    let worker: TestWorker;
    let baseURL: string;
    let ownerContext: BrowserContext;
    let ownerPage: Page;
    let teamUrl: string;
    let teamId: string;
    let defaultProjectId: string;
    let seededFileId: string;
    let seededPageId: string;
    let ownerId: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      registry = await serveKitRegistry();
      const offset = Number(process.env.E2E_PORT_OFFSET || 0);
      worker = await startWorker({
        port: 9061 + offset,
        inspectorPort: 9601 + offset,
        env: { E2E_KIT_REGISTRY: registry.url },
      });
      baseURL = worker.url;

      const created = await createDeviceContext(
        browser,
        baseURL,
        PHONE_PROFILES[0] as DeviceProfile,
      );
      ownerContext = created.context;
      ownerPage = created.page;

      // First-run setup on the 360 px phone profile.
      await ownerPage.goto("/setup");
      await assertNoHorizontalScroll(ownerPage);
      await ownerPage.getByLabel("Your name").fill("Ana Lima");
      await ownerPage.getByLabel("Email").fill("ana@example.com");
      await ownerPage.getByLabel("Setup token").fill("e2e-setup-token");
      const submitBtn = ownerPage.getByRole("button", { name: "Create account with a passkey" });
      await assertTouchTarget(submitBtn);
      await submitBtn.tap();
      await expect(ownerPage.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await ownerPage.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      teamUrl = ownerPage.url();
      const ids = await ownerPage.evaluate(async () => {
        const session = await (await fetch("/api/session")).json();
        const { teams } = await (await fetch("/api/teams")).json();
        const tid = teams[0].id as string;
        const { projects } = await (await fetch(`/api/teams/${tid}/projects`)).json();
        return {
          ownerId: session.user.id as string,
          teamId: tid,
          projectId: projects[0].id as string,
        };
      });
      ownerId = ids.ownerId;
      teamId = ids.teamId;
      defaultProjectId = ids.projectId;
    });

    test.afterAll(async () => {
      await ownerContext?.close().catch(() => {});
      await worker?.stop();
      await registry?.stop();
    });

    test("360 px phone: virtual passkey sign-in, drawer keyboard nav, scroll-lock and dismissal", async () => {
      const page = ownerPage;
      await page.goto(teamUrl);
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await assertNoHorizontalScroll(page);

      const menuBtn = page.getByRole("button", { name: "Open navigation" });
      await assertTouchTarget(menuBtn);
      const nav = page.locator("#dash-nav");

      // Open drawer, check scroll-lock, focus on active link, 44-48 px rows, and Tab wrap.
      await menuBtn.tap();
      await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveAttribute(
        "aria-modal",
        "true",
      );
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      await expect(nav.getByRole("link", { name: /^Recent/ })).toBeFocused();
      await assertTouchTarget(nav.getByRole("button", { name: "Close navigation" }));
      await assertTouchTarget(nav.getByRole("link", { name: /^Recent/ }));
      await assertTouchTarget(nav.getByRole("link", { name: /Ana Lima/ }));
      await assertNoHorizontalScroll(page);

      const focusCount = await nav.evaluate(
        (el) =>
          [
            ...el.querySelectorAll<HTMLElement>(
              'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((n) => n.offsetParent !== null).length,
      );
      expect(focusCount).toBeGreaterThan(5);
      for (let i = 0; i < focusCount + 2; i++) {
        await page.keyboard.press("Tab");
        const inDrawer = await page.evaluate(() => !!document.activeElement?.closest("#dash-nav"));
        expect(inDrawer).toBe(true);
      }
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#dash-nav"))).toBe(true);

      // Escape with an open menu inside the drawer closes only the menu; a second Escape closes the drawer.
      const projectMenuBtn = nav.locator(".dash__project-menu").first();
      await assertTouchTarget(projectMenuBtn);
      await projectMenuBtn.tap();
      const projectMenu = page.locator(".dp-menu").first();
      await expect(projectMenu).toBeVisible();
      await assertTouchTarget(projectMenu.getByRole("menuitem").first());
      await page.keyboard.press("Escape");
      await expect(projectMenu).not.toBeVisible();
      await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveAttribute(
        "aria-modal",
        "true",
      );
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

      await page.keyboard.press("Escape");
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
      await expect(menuBtn).toBeFocused();

      // Tapping outside on the scrim dismisses, unlocks scroll, and returns focus to the trigger.
      await menuBtn.tap();
      await expect(nav.getByRole("link", { name: /^Recent/ })).toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      await page.locator(".dash__scrim").tap({ position: { x: 340, y: 200 } });
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
      await expect(menuBtn).toBeFocused();

      // Close button dismisses and returns focus to the trigger.
      await menuBtn.tap();
      await nav.getByRole("button", { name: "Close navigation" }).tap();
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
      await expect(menuBtn).toBeFocused();

      // Sign out from drawer and sign back in with the virtual passkey.
      await menuBtn.tap();
      const signOutBtn = nav.getByRole("button", { name: "Sign out" });
      await assertTouchTarget(signOutBtn);
      await signOutBtn.tap();
      await expect(page.getByRole("heading", { name: "Sign in to Drawpane" })).toBeVisible();
      await assertNoHorizontalScroll(page);

      const passkeyBtn = page.getByRole("button", { name: "Continue with a passkey" });
      await assertTouchTarget(passkeyBtn);
      await passkeyBtn.tap();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await assertNoHorizontalScroll(page);
    });

    test("360 px phone: compact tiles, visible overflow menu, rename matrix, search and tile open", async () => {
      const page = ownerPage;
      const matrixFileId = await page.evaluate(
        async ({ projectId }) => {
          const post = (path: string, body: unknown) =>
            fetch(`/api${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }).then((r) => r.json());
          await post(`/projects/${projectId}/files`, { name: "iOS & iPadOS 27 Community" });
          const created = await post(`/projects/${projectId}/files`, { name: "Landing draft" });
          return created.file.id as string;
        },
        { projectId: defaultProjectId },
      );
      await page.reload();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await assertNoHorizontalScroll(page);

      // Tiles stay compact on phone so the first file does not take most of the viewport.
      const draftCard = page.locator(".dash__card").filter({ hasText: "Landing draft" });
      await expect(draftCard).toBeVisible();
      const firstCard = page.locator(".dash__card:not(.dash__card--skeleton)").first();
      await expect(firstCard).toBeVisible();
      const cardBox = await firstCard.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox?.height ?? 999).toBeLessThan(140);

      // Overflow actions are visible without hovering and meet 44-48 px touch targets.
      const actions = draftCard.locator(".dash__card-actions");
      expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      const overflowBtn = draftCard.getByRole("button", { name: "Options for Landing draft" });
      await assertTouchTarget(overflowBtn);

      // Rename-commits-exactly-once matrix: count PATCH /api/files/:id across all 5 paths.
      let patchCount = 0;
      const onRequest = (req: { method(): string; url(): string }) => {
        if (req.method() === "PATCH" && req.url().endsWith(`/api/files/${matrixFileId}`)) {
          patchCount += 1;
        }
      };
      page.on("request", onRequest);
      try {
        const startRename = async (currentName: string) => {
          const card = page.locator(".dash__card").filter({ hasText: currentName });
          const trigger = card.getByRole("button", { name: `Options for ${currentName}` });
          await assertTouchTarget(trigger);
          await trigger.tap();
          const menu = page.getByRole("menu", { name: `Options for ${currentName}` });
          await expect(menu).toBeVisible();
          const renameItem = menu.getByRole("menuitem", { name: "Rename" });
          await assertTouchTarget(renameItem);
          await assertTouchTarget(menu.getByRole("menuitem", { name: "Move to…" }));
          await assertTouchTarget(menu.getByRole("menuitem", { name: "Move to trash" }));
          await renameItem.tap();
          const input = page.getByRole("textbox", { name: "File name" });
          await expect(input).toBeVisible();
          await expect(trigger).not.toBeVisible();
          await assertTouchTarget(page.getByRole("button", { name: "Save name" }));
          await assertTouchTarget(page.getByRole("button", { name: "Cancel rename" }));
          return input;
        };

        // 1. Escape cancels without patching.
        patchCount = 0;
        let renameInput = await startRename("Landing draft");
        await renameInput.fill("Discarded via Escape");
        await renameInput.press("Escape");
        await expect(renameInput).not.toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(0);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Landing draft" }),
        ).toBeVisible();

        // 2. Cancel tap cancels without patching (even if blur runs before click).
        patchCount = 0;
        renameInput = await startRename("Landing draft");
        await renameInput.fill("Discarded via Cancel");
        await page.getByRole("button", { name: "Cancel rename" }).tap();
        await expect(renameInput).not.toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(0);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Landing draft" }),
        ).toBeVisible();

        // 3. Enter commits once.
        patchCount = 0;
        renameInput = await startRename("Landing draft");
        await renameInput.fill("Rename via Enter");
        const enterPatch = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" && res.url().endsWith(`/api/files/${matrixFileId}`),
        );
        await renameInput.press("Enter");
        expect((await enterPatch).status()).toBe(200);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Rename via Enter" }),
        ).toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(1);

        // 4. Tapping outside (blur) commits once.
        patchCount = 0;
        renameInput = await startRename("Rename via Enter");
        await renameInput.fill("Rename via Blur");
        const blurPatch = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" && res.url().endsWith(`/api/files/${matrixFileId}`),
        );
        await page.getByRole("searchbox", { name: "Search files" }).tap();
        expect((await blurPatch).status()).toBe(200);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Rename via Blur" }),
        ).toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(1);

        // 5. Mouse press on Cancel, slide off, release, then click Save commits once.
        patchCount = 0;
        renameInput = await startRename("Rename via Blur");
        await renameInput.fill("Slide Off Save");
        const cancelBtn = page.getByRole("button", { name: "Cancel rename" });
        const cancelBox = await cancelBtn.boundingBox();
        expect(cancelBox).not.toBeNull();
        if (cancelBox) {
          await page.mouse.move(
            cancelBox.x + cancelBox.width / 2,
            cancelBox.y + cancelBox.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(10, 10);
          await page.mouse.up();
        }
        await expect(renameInput).toBeVisible();
        expect(patchCount).toBe(0);
        const slideSavePatch = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" && res.url().endsWith(`/api/files/${matrixFileId}`),
        );
        await page.getByRole("button", { name: "Save name" }).click();
        expect((await slideSavePatch).status()).toBe(200);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Slide Off Save" }),
        ).toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(1);

        // 6. Mouse press on Cancel, slide off, release, then click outside (blur) commits once.
        patchCount = 0;
        renameInput = await startRename("Slide Off Save");
        await renameInput.fill("Slide Off Blur");
        const cancelBox2 = await page.getByRole("button", { name: "Cancel rename" }).boundingBox();
        expect(cancelBox2).not.toBeNull();
        if (cancelBox2) {
          await page.mouse.move(
            cancelBox2.x + cancelBox2.width / 2,
            cancelBox2.y + cancelBox2.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(10, 10);
          await page.mouse.up();
        }
        await expect(renameInput).toBeVisible();
        expect(patchCount).toBe(0);
        const slideBlurPatch = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" && res.url().endsWith(`/api/files/${matrixFileId}`),
        );
        await page.getByRole("searchbox", { name: "Search files" }).click();
        expect((await slideBlurPatch).status()).toBe(200);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Slide Off Blur" }),
        ).toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(1);

        // 7. Save tap commits once.
        patchCount = 0;
        renameInput = await startRename("Slide Off Blur");
        await renameInput.fill("Mobile Checkout");
        const savePatch = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" && res.url().endsWith(`/api/files/${matrixFileId}`),
        );
        await page.getByRole("button", { name: "Save name" }).tap();
        expect((await savePatch).status()).toBe(200);
        await expect(
          page.locator(".dash__card").filter({ hasText: "Mobile Checkout" }),
        ).toBeVisible();
        await page.waitForTimeout(150);
        expect(patchCount).toBe(1);
      } finally {
        page.off("request", onRequest);
      }
      await assertNoHorizontalScroll(page);

      // Search filters team files cleanly on 360 px.
      const search = page.getByRole("searchbox", { name: "Search files" });
      await assertTouchTarget(page.locator(".dash__search"));
      await expect(page.locator(".dash__search kbd")).not.toBeVisible();
      await search.fill("Checkout");
      await expect(page.getByRole("heading", { name: "Results for “Checkout”" })).toBeVisible();
      await expect(page.locator(".dash__card")).toHaveCount(1);
      await assertNoHorizontalScroll(page);
      await search.fill("");
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

      // Tapping a tile opens its editor route.
      const openBtn = page.getByRole("button", { name: "Open Mobile Checkout" });
      await assertTouchTarget(openBtn, { maxHeight: 80 });
      await openBtn.tap();
      await waitForLiveEditor(page);
      seededFileId = new URL(page.url()).pathname.split("/").at(-1) as string;
      seededPageId = await page.evaluate(
        () => (window as unknown as DebugWindow).drawpane?.s.pageId ?? "",
      );
      expect(seededPageId).not.toBe("");
      await page.goto(teamUrl);
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
    });

    test("360 px phone: kit store, new file preset, invite dialog, account pages and inbox mention", async ({
      browser,
    }) => {
      const page = ownerPage;
      const menuBtn = page.getByRole("button", { name: "Open navigation" });
      const nav = page.locator("#dash-nav");

      // Enabled Kit store: filter, open details, add fixture kit.
      await menuBtn.tap();
      await nav.getByRole("link", { name: "Kit store" }).tap();
      await expect(page.getByRole("heading", { name: "Kit store", level: 1 })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await assertTouchTarget(page.getByRole("button", { name: /^All/ }));

      const kitCard = page
        .getByRole("list", { name: "Kits" })
        .getByRole("listitem")
        .filter({ hasText: "Showcase Kit" });
      await kitCard.getByRole("button").tap();
      const kitDialog = page.getByRole("dialog", { name: "Showcase Kit" });
      await expect(kitDialog).toBeVisible();
      const addKitBtn = kitDialog.getByRole("button", { name: "Add to team" });
      await assertTouchTarget(addKitBtn);
      await addKitBtn.tap();
      await expect(kitDialog).toContainText("Added to your team's Kits project", {
        timeout: 30_000,
      });
      await assertNoHorizontalScroll(page);
      await kitDialog.getByRole("button", { name: "Done" }).tap();
      await expect(kitCard.getByText("Added")).toBeVisible();

      // New file page: create a file from the Phone preset.
      await menuBtn.tap();
      await nav.getByRole("link", { name: /^Recent/ }).tap();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      const templatesBtn = page.getByRole("button", { name: "Templates" });
      await assertTouchTarget(templatesBtn);
      await templatesBtn.tap();
      await expect(page.getByRole("heading", { name: "Start with a blank pane" })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await assertTouchTarget(page.getByRole("button", { name: "Close" }));

      const phonePreset = page.getByRole("button", { name: /^Phone/ });
      await assertTouchTarget(phonePreset, { maxHeight: 200 });
      await phonePreset.tap();
      await waitForLiveEditor(page);
      const frame = await page.evaluate(() => {
        const dp = (window as unknown as DebugWindow).drawpane;
        return dp ? [...dp.doc.nodes()].find((n) => n.type === "frame") : undefined;
      });
      expect(frame?.props).toMatchObject({ name: "iPhone 18 Pro", width: 402, height: 874 });

      // Invite dialog at 360 px and invite acceptance on a second 360 px phone.
      await page.goto(teamUrl);
      const inviteBtn = page.getByRole("button", { name: "Invite" });
      await assertTouchTarget(inviteBtn);
      await inviteBtn.tap();
      const inviteDialog = page.getByRole("dialog", { name: "Invite to this team" });
      await expect(inviteDialog).toBeVisible();
      await assertTouchTarget(inviteDialog.locator(".app-radio").filter({ hasText: "Editor" }));
      await inviteDialog.getByRole("radio", { name: "Editor" }).check();
      await inviteDialog.getByRole("button", { name: "Create link" }).tap();
      const inviteUrl = (await inviteDialog.locator(".app-copy code").textContent()) as string;
      await inviteDialog.getByRole("button", { name: "Done" }).tap();

      // Account settings pages stay usable at 360 px without horizontal scroll.
      await menuBtn.tap();
      const accountLink = nav.getByRole("link", { name: /Ana Lima/ });
      await assertTouchTarget(accountLink);
      await accountLink.tap();
      await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await assertTouchTarget(page.getByRole("link", { name: "Files" }));
      await assertTouchTarget(page.getByRole("link", { name: "Keyboard shortcuts" }));
      await page.getByRole("link", { name: "Keyboard shortcuts" }).tap();
      await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await page.getByRole("link", { name: "Access tokens" }).tap();
      await expect(page.getByRole("heading", { name: "Access tokens" })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await page.getByRole("link", { name: "Files" }).tap();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

      // Second member joins on 360 px phone and seeds an unread comment mention for Ana.
      const bo = await createDeviceContext(browser, baseURL, PHONE_PROFILES[0] as DeviceProfile);
      try {
        await bo.page.goto(new URL(inviteUrl).pathname);
        await expect(bo.page.getByRole("heading", { name: /Join Ana's team/ })).toBeVisible();
        await assertNoHorizontalScroll(bo.page);
        await bo.page.getByLabel("Your name").fill("Bo Chen");
        await bo.page.getByLabel("Email").fill("bo@example.com");
        await bo.page.getByRole("button", { name: "Create account with a passkey" }).tap();
        await expect(bo.page.getByRole("heading", { name: "Recent files" })).toBeVisible();

        const resStatus = await bo.page.evaluate(
          async ({ fileId, pageId, ownerId }) => {
            const response = await fetch(`/api/files/${fileId}/comments`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                pageId,
                x: 160,
                y: 120,
                body: "@Ana Lima please check mobile spacing",
                mentions: [ownerId],
              }),
            });
            return response.status;
          },
          { fileId: seededFileId, pageId: seededPageId, ownerId },
        );
        expect(resStatus).toBe(201);
      } finally {
        await bo.context.close();
      }

      // Ana opens Inbox from the topbar unread badge, taps the mention, lands on thread route and marks it read.
      await page.reload();
      const topbarInbox = page.locator(".dash__topbar-inbox");
      await assertTouchTarget(topbarInbox);
      await topbarInbox.tap();
      await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await assertTouchTarget(page.getByRole("button", { name: "Mark all read" }));
      await assertTouchTarget(page.locator(".inbox__bar .dp-seg__option").first());

      const mention = page
        .getByRole("region", { name: "Notifications" })
        .getByRole("link", { name: /Bo Chen mentioned you in Mobile Checkout/ });
      await expect(mention).toContainText("please check mobile spacing");
      await expect(mention).toContainText("Unread");
      await mention.tap();

      await expect(page).toHaveURL(new RegExp(`/f/${seededFileId}\\?page-id=${seededPageId}$`), {
        timeout: 15_000,
      });
      await expect(page.getByRole("dialog", { name: /^Thread on/ })).toBeVisible({
        timeout: 15_000,
      });

      // Verify the notification was marked read.
      await expect
        .poll(() =>
          page.evaluate(
            async () => (await (await fetch("/api/notifications/unread")).json()).unread as number,
          ),
        )
        .toBe(0);
      await page.goto(`${teamUrl}?view=inbox`);
      await expect(page.getByText("You're all caught up.")).toBeVisible();
    });

    test("768 px tablet portrait and long team/project names across phone, tablet and desktop", async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const longTeamName = "Northwind Product Design and Research Collective Studio";
      const longProjectName = "Customer onboarding and lifecycle marketing experiments Q4 2026";

      // Create a long-named project and capture original team name.
      const { originalTeamName, longProjectId, inviteUrl } = await ownerPage.evaluate(
        async ({ tid, projectName }) => {
          const { teams } = await (await fetch("/api/teams")).json();
          const currentTeam = teams.find((t: { id: string }) => t.id === tid);
          const createdProject = await fetch(`/api/teams/${tid}/projects`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: projectName }),
          }).then((r) => r.json());
          const invite = await fetch(`/api/teams/${tid}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "editor" }),
          }).then((r) => r.json());
          return {
            originalTeamName: currentTeam.name as string,
            longProjectId: createdProject.project.id as string,
            inviteUrl: invite.url as string,
          };
        },
        { tid: teamId, projectName: longProjectName },
      );

      // Long team name on 360 px phone stays inside viewport without horizontal scroll.
      await ownerPage.evaluate(
        async ({ tid, name }) => {
          const res = await fetch(`/api/teams/${tid}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) throw new Error(`Failed to rename team: ${res.status}`);
        },
        { tid: teamId, name: longTeamName },
      );
      try {
        await ownerPage.goto(teamUrl);
        await expect(ownerPage.locator(".dash__topbar-team")).toHaveText(longTeamName);
        await assertNoHorizontalScroll(ownerPage);
        await assertInsideViewport(ownerPage.locator(".dash__topbar-team"), 360);

        // Long project name on 360 px phone stays inside viewport.
        await ownerPage.goto(`${teamUrl}?project=${longProjectId}`);
        await expect(ownerPage.getByRole("heading", { name: longProjectName })).toBeVisible();
        await assertNoHorizontalScroll(ownerPage);
      } finally {
        await ownerPage.evaluate(
          async ({ tid, name }) => {
            await fetch(`/api/teams/${tid}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name }),
            });
          },
          { tid: teamId, name: originalTeamName },
        );
      }

      // Tablet portrait (768 x 1024, touch): header fits, kbd hidden, 44 px targets, overflow hides on rename.
      const tablet = await createDeviceContext(browser, baseURL, TABLET_PORTRAIT_PROFILE);
      try {
        await tablet.page.goto(new URL(inviteUrl).pathname);
        await tablet.page.getByLabel("Your name").fill("Tablet Tester");
        await tablet.page.getByLabel("Email").fill("tablet@example.com");
        await tablet.page.getByRole("button", { name: "Create account with a passkey" }).tap();
        await expect(tablet.page.getByRole("heading", { name: "Recent files" })).toBeVisible();

        await assertNoHorizontalScroll(tablet.page);
        const tabletHeaderNewFile = tablet.page
          .locator(".dash__header")
          .getByRole("button", { name: "New file" });
        await assertInsideViewport(tabletHeaderNewFile, 768);
        await assertTouchTarget(tabletHeaderNewFile);
        await assertTouchTarget(tablet.page.locator(".dash__search"));
        await expect(tablet.page.locator(".dash__search kbd")).not.toBeVisible();
        await assertTouchTarget(tablet.page.getByRole("button", { name: "Sign out" }));

        const tabletCard = tablet.page
          .locator(".dash__card")
          .filter({ hasText: "Mobile Checkout" });
        await expect(tabletCard).toBeVisible();
        expect(
          await tabletCard
            .locator(".dash__card-actions")
            .evaluate((el) => getComputedStyle(el).opacity),
        ).toBe("1");
        const tabletOverflow = tabletCard.getByRole("button", {
          name: "Options for Mobile Checkout",
        });
        await assertTouchTarget(tabletOverflow);
        await tabletOverflow.tap();
        await assertTouchTarget(tablet.page.getByRole("menuitem", { name: "Rename" }));
        await tablet.page.getByRole("menuitem", { name: "Rename" }).tap();
        await expect(tabletOverflow).not.toBeVisible();
        await assertTouchTarget(tablet.page.getByRole("button", { name: "Save name" }));
        await assertTouchTarget(tablet.page.getByRole("button", { name: "Cancel rename" }));
        await tablet.page.getByRole("button", { name: "Cancel rename" }).tap();
        await expect(tabletOverflow).toBeVisible();

        // Long project name on 768 px tablet portrait stays inside viewport.
        await tablet.page.goto(`${teamUrl}?project=${longProjectId}`);
        await expect(tablet.page.getByRole("heading", { name: longProjectName })).toBeVisible();
        await assertNoHorizontalScroll(tablet.page);
        await assertInsideViewport(tabletHeaderNewFile, 768);

        // Long project name on 1280 px desktop stays inside viewport.
        const desktopInvite = await ownerPage.evaluate(async (tid) => {
          const res = await fetch(`/api/teams/${tid}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "editor" }),
          });
          return (await res.json()).url as string;
        }, teamId);
        const desktop = await createDeviceContext(browser, baseURL, DESKTOP_PROFILE);
        try {
          await desktop.page.goto(new URL(desktopInvite).pathname);
          await desktop.page.getByLabel("Your name").fill("Desktop Tester");
          await desktop.page.getByLabel("Email").fill("desktop@example.com");
          await desktop.page.getByRole("button", { name: "Create account with a passkey" }).click();
          await expect(desktop.page.getByRole("heading", { name: "Recent files" })).toBeVisible();

          await desktop.page.goto(`${teamUrl}?project=${longProjectId}`);
          await expect(desktop.page.getByRole("heading", { name: longProjectName })).toBeVisible();
          await assertNoHorizontalScroll(desktop.page);
          await assertInsideViewport(
            desktop.page.locator(".dash__header").getByRole("button", { name: "New file" }),
            1280,
          );

          // Sweep 700-1440 px in 10 px steps: Recents and medium project name never truncate or overflow;
          // very long project name may truncate but never overflows sideways.
          const mediumProjectName = "Mobile app redesign";
          const mediumProjectId = await ownerPage.evaluate(
            async ({ tid, name }) => {
              const res = await fetch(`/api/teams/${tid}/projects`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name }),
              });
              const data = await res.json();
              return (data.id ?? data.project?.id) as string;
            },
            { tid: teamId, name: mediumProjectName },
          );
          const sweepRoutes: ReadonlyArray<{
            label: string;
            url: string;
            heading: string;
            allowTruncate: boolean;
          }> = [
            { label: "Recents", url: teamUrl, heading: "Recent files", allowTruncate: false },
            {
              label: "Medium project",
              url: `${teamUrl}?project=${mediumProjectId}`,
              heading: mediumProjectName,
              allowTruncate: false,
            },
            {
              label: "Long project",
              url: `${teamUrl}?project=${longProjectId}`,
              heading: longProjectName,
              allowTruncate: true,
            },
          ];
          for (const route of sweepRoutes) {
            await desktop.page.goto(route.url);
            await expect(desktop.page.getByRole("heading", { name: route.heading })).toBeVisible();
            for (let w = 700; w <= 1440; w += 10) {
              await desktop.page.setViewportSize({ width: w, height: 900 });
              const metrics = await desktop.page.evaluate(
                () =>
                  new Promise<{
                    titleScrollWidth: number;
                    titleClientWidth: number;
                    docScrollWidth: number;
                    docClientWidth: number;
                  }>((resolve) =>
                    requestAnimationFrame(() => {
                      const title = document.querySelector<HTMLElement>(".dash__title");
                      resolve({
                        titleScrollWidth: title?.scrollWidth ?? 0,
                        titleClientWidth: title?.clientWidth ?? 0,
                        docScrollWidth: document.documentElement.scrollWidth,
                        docClientWidth: document.documentElement.clientWidth,
                      });
                    }),
                  ),
              );
              expect(
                metrics.docScrollWidth,
                `${route.label} horizontal overflow at ${w}px`,
              ).toBeLessThanOrEqual(metrics.docClientWidth);
              if (!route.allowTruncate) {
                expect(
                  metrics.titleScrollWidth,
                  `${route.label} title truncated at ${w}px`,
                ).toBeLessThanOrEqual(metrics.titleClientWidth);
              }
            }
          }
        } finally {
          await desktop.context.close();
        }
      } finally {
        await tablet.context.close();
      }
    });

    for (const profile of PHONE_PROFILES.slice(1)) {
      test(`${profile.name}: virtual passkey sign-in, drawer, visible file menu rename, search and preset`, async ({
        browser,
      }) => {
        // Create an editor invite so this device profile has its own passkey credential.
        const inviteUrl = await ownerPage.evaluate(async (tid) => {
          const response = await fetch(`/api/teams/${tid}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "editor" }),
          });
          return (await response.json()).url as string;
        }, teamId);

        const { context, page } = await createDeviceContext(browser, baseURL, profile);
        try {
          const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          await page.goto(new URL(inviteUrl).pathname);
          await assertNoHorizontalScroll(page);
          await page.getByLabel("Your name").fill(`User ${profile.name}`);
          await page.getByLabel("Email").fill(`${slug}@example.com`);
          await page.getByRole("button", { name: "Create account with a passkey" }).tap();
          await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
          await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
          await assertNoHorizontalScroll(page);

          // Sign out and sign back in with the virtual passkey on this phone profile.
          const menuBtn = page.getByRole("button", { name: "Open navigation" });
          const nav = page.locator("#dash-nav");
          await menuBtn.tap();
          await nav.getByRole("button", { name: "Sign out" }).tap();
          await expect(page.getByRole("heading", { name: "Sign in to Drawpane" })).toBeVisible();
          await page.getByRole("button", { name: "Continue with a passkey" }).tap();
          await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
          await assertNoHorizontalScroll(page);

          // Drawer Escape dismissal returns focus to Open navigation.
          await menuBtn.tap();
          await expect(nav.getByRole("link", { name: /^Recent/ })).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(menuBtn).toBeFocused();

          // Create a file for this profile, verify compact tile + visible overflow menu + rename.
          const initialName = `Draft ${profile.name}`;
          const renamed = `Renamed ${profile.name}`;
          await page.evaluate(
            async ({ projectId, name }) => {
              await fetch(`/api/projects/${projectId}/files`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name }),
              });
            },
            { projectId: defaultProjectId, name: initialName },
          );
          await page.reload();

          const card = page.locator(".dash__card").filter({ hasText: initialName });
          await expect(card).toBeVisible();
          const cardBox = await card.boundingBox();
          expect(cardBox).not.toBeNull();
          expect(cardBox?.height ?? 999).toBeLessThan(140);
          expect(
            await card
              .locator(".dash__card-actions")
              .evaluate((el) => getComputedStyle(el).opacity),
          ).toBe("1");

          const overflow = card.getByRole("button", { name: `Options for ${initialName}` });
          await assertTouchTarget(overflow);
          await overflow.tap();
          await page.getByRole("menuitem", { name: "Rename" }).tap();
          const input = page.getByRole("textbox", { name: "File name" });
          await input.fill(renamed);
          await input.press("Enter");
          await expect(page.locator(".dash__card").filter({ hasText: renamed })).toBeVisible();

          // Search finds the renamed file.
          const search = page.getByRole("searchbox", { name: "Search files" });
          await search.fill(renamed);
          await expect(page.locator(".dash__card")).toHaveCount(1);
          await assertNoHorizontalScroll(page);
          await search.fill("");

          // Kit store and New file stay within viewport on this phone profile.
          await menuBtn.tap();
          await nav.getByRole("link", { name: "Kit store" }).tap();
          await expect(page.getByRole("heading", { name: "Kit store", level: 1 })).toBeVisible();
          await assertNoHorizontalScroll(page);

          await menuBtn.tap();
          await nav.getByRole("link", { name: /^Recent/ }).tap();
          await page.getByRole("button", { name: "Templates" }).tap();
          await expect(
            page.getByRole("heading", { name: "Start with a blank pane" }),
          ).toBeVisible();
          await assertNoHorizontalScroll(page);
          await page.getByRole("button", { name: /^Phone/ }).tap();
          await waitForLiveEditor(page);
        } finally {
          await context.close();
        }
      });
    }
  });
