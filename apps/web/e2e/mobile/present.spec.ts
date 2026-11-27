import { createServer } from "node:net";
import {
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { buildMobileApp } from "../prototype-fixture";

const profiles = [
  {
    name: "360 px phone",
    options: { ...devices["Pixel 8"], viewport: { width: 360, height: 800 }, deviceScaleFactor: 3 },
  },
  {
    name: "393 × 660 short phone",
    options: { ...devices["iPhone 15"], viewport: { width: 393, height: 660 } },
  },
  { name: "412 px phone", options: devices["Pixel 8"] },
  { name: "430 px phone", options: devices["iPhone 15 Pro Max"] },
  {
    name: "800 × 360 landscape phone",
    options: { ...devices["Pixel 8"], viewport: { width: 800, height: 360 }, deviceScaleFactor: 3 },
  },
  {
    name: "768 px tablet",
    options: { ...devices["iPad Pro 11"], viewport: { width: 768, height: 1024 } },
  },
  { name: "834 px tablet", options: devices["iPad Pro 11"] },
];
const longFile = "PrototypeReviewWithAnUnbrokenFileNameForCompactToolbars".repeat(2);
const longFlow = "EventDetailAlternativeFlowWithAnUnbrokenLabelForSmallScreens";
const longScreen = `Event detail ${"WithAnUnbrokenScreenName".repeat(4)}`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No ephemeral test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function fits(page: Page, ...targets: Locator[]) {
  const viewport = await page.evaluate(() => {
    const v = window.visualViewport;
    return {
      left: v?.offsetLeft ?? 0,
      top: v?.offsetTop ?? 0,
      width: v?.width ?? innerWidth,
      height: v?.height ?? innerHeight,
    };
  });
  const bar = page.locator(".present__bar");
  const { scrollWidth, clientWidth } = await bar.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  for (const target of [bar, ...targets]) {
    await expect(target).toBeVisible();
    const rect = await target.boundingBox();
    if (!rect) throw new Error(`Missing bounds for ${target}`);
    expect(rect.x, String(target)).toBeGreaterThanOrEqual(viewport.left - 1);
    expect(rect.y, String(target)).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(rect.x + rect.width, String(target)).toBeLessThanOrEqual(
      viewport.left + viewport.width + 1,
    );
    expect(rect.y + rect.height, String(target)).toBeLessThanOrEqual(
      viewport.top + viewport.height + 1,
    );
  }
}

/** The fixture uses the 393 × 852 iPhone 16 preset. */
async function fitsWholePreset(stage: Locator, viewport: Locator) {
  await expect
    .poll(async () => {
      const box = await stage.boundingBox();
      const device = await viewport.boundingBox();
      if (!box || !device) throw new Error("Missing prototype viewport");
      const fittedHeight = Math.min(box.height, (box.width * 852) / 393);
      return Math.abs(device.height - fittedHeight);
    })
    .toBeLessThan(1);
}

test.describe("Prototype playback on touch screens", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  test.skip(
    ({ browserName }) => browserName === "firefox",
    "Firefox cannot emulate mobile devices.",
  );

  let instance: Instance;
  let owner: Awaited<ReturnType<BrowserContext["storageState"]>>;
  let presentUrl: string;
  let publicUrl: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const [port, inspectorPort] = await Promise.all([freePort(), freePort()]);
    instance = await freshInstance(browser, { port, inspectorPort });
    const { page } = instance;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await page.getByRole("button", { name: "New file" }).first().click();
    const saved = page.getByRole("status").filter({ hasText: "Saved" });
    await expect(saved).toBeVisible({ timeout: 15_000 });
    const app = await buildMobileApp(page);
    const committed = await page.evaluate(
      ({ app, longFlow, longScreen }) => {
        const editor = (
          window as unknown as {
            drawpane: {
              s: { pageId: string };
              commit(ops: unknown[], label: string): boolean;
            };
          }
        ).drawpane;
        return editor.commit(
          [
            { op: "set", id: app.detail, prop: "name", value: longScreen },
            {
              op: "set",
              id: editor.s.pageId,
              prop: "flows",
              value: [
                { id: "flowToday", name: "Today", start: app.home, description: "" },
                { id: "flowDetail", name: longFlow, start: app.detail, description: "" },
              ],
            },
          ],
          "Add a second flow",
        );
      },
      { app, longFlow, longScreen },
    );
    expect(committed).toBe(true);
    await expect(saved).toBeVisible();
    const filePath = new URL(page.url()).pathname;
    const apiPath = filePath.replace(/^\/f\//, "/api/files/");
    const headers = { Origin: instance.url };
    await expect(
      await page.request.patch(apiPath, {
        data: { name: longFile },
        headers,
      }),
    ).toBeOK();
    const share = await page.request.post(`${apiPath}/share`, {
      data: {},
      headers,
    });
    await expect(share).toBeOK();
    const { link } = (await share.json()) as { link: { url: string } };
    presentUrl = `${filePath}/present`;
    publicUrl = link.url;
    owner = await instance.context.storageState();
  });

  test.afterAll(async () => {
    await instance?.stop();
  });

  for (const { name, options } of profiles) {
    for (const signedIn of [true, false]) {
      test(`${name} fits and plays ${signedIn ? "signed in" : "signed out"}`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          ...options,
          baseURL: instance.url,
          ignoreHTTPSErrors: true,
          reducedMotion: "reduce",
          ...(signedIn ? { storageState: owner } : {}),
        });
        try {
          const page = await context.newPage();
          await page.goto(signedIn ? presentUrl : publicUrl);
          const stage = page.locator(".present__stage");
          const viewport = stage.locator(".stage__viewport");
          const artwork = viewport.locator(".stage__screen canvas");
          const count = page.locator(".present__count");
          const flow = page.getByLabel("Flow");
          const back = page.getByRole("link", { name: "Back to editor" });
          const show = page.getByRole("button", { name: "Show screens" });
          const more = page.getByRole("button", { name: "More actions" });
          const restart = page.getByRole("button", { name: "Restart" });
          const share = page.getByRole("button", { name: "Share prototype" });
          const { width, height } = options.viewport;
          const compact = width <= 720 || height <= 520;
          const controls = signedIn ? [back, ...(compact ? [more] : [share, restart])] : [restart];
          await expect(count).toHaveText("Screen 1 of 3");
          await fits(page, stage, viewport, artwork, flow, show, ...controls);
          if (compact) await fitsWholePreset(stage, viewport);
          if (width === 768) await expect(count).toHaveCSS("clip-path", "inset(50%)");

          if (signedIn) {
            const entry = compact ? page.getByRole("menuitem", { name: "Share prototype" }) : share;
            if (compact) await more.tap();
            await fits(page, entry);
            await entry.tap();
            const dialog = page.getByRole("dialog", { name: /^Share/ });
            const done = dialog.getByRole("button", { name: "Done" });
            await expect(
              dialog.getByText("Anyone with the link can play the prototype."),
            ).toBeVisible();
            await done.scrollIntoViewIfNeeded();
            await fits(page, dialog, done);
            await done.tap();
            await expect(dialog).toBeHidden();
            if (compact) await expect(more).toBeFocused();
          } else {
            await expect(back).toHaveCount(0);
            await expect(share).toHaveCount(0);
            await expect(page.locator(".present__file")).toHaveText(longFile);
          }

          const tapStage = async (x: number, y: number) => {
            const box = await viewport.boundingBox();
            if (!box) throw new Error("No prototype viewport");
            await page.touchscreen.tap(box.x + box.width * x, box.y + box.height * y);
          };
          if (compact && signedIn) {
            await more.tap();
            await tapStage(0.25, 0.2);
            await expect(page.getByRole("menu", { name: "More actions" })).toBeHidden();
            await expect(count).toHaveText("Screen 1 of 3");
          }
          await tapStage(0.5, 0.3);
          await expect(count).toHaveText("Screen 2 of 3");
          await tapStage(0.5, 0.9);
          await expect(viewport.locator(".stage__overlay")).toHaveCount(1);
          await expect(viewport.locator(".stage__dim")).toHaveCount(1);
          await tapStage(0.5, 0.15);
          await expect(viewport.locator(".stage__overlay")).toHaveCount(0);

          if (compact) {
            const picker = page.getByRole("dialog", { name: "Screens" });
            const close = picker.getByRole("button", { name: "Close" });
            await show.tap();
            await fits(page, picker, close);
            await expect(
              picker.getByRole("button", { name: new RegExp(longScreen) }),
            ).toBeFocused();
            await expect(picker.getByRole("complementary")).toHaveCount(0);
            await page.evaluate(() => (document.activeElement as HTMLElement).blur());
            await expect(page.locator("body")).toBeFocused();
            await page.keyboard.press("ArrowRight");
            await expect(count).toHaveText("Screen 2 of 3");
            await page.keyboard.press("Escape");
            await expect(picker).toBeHidden();
            await expect(show).toBeFocused();
            if (signedIn && width === 360) {
              await show.tap();
              await page.setViewportSize({ width: 1280, height: 800 });
              await expect(picker).toBeHidden();
              await expect(show).toBeFocused();
              await page.setViewportSize(options.viewport);
              await expect(count).toHaveText("Screen 2 of 3");
            }
            await expect(count).toHaveText("Screen 2 of 3");
            await show.tap();
            await page.touchscreen.tap(4, 4);
            await expect(picker).toBeHidden();
            await expect(show).toBeFocused();
          }

          await flow.selectOption({ label: longFlow });
          await expect(flow).toHaveValue("flowDetail");
          await fits(page, stage, viewport, flow, show, ...controls);
          await show.tap();
          const screens = page.getByRole(compact ? "dialog" : "complementary", { name: "Screens" });
          await expect(
            screens.getByRole("button", { name: new RegExp(longScreen) }),
          ).toHaveAttribute("aria-current", "true");
          await screens.getByRole("button", { name: /^Done sheet/ }).tap();
          if (!compact) await page.getByRole("button", { name: "Hide screens" }).tap();
          await expect(screens).toBeHidden();
          await expect(count).toHaveText("Screen 2 of 2");

          await page.setViewportSize({ width: height, height: width });
          await fits(page, stage, viewport, flow, show, ...controls);
          if (compact) await fitsWholePreset(stage, viewport);
          await expect(count).toHaveText("Screen 2 of 2");
          await expect(flow).toHaveValue("flowDetail");

          if (signedIn && compact) {
            await more.tap();
            const item = page.getByRole("menuitem", { name: "Restart" });
            await fits(page, item);
            await item.tap();
            await expect(more).toBeFocused();
          } else {
            await restart.tap();
          }
          await expect(count).toHaveText("Screen 1 of 2");
          await flow.selectOption("flowToday");
          await expect(count).toHaveText("Screen 1 of 3");

          if (signedIn && options.viewport.width === 393) {
            await page.setViewportSize(options.viewport);
            // Simulate browser chrome moving the visual viewport without changing the layout.
            await page.evaluate(() => {
              const v = window.visualViewport;
              if (!v) throw new Error("No VisualViewport");
              Object.defineProperties(v, {
                offsetLeft: { value: 8 },
                offsetTop: { value: 24 },
                width: { value: 375 },
                height: { value: 530 },
              });
              v.dispatchEvent(new Event("resize"));
              v.dispatchEvent(new Event("scroll"));
            });
            await expect.poll(async () => (await stage.boundingBox())?.width).toBe(375);
            await fits(page, stage, viewport, artwork, flow, show, ...controls);
            await show.tap();
            await fits(page, page.getByRole("dialog", { name: "Screens" }));
            await page.getByRole("button", { name: "Close" }).tap();
            await expect(show).toBeFocused();
          }

          if (signedIn) {
            await back.tap();
            await expect(page).toHaveURL(
              new URL(presentUrl.replace("/present", ""), instance.url).href,
            );
          }
        } finally {
          await context.close();
        }
      });
    }
  }
});
