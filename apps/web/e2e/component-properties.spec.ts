/**
 * Component properties on an imported instance (decision 0035), in a real
 * browser: a Figma file with a Button set (a boolean, a text and a swap
 * besides its variant) and a Field exposing a nested Button, imported the
 * way the dashboard does it, with Figma's API played by the test. The
 * instance panel shows Figma's properties, lists no layout as changes, and
 * toggling a boolean or editing a text changes the layers they drive.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Node = { id: string; props: Record<string, unknown> };
type W = {
  drawpane: {
    select(ids: string[]): void;
    doc: { get(id: string): Node | undefined; childIds(id: string): readonly string[] };
  };
};

const KEY = "Cp7RtZcLm2Xw9KpYbN3VdE";
const cors = { "access-control-allow-origin": "*" };
const file = () =>
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../packages/figma/test/fixtures/component-properties.json",
      ),
      "utf8",
    ),
  );

const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });
const inspector = (page: Page) => page.getByRole("region", { name: "Main component" });

/** The layer of an instance that copies `mirrors`, as the page has it now. */
function copyOf(page: Page, instance: string, mirrors: string) {
  return page.evaluate(
    ([instance, mirrors]) => {
      const { doc } = (window as unknown as W).drawpane;
      const stack = [...doc.childIds(instance as string)];
      for (let id = stack.pop(); id; id = stack.pop()) {
        const node = doc.get(id);
        if (!node) continue;
        if (node.props.mirrors === mirrors) return node.props;
        stack.push(...doc.childIds(id));
      }
      return null;
    },
    [instance, mirrors],
  );
}

test.describe
  .serial("Component properties", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9021, inspectorPort: 9561 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await page.route("https://api.figma.com/v1/**", async (route: Route) => {
        const url = new URL(route.request().url());
        if (url.pathname === `/v1/files/${KEY}`)
          return route.fulfill({ headers: cors, json: file() });
        if (url.pathname === `/v1/files/${KEY}/images`)
          return route.fulfill({
            headers: cors,
            json: { error: false, status: 200, meta: { images: {} } },
          });
        return route.fulfill({ status: 404, headers: cors, json: {} });
      });
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await dialog(page)
        .getByLabel("Figma file link")
        .fill(`https://www.figma.com/design/${KEY}/x`);
      await dialog(page).getByLabel("Personal access token").fill("figd_test-token");
      await dialog(page).getByRole("button", { name: "Import", exact: true }).click();
      const row = dialog(page).getByRole("listitem").filter({ hasText: "Component properties" });
      await expect(row).toContainText("1 page", { timeout: 30_000 });
      await row.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("shows Figma's properties on an imported instance, and no layout as changes", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.select(["f6-1"]));
      const panel = inspector(page);
      await expect(panel.getByRole("switch", { name: "Show Icon" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(panel.getByRole("textbox", { name: "Label" })).toHaveValue("Outline");
      await expect(panel.getByRole("button", { name: "Icon", exact: true })).toContainText("Check");
      // Its hug width, its label's auto width and its variant aren't changes; its text is one.
      await expect(panel.getByRole("list", { name: "Overrides" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Reset 1 change" })).toBeVisible();
    });

    test("Escape cancels a text property draft", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.select(["f6-1"]));
      const label = inspector(page).getByRole("textbox", { name: "Label", exact: true });
      await expect(label).toHaveValue("Outline");
      await label.fill("Do not commit");
      await label.press("Escape");
      await expect
        .poll(() => copyOf(page, "f6-1", "f1-7").then((p) => p?.characters))
        .toBe("Outline");
      await expect(label).toHaveValue("Outline");
    });

    test("toggles a boolean and edits a text property", async () => {
      const panel = inspector(page);
      await panel.getByRole("switch", { name: "Show Icon" }).click();
      await expect.poll(() => copyOf(page, "f6-1", "f1-6").then((p) => p?.visible)).toBe(false);
      await expect(panel.getByRole("switch", { name: "Show Icon" })).toHaveAttribute(
        "aria-checked",
        "false",
      );

      const label = panel.getByRole("textbox", { name: "Label" });
      await label.fill("Delete");
      await label.press("Enter");
      await expect
        .poll(() => copyOf(page, "f6-1", "f1-7").then((p) => p?.characters))
        .toBe("Delete");
      await expect(panel.getByRole("button", { name: "Reset all 2 changes" })).toBeVisible();

      // Each is its own undo step.
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(() => copyOf(page, "f6-1", "f1-7").then((p) => p?.characters))
        .toBe("Outline");
      await panel.getByRole("button", { name: "Reset Show Icon" }).click();
      await expect
        .poll(() => copyOf(page, "f6-1", "f1-6").then((p) => p?.visible ?? true))
        .toBe(true);
    });

    test("shows a nested instance's exposed properties under its name", async () => {
      await page.evaluate(() => (window as unknown as W).drawpane.select(["f6-2"]));
      const panel = inspector(page);
      await expect(panel.getByRole("textbox", { name: "Label Text" })).toHaveValue("Bio");
      const nested = panel.getByRole("region", { name: "Button" });
      await expect(nested.getByRole("switch", { name: "Show Icon" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(nested.getByRole("textbox", { name: "Label" })).toHaveValue("Save");
      await nested.getByRole("switch", { name: "Show Icon" }).click();
      await expect(nested.getByRole("switch", { name: "Show Icon" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });
