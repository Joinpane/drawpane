/**
 * Screenshots of the kit store for design review, in both themes: the store,
 * a kit's details with its licence, and a kit just added to the team. The
 * registry is the local fixture (../kit-fixture.ts): nothing reaches GitHub
 * or Penpot. Run with `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { type KitRegistry, serveKitRegistry } from "../kit-fixture";
import { passkey, shot, test } from "./harness";

let registry: KitRegistry;

test.beforeAll(async () => {
  registry = await serveKitRegistry();
  // Read by the harness when it starts this tour's Worker.
  process.env.E2E_KIT_REGISTRY = registry.url;
});

test.afterAll(async () => {
  delete process.env.E2E_KIT_REGISTRY;
  await registry?.stop();
});

test("kit store tour", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await passkey(context, page);
  await page.goto("/setup");
  await page.getByLabel("Your name").fill("Ana Lima");
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();

  await page
    .getByRole("complementary", { name: "Navigation" })
    .getByRole("link", { name: "Kit store" })
    .click();
  const store = page.getByRole("list", { name: "Kits" });
  await expect(store.getByRole("listitem")).toHaveCount(6);
  await expect
    .poll(() =>
      store
        .locator("img")
        .evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).complete)),
    )
    .toBe(true);
  await shot(page, "185-kit-store");

  const card = (name: string) => store.getByRole("listitem").filter({ hasText: name });
  await card("Example Icons").getByRole("button").click();
  const icons = page.getByRole("dialog", { name: "Example Icons" });
  await icons.getByText("Read the licence").click();
  await shot(page, "186-kit-details-licence");
  await icons.getByRole("button", { name: "Close" }).click();

  await card("Showcase Kit").getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: "Showcase Kit" });
  await dialog.getByRole("button", { name: "Add to team" }).click();
  await expect(dialog).toContainText("Added to your team's Kits project", { timeout: 30_000 });
  await shot(page, "187-kit-added");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(card("Showcase Kit").getByText("Added")).toBeVisible();
  await shot(page, "188-kit-store-added");
  await context.close();
});
