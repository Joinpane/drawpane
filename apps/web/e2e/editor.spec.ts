import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token";

/** Gives a browser context a software passkey authenticator, like a phone or Touch ID. */
async function addPasskeyDevice(context: BrowserContext, page: Page) {
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

test.describe
  .serial("Drawpane", () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      context = await browser.newContext();
      page = await context.newPage();
      await addPasskeyDevice(context, page);
    });

    test.afterAll(async () => {
      await context.close();
    });

    test("sets up a fresh instance with a passkey", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup/);
      await expect(page.getByRole("heading", { name: "Set up this instance" })).toBeVisible();
      await page.getByLabel("Your name").fill("Ana Lima");
      await page.getByLabel("Email").fill("ana@example.com");
      await page.getByLabel("Setup token").fill(SETUP_TOKEN);
      await page.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await expect(page.getByText("A clean slate.")).toBeVisible();
    });

    test("creates a file and draws in it", async () => {
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page).toHaveURL(/\/f\//);
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });

      // Draw a rectangle: R, then drag on the canvas.
      const canvas = page.getByRole("application", { name: "Design canvas" });
      await canvas.click({ position: { x: 700, y: 500 } });
      await page.keyboard.press("r");
      await page.mouse.move(600, 300);
      await page.mouse.down();
      await page.mouse.move(700, 380, { steps: 5 });
      await page.mouse.move(760, 420, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByRole("treeitem", { name: /Rectangle 1/ })).toBeVisible();
      const width = page.getByRole("group", { name: "Properties" }).getByLabel("Width");
      await expect(width).toHaveValue("160");
      // Every edit reaches the room.
      await expect(page.getByRole("status")).toContainText("Saved");

      // The command bar sets values by name.
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox").fill("w 320");
      await page.keyboard.press("Enter");
      await expect(width).toHaveValue("320");

      // Undo returns to the previous width.
      await page.keyboard.press("ControlOrMeta+z");
      await expect(width).toHaveValue("160");
    });

    test("makes a component, and its instances follow the main", async () => {
      await page.getByRole("treeitem", { name: /Rectangle 1/ }).click();
      await page.keyboard.press("ControlOrMeta+Alt+k");
      await expect(
        page.getByRole("heading", { level: 2, name: "Component", exact: true }),
      ).toBeVisible();

      // Duplicating a main component makes an instance.
      await page.keyboard.press("ControlOrMeta+d");
      await expect(
        page.getByRole("heading", { level: 2, name: "Instance", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/Instance of/)).toBeVisible();

      // Change the main's fill from the command bar; the instance follows.
      await page.getByRole("button", { name: "Go to main component" }).click();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox").fill("fill #2563eb");
      await page.keyboard.press("Enter");
      const props = page.getByRole("group", { name: "Properties" });
      await expect(props.getByLabel("Fill hex")).toHaveValue("2563EB");
      await page.getByRole("button", { name: "Select instances" }).click();
      await expect(props.getByLabel("Fill hex")).toHaveValue("2563EB");

      // Assets lists the component.
      await page.getByRole("radio", { name: "Assets" }).click();
      await expect(
        page.getByRole("button", { name: /Component|Rectangle 1/ }).first(),
      ).toBeVisible();
      await page.getByRole("radio", { name: "Layers" }).click();
    });

    test("shows edits live in a second tab and survives a reload", async () => {
      const url = page.url();
      const second = await context.newPage();
      await second.goto(url);
      await expect(second.getByRole("treeitem", { name: /Rectangle 1/ }).first()).toBeVisible({
        timeout: 15_000,
      });

      // Draw an ellipse in the first tab; it appears in the second.
      await page.keyboard.press("o");
      await page.mouse.move(900, 300);
      await page.mouse.down();
      await page.mouse.move(980, 380, { steps: 6 });
      await page.mouse.up();
      await expect(second.getByRole("treeitem", { name: /Ellipse 1/ }).first()).toBeVisible({
        timeout: 10_000,
      });

      await second.reload();
      await expect(second.getByRole("treeitem", { name: /Ellipse 1/ }).first()).toBeVisible({
        timeout: 15_000,
      });
      await second.close();
    });

    test("signs out and back in with the same passkey", async () => {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/signin/);
      await page.getByRole("button", { name: "Continue with a passkey" }).click();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Open Untitled/ })).toBeVisible();
    });
  });
