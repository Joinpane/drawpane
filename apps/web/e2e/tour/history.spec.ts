/**
 * Screenshots of version history for design review: the History tab, a
 * version on the canvas, restoring a layer and the whole file, in both themes.
 * Run with `pnpm --filter @drawpane/web tour`.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { buildMobileApp } from "../prototype-fixture";

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
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

type Debug = {
  commit(ops: unknown[], label?: string): boolean;
  select(ids: string[]): void;
  sync: { pendingCount: number };
};

/** Edits through the debug handle, then waits for the room to have them. */
async function edit(page: Page, ops: unknown[]) {
  await page.evaluate((o) => {
    (window as unknown as { drawpane: Debug }).drawpane.commit(o, "Tour edit");
  }, ops);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.sync.pendingCount),
    )
    .toBe(0);
}

async function saveVersion(page: Page, fileId: string, name: string, keepName = true) {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.sync.pendingCount),
    )
    .toBe(0);
  const version = await page.evaluate(
    async ({ fileId, name }) => {
      const res = await fetch(`/api/files/${fileId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return ((await res.json()) as { version: { id: string } }).version;
    },
    { fileId, name },
  );
  if (!keepName) {
    await page.evaluate(
      async ({ fileId, id }) => {
        await fetch(`/api/files/${fileId}/versions/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: null }),
        });
      },
      { fileId, id: version.id },
    );
  }
  return version.id;
}

const fill = (id: string, color: string) => ({
  op: "set",
  id,
  prop: "fills",
  value: [{ type: "solid", color }],
});

test("history tour", async ({ browser }) => {
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
  const fileId = new URL(page.url()).pathname.split("/").at(-1) as string;

  const ids = await buildMobileApp(page);
  await page.keyboard.press("Shift+1");
  await saveVersion(page, fileId, "First layout", false);
  await edit(page, [{ op: "set", id: ids.row, prop: "name", value: "First event" }]);
  await saveVersion(page, fileId, "Kickoff review");
  await edit(page, [fill(ids.done, "#1f6feb")]);
  await edit(page, [{ op: "set", id: ids.done, prop: "cornerRadius", value: 4 }]);
  await saveVersion(page, fileId, "Blue buttons", false);
  await edit(page, [fill(ids.done, "#0e9f6e"), { op: "delete", id: ids.row }]);

  // The History tab, looking at now.
  await page.getByRole("radio", { name: "History" }).click();
  await expect(page.getByRole("option", { name: /Kickoff review/ })).toBeVisible();
  await shot(page, "50-history-tab");

  // A named version on the canvas.
  await page.getByRole("option", { name: /Kickoff review/ }).click();
  await expect(page.getByText(/read-only/)).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "51-history-viewing");

  // A layer selected in the version: restore it or copy it.
  await page.getByRole("radio", { name: "Layers" }).click();
  // The layers tree only renders rows in view: scroll down to the row.
  const tree = page.getByRole("tree", { name: "Layers" });
  const row = page.getByRole("treeitem", { name: /First event/ }).first();
  for (let i = 0; i < 20 && !(await row.isVisible()); i++) {
    await tree.hover();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(50);
  }
  await row.click();
  await shot(page, "52-history-layer");
  await page.getByRole("button", { name: "Restore layer" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Restored" })).toBeVisible();
  await shot(page, "53-history-layer-restored");

  // The timeline, hovered.
  await page.getByRole("radio", { name: "History" }).click();
  const track = page.getByRole("slider", { name: "Version" });
  const box = await track.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await shot(page, "54-history-scrubber");

  // Restoring the whole file asks first.
  await page
    .getByRole("option", { name: /First layout|edit/ })
    .last()
    .click();
  await expect(page.getByText(/read-only/)).toBeVisible();
  await page.getByRole("button", { name: "Restore this version" }).click();
  await shot(page, "55-history-restore-dialog");
  await page.getByRole("button", { name: "Restore version" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Restored" })).toBeVisible();
  await page.getByRole("option", { name: /Before restoring/ }).waitFor();
  await shot(page, "56-history-restored");

  // Naming the current state.
  await page.getByRole("button", { name: "Name this version" }).click();
  await page.getByLabel("Name", { exact: true }).fill("After the restore");
  await shot(page, "57-history-name");
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(page.getByRole("option", { name: /After the restore/ })).toBeVisible();
});
