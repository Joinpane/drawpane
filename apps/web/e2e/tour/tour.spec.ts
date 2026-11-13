/**
 * A screenshot tour of every screen in both themes, for design review.
 * Not part of the regular suite: run `pnpm --filter @drawpane/web tour`
 * and look at the PNGs in `tour-shots/`.
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

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
}

test("tour", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);

  await page.goto("/setup");
  await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
  await shot(page, "01-setup");
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await shot(page, "02-dashboard-empty");

  // A file with some real content.
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await page.keyboard.press("f");
  await drag(page, [520, 180], [880, 700]);
  await page.keyboard.press("r");
  await drag(page, [560, 240], [840, 330]);
  await page.keyboard.press("o");
  await drag(page, [560, 380], [640, 460]);
  await page.keyboard.press("t");
  await page.mouse.click(660, 400);
  await page.keyboard.type("Good morning, Ana");
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await drag(page, [960, 240], [1080, 300]);
  await page.keyboard.press("r");
  await drag(page, [960, 320], [1080, 380]);
  await page.mouse.click(1020, 270);
  await page.keyboard.down("Shift");
  await page.mouse.click(1020, 350);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Shift+a");
  await page.waitForTimeout(300);
  await shot(page, "03-editor-autolayout");

  await page.mouse.click(700, 285);
  console.log(
    "STATE",
    await page.evaluate(() => {
      const e = (window as unknown as { drawpane?: { s: Record<string, unknown> } }).drawpane;
      if (!e) return "no handle";
      const { selection, gesture, editingText, tool, role } = e.s;
      return JSON.stringify({
        selection,
        gesture,
        editingText,
        tool,
        role,
        lens: !!document.querySelector(".lens-anchor"),
      });
    }),
  );
  await shot(page, "04-editor-rect-selected");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("w 320");
  await shot(page, "05-command-bar");
  await page.keyboard.press("Escape");

  await page.keyboard.down("Alt");
  await page.mouse.click(1020, 270);
  await shot(page, "06-xray");
  await page.keyboard.up("Alt");

  await page.mouse.click(300, 820);
  await shot(page, "07-editor-nothing-selected");

  // Components: make the auto-layout stack a component, then an instance of it.
  await page.getByRole("treeitem", { name: /Frame 2/ }).click();
  await page.keyboard.press("ControlOrMeta+Alt+k");
  await page.keyboard.press("ControlOrMeta+d");
  await page.waitForTimeout(500);
  await shot(page, "10-instance-selected");
  await page.getByRole("button", { name: "Go to main" }).click();
  await page.waitForTimeout(500);
  await shot(page, "11-main-component");
  await page.getByRole("radio", { name: "Assets" }).click();
  await page.waitForTimeout(300);
  await shot(page, "12-assets");
  await page.getByRole("radio", { name: "Layers" }).click();

  // Variants: combine the main into a set, add a variant, then switch the instance to it.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("combine as variants");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await shot(page, "17-component-set");
  await page.getByRole("treeitem", { name: /Property 1=Default/ }).click();
  await page.getByRole("button", { name: "Add variant" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("textbox", { name: "Property 1" }).fill("Pressed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await shot(page, "18-variant");
  await page
    .getByRole("treeitem", { name: /Frame 2/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  await shot(page, "19-instance-variants");
  await page.getByRole("radio", { name: "Pressed" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("treeitem", { name: /Property 1=Default/ }).click();

  // Inspect the main component, then measure to another layer with Alt.
  await page.getByRole("radio", { name: "Inspect" }).click();
  await page.waitForTimeout(300);
  await shot(page, "15-inspect");
  await page.getByRole("radio", { name: "Tailwind" }).click();
  await shot(page, "16-inspect-tailwind");
  await page.getByRole("radio", { name: "Design" }).first().click();

  // Tokens: a collection with a few variables and a second mode.
  await page.keyboard.press("Alt+t");
  await shot(page, "13-tokens-empty");
  await page.getByRole("button", { name: "New collection" }).first().click();
  for (const [name, value] of [
    ["brand/500", "#2563eb"],
    ["surface/page", "#ffffff"],
    ["text/strong", "#16181d"],
  ] as const) {
    await page.getByRole("button", { name: "Token", exact: true }).click();
    const nameButton = page.getByRole("rowheader").last().getByRole("button");
    await nameButton.dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
    const cell = page.getByRole("row").last().getByRole("textbox", { name: "Value" }).first();
    await cell.fill(value);
    await cell.press("Enter");
  }
  await page.getByRole("button", { name: "Add mode" }).click();
  await page.keyboard.type("Dark");
  await page.keyboard.press("Enter");
  await page.getByRole("rowheader").first().click();
  await page.waitForTimeout(300);
  await shot(page, "14-tokens");
  await page.keyboard.press("Alt+t");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await shot(page, "08-dashboard");

  await page.getByRole("button", { name: "Invite" }).click();
  await shot(page, "09-invite");
  await context.close();
});
