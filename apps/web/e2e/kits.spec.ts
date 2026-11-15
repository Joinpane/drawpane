/**
 * The kit store in a real browser, on a throwaway instance whose registry is
 * a fixture served locally: browsing and filtering kits, a kit's details and
 * licence as its source gives it, adding one to the team in one click (it
 * lands in the Kits project with its credit, and can be published as a team
 * library), the "Added" badge, and a file that isn't the one listed refused.
 * Nothing reaches GitHub or Penpot: the page only talks to its own origin.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";
import { type KitRegistry, serveKitRegistry } from "./kit-fixture";

type Debug = {
  doc: {
    nodes(): Iterable<{ id: string; type: string; parent: string; props: Record<string, unknown> }>;
  };
};

const store = (page: Page) => page.getByRole("list", { name: "Kits" });
const card = (page: Page, name: string) =>
  store(page).getByRole("listitem").filter({ hasText: name });
const details = (page: Page, name: string) => page.getByRole("dialog", { name });

test.describe
  .serial("Kit store", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let registry: KitRegistry;
    let instance: Instance;
    let page: Page;
    const elsewhere: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      registry = await serveKitRegistry();
      instance = await freshInstance(browser, {
        port: 9001,
        inspectorPort: 9541,
        env: { E2E_KIT_REGISTRY: registry.url },
      });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      // The page itself never leaves its origin: covers and files come through the Worker.
      instance.context.on("request", (request) => {
        const url = new URL(request.url());
        if (/^https?:$/.test(url.protocol) && url.hostname !== "localhost")
          elsewhere.push(url.href);
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
      await registry?.stop();
    });

    test("lists the registry's kits, with covers, filters and search", async () => {
      await page.getByRole("link", { name: "Kit store" }).click();
      await expect(page.getByRole("heading", { name: "Kit store", level: 1 })).toBeVisible();
      await expect(store(page).getByRole("listitem")).toHaveCount(6);
      await expect(card(page, "Showcase Kit")).toContainText("UI kit · Ana Example");
      // Covers load through this origin.
      await expect
        .poll(() =>
          card(page, "Showcase Kit")
            .locator("img")
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
        )
        .toBe(278);
      // A kit without a cover gets a placeholder.
      await expect(card(page, "Changed Since Listed").locator("img")).toHaveCount(0);

      await page.getByRole("button", { name: /^Icons/ }).click();
      await expect(store(page).getByRole("listitem")).toHaveCount(2);
      await expect(card(page, "Older Format Icons")).toContainText("Penpot only");
      await expect(card(page, "Example Icons")).toBeVisible();
      await page.getByRole("button", { name: /^All/ }).click();
      await page.getByRole("searchbox", { name: "Search kits" }).fill("ana design");
      await expect(store(page).getByRole("listitem")).toHaveCount(1);
      await page.getByRole("searchbox", { name: "Search kits" }).fill("");
      await expect(store(page).getByRole("listitem")).toHaveCount(6);
    });

    test("shows a kit's details and its licence as the source gives it", async () => {
      await card(page, "Showcase Kit").getByRole("button").click();
      const dialog = details(page, "Showcase Kit");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("UI kit by Ana Example");
      await expect(dialog).toContainText("Cards, buttons and a colour palette");
      await expect(dialog).toContainText("Licence not stated by the author: see Penpot's hub");
      await expect(dialog.getByRole("link", { name: "Penpot's hub" })).toHaveAttribute(
        "href",
        "https://penpot.app/penpothub/libraries-templates/penpot-showcase",
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      await card(page, "Example Icons").getByRole("button").click();
      const icons = details(page, "Example Icons");
      await expect(icons.getByRole("link", { name: "Licence file from the author" })).toBeVisible();
      await icons.getByText("Read the licence").click();
      await expect(icons.locator("pre")).toContainText("Copyright (c) 2026 Studio Example");
      await icons.getByRole("button", { name: "Close" }).click();

      await card(page, "Starter System").getByRole("button").click();
      const starter = details(page, "Starter System");
      await expect(
        starter.getByRole("link", { name: "Creative Commons Attribution 4.0" }),
      ).toBeVisible();
      await expect(starter).toContainText('"Starter System" by Drawpane, CC BY 4.0');
      await starter.getByRole("button", { name: "Close" }).click();

      // Listed without a file: its page, not Add.
      await card(page, "Waiting For Its File").getByRole("button").click();
      const waiting = details(page, "Waiting For Its File");
      await expect(waiting.getByRole("link", { name: "Open its page" })).toBeVisible();
      await expect(waiting.getByRole("button", { name: "Add to team" })).toHaveCount(0);
      await waiting.getByRole("button", { name: "Close" }).click();

      // A file in Penpot's older format: said up front, with its page instead of Add.
      await card(page, "Older Format Icons").getByRole("button").click();
      const old = details(page, "Older Format Icons");
      await expect(old).toContainText("an older Penpot format");
      await expect(old.getByRole("button", { name: "Add to team" })).toHaveCount(0);
      await expect(old.getByRole("link", { name: "Open its page" })).toBeVisible();
      await old.getByRole("button", { name: "Close" }).click();
    });

    test("adds a kit to the team in one click, and publishes it as a library", async () => {
      await card(page, "Showcase Kit").getByRole("button").click();
      const dialog = details(page, "Showcase Kit");
      await dialog.getByRole("button", { name: "Add to team" }).click();
      await expect(dialog).toContainText("Added to your team's Kits project", { timeout: 30_000 });
      // The file came through the Worker, from where the registry says it's hosted.
      expect(registry.asked).toContain("files/showcase.penpot");

      const result = dialog.getByRole("listitem").filter({ hasText: "Showcase" });
      await expect(result).toContainText("2 pages");
      await result.getByRole("button", { name: "Publish as team library" }).click();
      await expect(result.getByText("Published")).toBeVisible();
      await expect(dialog.getByText("Added", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Done" }).click();

      await expect(card(page, "Showcase Kit").getByText("Added")).toBeVisible();
      await expect(card(page, "Example Icons").getByText("Added")).toHaveCount(0);
      // The kit's file is in the team's Kits project.
      const kitsProject = page.getByRole("link", { name: /^Kits\s*1$/ });
      await expect(kitsProject).toBeVisible();
    });

    test("puts the kit's credit on its first page", async () => {
      await page.getByRole("link", { name: /^Kits\s*1$/ }).click();
      await page.getByRole("button", { name: /^Open Showcase/ }).click();
      await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const nodes = [...(window as unknown as { drawpane: Debug }).drawpane.doc.nodes()];
            const credit = nodes.find((n) => n.props.name === "About this kit");
            const text = nodes
              .filter((n) => n.parent === credit?.id && n.type === "text")
              .map((n) => String(n.props.characters));
            const page = nodes.find((n) => n.id === credit?.parent);
            return { page: page?.type, text };
          }),
        )
        .toEqual({
          page: "page",
          text: expect.arrayContaining([
            "About this kit",
            "Showcase Kit",
            '"Showcase Kit" by Ana Example.',
            "Licence not stated by the author: see Penpot's hub: https://penpot.app/penpothub/libraries-templates/penpot-showcase",
          ]),
        });
      await page.goBack();
      await page.goBack();
    });

    test("refuses a file that isn't the one listed", async () => {
      await page.getByRole("link", { name: "Kit store" }).click();
      await card(page, "Changed Since Listed").getByRole("button").click();
      const dialog = details(page, "Changed Since Listed");
      await dialog.getByRole("button", { name: "Add to team" }).click();
      await expect(dialog.getByRole("alert")).toContainText("isn't the one the store lists");
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(card(page, "Changed Since Listed").getByText("Added")).toHaveCount(0);
      expect(elsewhere).toEqual([]);
    });
  });
