/**
 * The pen, vector edit and booleans in a real browser, with the real PathKit
 * WASM. Runs against its own throwaway Worker (port 8789 by default), so it
 * sets up a fresh instance whatever order the specs run in.
 *
 * Set VECTOR_SHOTS=<dir> to also save light and dark screenshots of pen
 * drawing and vector edit for design review.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const external = process.env.E2E_BASE_URL;
const PORT = process.env.E2E_VECTOR_PORT ?? "8789";
const BASE = external ?? `http://localhost:${PORT}`;
const SHOTS = process.env.VECTOR_SHOTS;

let server: ChildProcess | null = null;

async function waitForHealth(url: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The Worker didn't start at ${url}`);
}

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

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
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

test.describe
  .serial("Vectors", () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      if (!external) {
        server = spawn("node", ["e2e/server.mjs"], {
          cwd: resolve(import.meta.dirname, ".."),
          env: { ...process.env, E2E_PORT: PORT },
          stdio: "inherit",
        });
        await waitForHealth(`${BASE}/api/health`, 120_000);
      }
      context = await browser.newContext({ baseURL: BASE });
      page = await context.newPage();
      await addPasskeyDevice(context, page);
      await page.goto("/setup");
      await page.getByLabel("Your name").fill("Ana Lima");
      await page.getByLabel("Email").fill("ana@example.com");
      await page.getByLabel("Setup token").fill(process.env.E2E_SETUP_TOKEN ?? "e2e-setup-token");
      await page.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
    });

    test.afterAll(async () => {
      await context?.close();
      server?.kill("SIGTERM");
    });

    const inspector = () => page.getByRole("group", { name: "Properties" });

    test("draws a triangle with the pen", async () => {
      await page.getByRole("button", { name: "Pen", exact: true }).click();
      await page.mouse.click(600, 300);
      await page.mouse.click(760, 300);
      await page.mouse.move(700, 420, { steps: 3 });
      await shot(page, "pen-drawing");
      await page.mouse.click(680, 440);
      // Clicking the first anchor closes the path.
      await page.mouse.click(600, 300);
      await expect(page.getByRole("treeitem", { name: /Vector 1/ })).toBeVisible();
      await expect(inspector().getByLabel("Width")).toHaveValue("160");
      await expect(inspector().getByLabel("Height")).toHaveValue("140");
      await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    test("edits an anchor in vector edit mode", async () => {
      // Pen paths have no fill: double-click the stroke (the left edge, away from handles).
      await page.mouse.dblclick(640, 370);
      await expect(page.getByRole("note", { name: "Path shortcuts" })).toContainText(
        "break handle",
      );
      // Drag the top-right anchor up and out.
      await drag(page, [760, 300], [800, 260]);
      await expect(inspector().getByLabel("Width")).toHaveValue("200");
      await expect(inspector().getByLabel("Height")).toHaveValue("180");
      // Make the bottom anchor smooth to show its handles, for the screenshot.
      await page.mouse.dblclick(680, 440);
      await shot(page, "vector-edit");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("note", { name: "Path shortcuts" })).toBeHidden();
      // One undo step per edit: undo the smooth point, then the drag.
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(inspector().getByLabel("Width")).toHaveValue("160");
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect(inspector().getByLabel("Width")).toHaveValue("200");
    });

    test("unions two shapes with the WASM engine", async () => {
      await page.keyboard.press("r");
      await drag(page, [840, 300], [940, 400]);
      await page.keyboard.press("o");
      await drag(page, [900, 350], [1000, 450]);
      // Marquee from empty space to select both.
      await drag(page, [830, 285], [1010, 470]);
      await expect(page.getByRole("heading", { name: "2 layers" })).toBeVisible();
      await page
        .getByRole("group", { name: "Combine shapes" })
        .getByRole("button", { name: "Union" })
        .click();
      await expect(page.getByRole("treeitem", { name: /^Union/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("treeitem", { name: /Rectangle 1/ })).toBeHidden();
      await expect(inspector().getByLabel("Width")).toHaveValue("160");
      await expect(inspector().getByLabel("Height")).toHaveValue("150");
      await expect(page.getByRole("status")).toContainText("Saved");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByRole("treeitem", { name: /Rectangle 1/ })).toBeVisible();
      await expect(page.getByRole("treeitem", { name: /Ellipse 1/ })).toBeVisible();
    });
  });
