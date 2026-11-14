/**
 * Team libraries (decision 0010) end to end: one file publishes a component,
 * another uses the library and inserts it, the library publishes a change,
 * and the other file reviews and takes the update, its instance following.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    s: { pageId: string; selection: string[] };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    setProp(ids: string[], prop: string, value: unknown, label: string): void;
    select(ids: string[]): void;
    createComponent(): void;
    doc: {
      get(id: string): { props: Record<string, unknown>; parent: string } | undefined;
      nodes(): Iterable<{
        id: string;
        type: string;
        parent: string;
        props: Record<string, unknown>;
      }>;
    };
  };
};

/** A new file, named, open in the editor; its id. */
async function newFile(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "New file" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
    timeout: 15_000,
  });
  const id = new URL(page.url()).pathname.split("/").pop() as string;
  const res = await page.evaluate(
    async ({ id, name }) =>
      (
        await fetch(`/api/files/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        })
      ).status,
    { id, name },
  );
  expect(res).toBe(200);
  return id;
}

const openAssets = async (page: Page) => {
  await page.getByRole("radio", { name: "Assets" }).click();
};

/** The fill of the instance on the page (not the library's copy). */
const instanceFill = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as W).drawpane;
    for (const node of e.doc.nodes())
      if (node.type === "frame" && node.props.instanceOf && node.parent === e.s.pageId)
        return (node.props.fills as Array<{ color: string }> | undefined)?.[0]?.color ?? null;
    return null;
  });

test.describe
  .serial("Team libraries", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let kit: string;
    let product: string;
    let button: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8881, inspectorPort: 9421 });
      page = instance.page;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("publishes a file's components as a library", async () => {
      kit = await newFile(page, "Brand kit");
      button = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const b = e.createLayer("frame", { x: 0, y: 0, width: 120, height: 40 }, e.s.pageId, {
          name: "Button",
          fills: [{ type: "solid", color: "#e04f1a" }],
        }) as string;
        e.select([b]);
        e.createComponent();
        return b;
      });
      await openAssets(page);
      await page.getByRole("button", { name: "Team libraries" }).click();
      const libraries = page.getByRole("dialog", { name: "Team libraries" });
      await expect(libraries.getByText("1 component · not published")).toBeVisible();
      await libraries.getByRole("button", { name: "Publish…" }).click();
      const publish = page.getByRole("dialog", { name: "Publish as a library" });
      await expect(publish.getByText("Button")).toBeVisible();
      await publish.getByLabel(/What changed/).fill("First buttons");
      await publish.getByRole("button", { name: "Publish" }).click();
      await expect(page.getByText("Published 1 component to the team.")).toBeVisible();
    });

    test("uses the library in another file and inserts its component", async () => {
      product = await newFile(page, "Product");
      await openAssets(page);
      await page.getByRole("button", { name: "Browse team libraries" }).click();
      const libraries = page.getByRole("dialog", { name: "Team libraries" });
      await libraries.getByRole("button", { name: "Use Brand kit" }).click();
      await expect(libraries.getByRole("button", { name: "Stop using Brand kit" })).toBeVisible();
      await libraries.getByRole("button", { name: "Done" }).click();

      const section = page.getByRole("region", { name: "Brand kit" });
      await section.getByRole("button", { name: "Button" }).click();
      await expect.poll(() => instanceFill(page)).toBe("#e04f1a");
      // The instance is of the library's copy, which isn't one of the file's own components.
      const copy = await page.evaluate(() => {
        const e = (window as unknown as W).drawpane;
        const id = e.s.selection[0] as string;
        const main = e.doc.get(e.doc.get(id)?.props.instanceOf as string);
        return { parentType: e.doc.get(main?.parent as string)?.props.libraryFile ?? null };
      });
      expect(copy.parentType).toBe(kit);
      // Stopping now is refused: an instance uses it.
      await page.getByRole("button", { name: "Team libraries" }).click();
      await libraries.getByRole("button", { name: "Stop using Brand kit" }).click();
      await expect(page.getByText(/1 instance uses this library/)).toBeVisible();
      await libraries.getByRole("button", { name: "Done" }).click();
    });

    test("reviews the library's next publish and takes it, the instance following", async () => {
      // Back in the library: recolour the button, publish the change.
      await page.goto(`/f/${kit}`);
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await page.evaluate(
        (id) =>
          (window as unknown as W).drawpane.setProp(
            [id],
            "fills",
            [{ type: "solid", color: "#2b4fd6" }],
            "Fill",
          ),
        button,
      );
      await openAssets(page);
      await page.getByRole("button", { name: "Team libraries" }).click();
      await page
        .getByRole("dialog", { name: "Team libraries" })
        .getByRole("button", { name: "Publish…" })
        .click();
      const publish = page.getByRole("dialog", { name: "Publish library changes" });
      await expect(publish.getByText("1 changed")).toBeVisible();
      await publish.getByLabel(/What changed/).fill("Blue buttons");
      await publish.getByRole("button", { name: "Publish" }).click();
      await expect(page.getByText("Published 1 component to the team.")).toBeVisible();

      // The product file offers the update; it waits for review.
      await page.goto(`/f/${product}`);
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await openAssets(page);
      expect(await instanceFill(page)).toBe("#e04f1a");
      const section = page.getByRole("region", { name: "Brand kit" });
      await section.getByRole("button", { name: "Update" }).click();
      const review = page.getByRole("dialog", { name: "Update Brand kit" });
      await expect(review.getByText("Blue buttons")).toBeVisible();
      await expect(review.getByRole("region", { name: "Changed" })).toContainText("Button");
      await review.getByRole("button", { name: "Update", exact: true }).click();
      await expect.poll(() => instanceFill(page)).toBe("#2b4fd6");
      await expect(section.getByRole("button", { name: "Update" })).toHaveCount(0);
      // One undo puts the old version back.
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => instanceFill(page)).toBe("#e04f1a");
    });
  });
