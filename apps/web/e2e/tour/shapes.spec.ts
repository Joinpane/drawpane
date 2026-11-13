/**
 * Screenshots of polygons, stars, stroke ends and angular gradients for design
 * review, in both themes. Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const OUT = process.env.TOUR_OUT ?? "tour-shots";

async function passkey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function shot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

type Debug = {
  s: { pageId: string };
  createLayer(
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    parent: string,
    props?: Record<string, unknown>,
  ): string | null;
  select(ids: string[]): void;
  zoomToFit(): void;
};

test("shapes tour", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

  const ids = await page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    const p = e.s.pageId;
    const fill = (color: string) => [{ type: "solid", color }];
    const hexagon = e.createLayer("polygon", { x: 0, y: 0, width: 160, height: 160 }, p, {
      pointCount: 6,
      fills: fill("#2b4fd6"),
    }) as string;
    const star = e.createLayer("star", { x: 200, y: 0, width: 160, height: 160 }, p, {
      pointCount: 5,
      innerRadius: 0.45,
      cornerRadius: 10,
      fills: fill("#f5b400"),
    }) as string;
    const burst = e.createLayer("star", { x: 400, y: 0, width: 160, height: 160 }, p, {
      pointCount: 12,
      innerRadius: 0.72,
      fills: [
        {
          type: "angular",
          from: { x: 0.5, y: 0.5 },
          to: { x: 0.5, y: 0 },
          stops: [
            { position: 0, color: "#ff5a1f" },
            { position: 0.5, color: "#c62a6f" },
            { position: 1, color: "#ff5a1f" },
          ],
        },
      ],
    }) as string;
    const kinds = ["arrow", "triangle", "circle", "diamond", "bar"];
    const lines = kinds.map(
      (k, i) =>
        e.createLayer("line", { x: 0, y: 220 + i * 40, width: 560, height: 0 }, p, {
          strokes: [{ type: "solid", color: "#1c1b1a" }],
          strokeWeight: 2,
          markerEnd: k,
          markerStart: i % 2 === 0 ? "none" : k,
        }) as string,
    );
    e.select([]);
    e.zoomToFit();
    return { hexagon, star, burst, line: lines[0] as string };
  });

  // The shape menu in the toolbar.
  await page.getByRole("button", { name: "More shapes" }).click();
  await expect(page.getByRole("menu", { name: "Shapes" })).toBeVisible();
  await shot(page, "90-shape-menu");
  await page.keyboard.press("Escape");

  // A rounded star selected: the Star section and corner radius.
  await page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
    ids.star,
  );
  await shot(page, "91-star");

  // An arrow: stroke ends in the inspector.
  await page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
    ids.line,
  );
  await shot(page, "92-stroke-ends");

  // The angular gradient in the picker.
  await page.evaluate(
    (id) => (window as unknown as { drawpane: Debug }).drawpane.select([id]),
    ids.burst,
  );
  await page
    .getByRole("group", { name: "Properties" })
    .getByRole("button", { name: "Edit fill" })
    .click();
  await expect(page.getByRole("dialog", { name: "Fill paint" })).toBeVisible();
  await shot(page, "93-angular");
});
