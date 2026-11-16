/**
 * Importing a Figma .fig file in a real browser, on a throwaway instance:
 * a file that isn't a design file explained; a .fig chosen in the Import
 * dialog's Figma tab read in a Worker, its images uploaded, opened with its
 * pages, layers, an instance linked to its main and an image fill; and a .fig
 * dropped anywhere on the dashboard imported the same way.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  doc: {
    nodes(): Iterable<{ id: string; type: string; key: string; props: Record<string, unknown> }>;
  };
};
type W = { drawpane: Debug };

/** Google's MediaNova sample (Apache-2.0): two pages, components, instances and images. */
const FIXTURE = resolve(import.meta.dirname, "../../../packages/fig/test/fixtures/medianova.fig");
const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });
const chooser = (page: Page) => dialog(page).locator('input[type="file"][accept=".fig"]');

/** What the open file holds, read from the editor's document. */
async function contents(page: Page) {
  return page.evaluate(() => {
    const nodes = [...(window as unknown as W).drawpane.doc.nodes()];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const instances = nodes.filter((n) => typeof n.props.instanceOf === "string");
    return {
      pages: nodes
        .filter((n) => n.type === "page")
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map((n) => n.props.name),
      layers: nodes.filter((n) => n.type !== "page").length,
      linkedInstance: instances.some(
        (n) => byId.get(n.props.instanceOf as string)?.props.isComponent === true,
      ),
      mirrors: nodes.some(
        (n) => typeof n.props.mirrors === "string" && byId.has(n.props.mirrors as string),
      ),
      image:
        nodes
          .flatMap((n) => (n.props.fills ?? []) as Array<{ type: string; ref?: string }>)
          .find((f) => f.type === "image")?.ref ?? null,
    };
  });
}

test.describe
  .serial(".fig import", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9031, inspectorPort: 9571 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("explains a file that isn't a Figma design file", async () => {
      await page.getByRole("button", { name: "Import", exact: true }).click();
      // The Figma tab offers a .fig file before the link.
      await expect(dialog(page).getByText("Drop a .fig file here")).toBeVisible();
      const board = Buffer.alloc(16);
      board.write("fig-jam.", 0, "latin1");
      await chooser(page).setInputFiles({
        name: "Board.fig",
        mimeType: "application/octet-stream",
        buffer: board,
      });
      await expect(dialog(page).getByRole("alert")).toHaveText(
        "This is a FigJam board. Only Figma design files can be imported.",
      );
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(page)).toBeHidden();
    });

    test("imports a .fig chosen in the dialog, and opens it", async () => {
      const imported = page.waitForRequest(
        (r) => r.method() === "POST" && /\/api\/files\/[^/]+\/import$/.test(r.url()),
      );
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await chooser(page).setInputFiles(FIXTURE);
      const row = dialog(page).getByRole("listitem").filter({ hasText: "MediaNova V2" });
      await expect(row).toContainText(/2 pages · \d+ layers/, { timeout: 60_000 });
      const saved = JSON.parse((await imported).postData() ?? "{}") as { nodes: unknown[] };

      await row.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => {
          const c = await contents(page);
          return { ...c, image: c.image !== null };
        })
        .toEqual({
          pages: ["Cover", "Design"],
          layers: saved.nodes.length - 2,
          linkedInstance: true,
          mirrors: true,
          image: true,
        });
      // The image came out of the file and was uploaded: it's served.
      const { image } = await contents(page);
      expect((await page.request.get(`/api/media/${image}`)).status()).toBe(200);
    });

    test("imports a .fig dropped on the dashboard", async () => {
      await page.goBack();
      await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
      const bytes = readFileSync(FIXTURE).toString("base64");
      const transfer = await page.evaluateHandle((b64) => {
        const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([data], "Dropped.fig", { type: "application/octet-stream" }));
        return dt;
      }, bytes);
      const dashboard = page.locator(".dash");
      await dashboard.dispatchEvent("dragover", { dataTransfer: transfer });
      await expect(page.getByText(/Drop to import into/)).toBeVisible();
      await dashboard.dispatchEvent("drop", { dataTransfer: transfer });
      const row = dialog(page).getByRole("listitem").filter({ hasText: "MediaNova V2" });
      await expect(row).toContainText(/2 pages · \d+ layers/, { timeout: 60_000 });
      await dialog(page).getByRole("button", { name: "Done" }).click();
      // Both imports are on the dashboard.
      await expect(page.getByText("MediaNova V2", { exact: true })).toHaveCount(2);
    });
  });
