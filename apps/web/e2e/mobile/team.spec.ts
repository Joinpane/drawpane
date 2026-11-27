/**
 * Mobile web team routes, account entry and file browsing on phone profiles
 * (360 px phone, Pixel 8, iPhone 15): passkey sign-in, drawer keyboard
 * navigation and dismissal, file search, compact tiles with visible touch
 * overflow menus, rename without double-click, enabled Kit store, New file
 * preset creation, Invite and account settings, and Inbox mention deep links.
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

interface PhoneProfile {
  readonly name: string;
  readonly options: BrowserContextOptions;
}

function deviceOptions(descriptor: (typeof devices)[string]): BrowserContextOptions {
  const { defaultBrowserType: _ignored, ...rest } = descriptor;
  return rest;
}

const PHONE_PROFILES: readonly PhoneProfile[] = [
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
    name: "iPhone 15",
    options: deviceOptions(devices["iPhone 15"]),
  },
];

async function assertNoHorizontalScroll(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function assertTouchTarget(locator: Locator, { minWidth = 44, minHeight = 44 } = {}) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minWidth);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minHeight);
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

async function createPhoneContext(
  browser: Browser,
  baseURL: string,
  profile: PhoneProfile,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
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

      const created = await createPhoneContext(browser, baseURL, PHONE_PROFILES[0] as PhoneProfile);
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
      ownerId = await ownerPage.evaluate(
        async () => (await (await fetch("/api/session")).json()).user.id as string,
      );
    });

    test.afterAll(async () => {
      await ownerContext?.close().catch(() => {});
      await worker?.stop();
      await registry?.stop();
    });

    test("360 px phone: virtual passkey sign-in, drawer keyboard nav and dismissal", async () => {
      const page = ownerPage;
      await page.goto(teamUrl);
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await assertNoHorizontalScroll(page);

      const menuBtn = page.getByRole("button", { name: "Open navigation" });
      await assertTouchTarget(menuBtn);
      const nav = page.locator("#dash-nav");

      // Open drawer, check focus lands on active link, Tab wraps within the modal drawer.
      await menuBtn.tap();
      await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveAttribute(
        "aria-modal",
        "true",
      );
      await expect(nav.getByRole("link", { name: /^Recent/ })).toBeFocused();
      await assertTouchTarget(nav.getByRole("button", { name: "Close navigation" }));
      await assertTouchTarget(nav.getByRole("link", { name: /^Recent/ }));
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

      // Escape dismisses and returns focus to the trigger.
      await page.keyboard.press("Escape");
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
      await expect(menuBtn).toBeFocused();

      // Tapping outside on the scrim dismisses and returns focus to the trigger.
      await menuBtn.tap();
      await expect(nav.getByRole("link", { name: /^Recent/ })).toBeVisible();
      await page.locator(".dash__scrim").tap({ position: { x: 340, y: 200 } });
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
      await expect(menuBtn).toBeFocused();

      // Close button dismisses and returns focus to the trigger.
      await menuBtn.tap();
      await nav.getByRole("button", { name: "Close navigation" }).tap();
      await expect(nav.getByRole("link", { name: /^Recent/ })).not.toBeVisible();
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

    test("360 px phone: compact tiles, visible overflow menu, rename without double-click, search and tile open", async () => {
      const page = ownerPage;
      await page.evaluate(async () => {
        const post = (path: string, body: unknown) =>
          fetch(`/api${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }).then((r) => r.json());
        const { teams } = await (await fetch("/api/teams")).json();
        const team = teams[0].id;
        const { projects } = await (await fetch(`/api/teams/${team}/projects`)).json();
        await post(`/projects/${projects[0].id}/files`, { name: "iOS & iPadOS 27 Community" });
        await post(`/projects/${projects[0].id}/files`, { name: "Landing draft" });
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await assertNoHorizontalScroll(page);

      // Tiles stay compact on phone so the first file does not take most of the viewport.
      const firstCard = page.locator(".dash__card").first();
      const cardBox = await firstCard.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox?.height ?? 999).toBeLessThan(140);

      // Overflow actions are visible without hovering and meet 44 px touch targets.
      const draftCard = page.locator(".dash__card").filter({ hasText: "Landing draft" });
      const actions = draftCard.locator(".dash__card-actions");
      expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      const overflowBtn = draftCard.getByRole("button", { name: "Options for Landing draft" });
      await expect(overflowBtn).toBeVisible();
      await assertTouchTarget(overflowBtn);

      // Rename through the visible overflow menu without double-click.
      await overflowBtn.tap();
      const menu = page.getByRole("menu", { name: "Options for Landing draft" });
      await expect(menu).toBeVisible();
      const renameItem = menu.getByRole("menuitem", { name: "Rename" });
      await assertTouchTarget(renameItem);
      await expect(menu.getByRole("menuitem", { name: "Move to…" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Move to trash" })).toBeVisible();
      await renameItem.tap();

      const renameInput = page.getByRole("textbox", { name: "File name" });
      await expect(renameInput).toBeVisible();
      await renameInput.fill("Mobile Checkout");
      await page.getByRole("button", { name: "Save name" }).tap();
      await expect(
        page.locator(".dash__card").filter({ hasText: "Mobile Checkout" }),
      ).toBeVisible();
      await assertNoHorizontalScroll(page);

      // Search filters team files cleanly on 360 px.
      const search = page.getByRole("searchbox", { name: "Search files" });
      await assertTouchTarget(page.locator(".dash__search"));
      await search.fill("Checkout");
      await expect(page.getByRole("heading", { name: "Results for “Checkout”" })).toBeVisible();
      await expect(page.locator(".dash__card")).toHaveCount(1);
      await assertNoHorizontalScroll(page);
      await search.fill("");
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

      // Tapping a tile opens its editor route.
      const openBtn = page.getByRole("button", { name: "Open Mobile Checkout" });
      await assertTouchTarget(openBtn);
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
      await assertTouchTarget(phonePreset);
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
      const bo = await createPhoneContext(browser, baseURL, PHONE_PROFILES[0] as PhoneProfile);
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
      await expect(topbarInbox).toBeVisible();
      await assertTouchTarget(topbarInbox);
      await topbarInbox.tap();
      await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
      await assertNoHorizontalScroll(page);
      await assertTouchTarget(page.getByRole("button", { name: "Mark all read" }));

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

    for (const profile of PHONE_PROFILES.slice(1)) {
      test(`${profile.name}: virtual passkey sign-in, drawer, visible file menu rename, search and preset`, async ({
        browser,
      }) => {
        // Create an editor invite so this device profile has its own passkey credential.
        const inviteUrl = await ownerPage.evaluate(async () => {
          const { teams } = await (await fetch("/api/teams")).json();
          const response = await fetch(`/api/teams/${teams[0].id}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "editor" }),
          });
          return (await response.json()).url as string;
        });

        const { context, page } = await createPhoneContext(browser, baseURL, profile);
        try {
          const slug = profile.name.toLowerCase().replace(/\s+/g, "-");
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
          await page.evaluate(async (name) => {
            const { teams } = await (await fetch("/api/teams")).json();
            const { projects } = await (await fetch(`/api/teams/${teams[0].id}/projects`)).json();
            await fetch(`/api/projects/${projects[0].id}/files`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name }),
            });
          }, initialName);
          await page.reload();

          const card = page.locator(".dash__card").filter({ hasText: initialName });
          const cardBox = await card.boundingBox();
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
