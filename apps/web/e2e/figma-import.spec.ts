/**
 * Importing from Figma in a real browser, with Figma's API played by the
 * test: the page itself calls Figma (the token goes nowhere else), so this
 * is what proves the Content Security Policy lets it, for the file and for
 * the images in Figma's storage. A file read, its image downloaded and
 * uploaded, the new file opened with the image in it; and Figma's limit
 * explained in words, from the headers it exposes to the page.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type Debug = {
  doc: { nodes(): Iterable<{ id: string; type: string; props: Record<string, unknown> }> };
};
type W = { drawpane: Debug };

const KEY = "Fq7RtZcLm2Xw9KpYbN3VdE";
const IMAGE_REF = "4b3f0c0ffee0ddba11";
const IMAGE_URL = `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${IMAGE_REF}`;
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A real Figma file (from the converter's parity suite), with an image fill added. */
function figmaFile() {
  const file = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../packages/figma/test/fixtures/parity-file.json"),
      "utf8",
    ),
  );
  const visit = (node: { type?: string; fills?: unknown[]; children?: unknown[] }): boolean => {
    if (node.type === "RECTANGLE" && Array.isArray(node.fills)) {
      node.fills = [{ type: "IMAGE", imageRef: IMAGE_REF, scaleMode: "FILL", blendMode: "NORMAL" }];
      return true;
    }
    return (node.children ?? []).some((child) => visit(child as typeof node));
  };
  if (!visit(file.document)) throw new Error("The fixture has no rectangle to fill.");
  return { ...file, name: "From Figma" };
}

/** Answers as Figma does, to a page on another origin. */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Retry-After, X-Figma-Plan-Tier",
};

const dialog = (page: Page) => page.getByRole("dialog", { name: "Import" });

async function startImport(page: Page) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await dialog(page).getByLabel("Figma file link").fill(`https://www.figma.com/design/${KEY}/x`);
  await dialog(page).getByLabel("Personal access token").fill("figd_test-token");
  await dialog(page).getByRole("button", { name: "Import", exact: true }).click();
}

test.describe
  .serial("Figma import", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    const blocked: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9011, inspectorPort: 9551 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) blocked.push(message.text());
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("reads the file and its images from Figma, and opens it", async () => {
      const tokens: (string | undefined)[] = [];
      await page.route("https://api.figma.com/v1/**", async (route: Route) => {
        tokens.push(route.request().headers()["x-figma-token"]);
        const url = new URL(route.request().url());
        if (url.pathname === `/v1/files/${KEY}/images`)
          return route.fulfill({
            headers: cors,
            json: { error: false, status: 200, meta: { images: { [IMAGE_REF]: IMAGE_URL } } },
          });
        if (url.pathname === `/v1/files/${KEY}`)
          return route.fulfill({ headers: cors, json: figmaFile() });
        return route.fulfill({ status: 404, headers: cors, json: {} });
      });
      await page.route(IMAGE_URL, (route) =>
        route.fulfill({ headers: { ...cors, "content-type": "image/png" }, body: PNG }),
      );

      await startImport(page);
      const row = dialog(page).getByRole("listitem").filter({ hasText: "From Figma" });
      await expect(row).toContainText("6 pages", { timeout: 30_000 });
      await expect(dialog(page).getByRole("button", { name: "Done" })).toBeEnabled();
      expect(blocked).toEqual([]);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.every((token) => token === "figd_test-token")).toBe(true);

      await row.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("tree", { name: "Layers" })).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...(window as unknown as W).drawpane.doc.nodes()].some((n) =>
              JSON.stringify(n.props.fills ?? []).includes('"type":"image"'),
            ),
          ),
        )
        .toBe(true);
      await page.unrouteAll();
      await page.goBack();
    });

    test("explains Figma's limit, from the headers Figma exposes", async () => {
      await page.route("https://api.figma.com/v1/**", (route) =>
        route.fulfill({
          status: 429,
          headers: { ...cors, "retry-after": "7200", "x-figma-plan-tier": "starter" },
          json: { status: 429, err: "Rate limit exceeded" },
        }),
      );
      await startImport(page);
      const message = dialog(page).getByRole("alert");
      await expect(message).toContainText("free plan");
      await expect(message).toContainText("about 2 hours");
      expect(blocked).toEqual([]);
      await page.unrouteAll();
    });
  });
