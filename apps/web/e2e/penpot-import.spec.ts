/**
 * Importing from Penpot in a real browser, on a throwaway instance: choosing
 * a .penpot export from the dashboard, watching it come across, opening the
 * new file, and finding its pages, layers, image, components and library;
 * a bad file explained; and a two-file export making two files.
 */
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  doc: {
    nodes(): Iterable<{ id: string; type: string; props: Record<string, unknown> }>;
  };
};
type W = { drawpane: Debug };

const fixture = (name: string) =>
  resolve(import.meta.dirname, "../../../packages/penpot/test/fixtures", name);
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });
/** Opens the Import dialog on its Penpot side. */
async function openPenpotImport(page: Page) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await dialog(page).getByRole("radio", { name: "Penpot" }).click();
}
const chooser = (page: Page) => dialog(page).locator('input[type="file"]');

test.describe
  .serial("Penpot import", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8817, inspectorPort: 9357 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("explains a file that isn't a Penpot export", async () => {
      await openPenpotImport(page);
      await chooser(page).setInputFiles({
        name: "old.penpot",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("not a zip"),
      });
      await expect(dialog(page).getByRole("alert")).toContainText("older format");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(page)).toBeHidden();
    });

    test("imports an export into a new file, and opens it", async () => {
      const imported = page.waitForRequest(
        (r) => r.method() === "POST" && /\/api\/files\/[^/]+\/imports\/[^/]+\/parts$/.test(r.url()),
      );
      await openPenpotImport(page);
      await chooser(page).setInputFiles(fixture("showcase.penpot"));
      const row = dialog(page).getByRole("listitem").filter({ hasText: "Showcase" });
      await expect(row).toContainText("2 pages", { timeout: 30_000 });
      await expect(dialog(page).getByRole("button", { name: "Done" })).toBeEnabled();

      await row.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const nodes = [...(window as unknown as W).drawpane.doc.nodes()];
            return {
              pages: nodes.filter((n) => n.type === "page").map((n) => n.props.name),
              card: nodes.some((n) => n.props.name === "Card" && n.props.layoutMode === "column"),
              image: nodes.some((n) =>
                JSON.stringify(n.props.fills ?? []).includes('"type":"image"'),
              ),
              component: nodes.some((n) => n.props.isComponent === true),
              instance: nodes.some((n) => typeof n.props.instanceOf === "string"),
              style: nodes.some((n) => n.type === "textStyle"),
              color: nodes.some((n) => n.type === "variable"),
            };
          }),
        )
        .toEqual({
          pages: ["Cover", "Done"],
          card: true,
          image: true,
          component: true,
          instance: true,
          style: true,
          color: true,
        });
      // The uploaded image is served.
      const ref = await page.evaluate(() => {
        for (const n of (window as unknown as W).drawpane.doc.nodes()) {
          const image = ((n.props.fills ?? []) as Array<{ type: string; ref?: string }>).find(
            (f) => f.type === "image",
          );
          if (image?.ref) return image.ref;
        }
        return null;
      });
      expect((await page.request.get(`/api/media/${ref}`)).status()).toBe(200);

      // Opening it changes nothing: once its fonts have arrived, every layer is
      // where the import put it (as Penpot had it).
      const saved = JSON.parse((await imported).postData() ?? "{}") as {
        nodes: Array<{ id: string; props: Record<string, unknown> }>;
      };
      const box = (props: Record<string, unknown>) =>
        [props.x, props.y, props.width, props.height].map((v) => v ?? null).join(" ");
      const want = Object.fromEntries(saved.nodes.map((n) => [n.id, box(n.props)]));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1_000);
      const have = await page.evaluate(() =>
        Object.fromEntries(
          [...(window as unknown as W).drawpane.doc.nodes()].map((n) => [
            n.id,
            [n.props.x, n.props.y, n.props.width, n.props.height].map((v) => v ?? null).join(" "),
          ]),
        ),
      );
      for (const [id, b] of Object.entries(want)) if (id in have) expect(have[id], id).toBe(b);
    });

    test("makes a file for each file in the export", async () => {
      await page.goBack();
      await openPenpotImport(page);
      await chooser(page).setInputFiles(fixture("file-with-library.penpot"));
      await expect(dialog(page).getByRole("listitem")).toHaveCount(2);
      await expect(dialog(page).getByRole("button", { name: "Done" })).toBeEnabled({
        timeout: 30_000,
      });
      await expect(dialog(page).getByRole("listitem").filter({ hasText: /layer/ })).toHaveCount(2);
      // The copy of the library's component is detached, and says so.
      await expect(dialog(page)).toContainText("came across differently");
      await dialog(page).getByRole("button", { name: "Done" }).click();
      // All three imported files are on the dashboard.
      for (const name of ["Showcase", "File 1", "LIbrary"])
        await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    });
  });
