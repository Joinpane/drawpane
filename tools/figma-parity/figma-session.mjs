// A Figma file open in a headless browser, with Figma's plugin API on the
// page as `figma`: what build-in-figma.mjs and export-in-figma.mjs work
// through. Figma's web app can't import development plugins, but once any
// plugin has run in a session it exposes its plugin API to the page.
//
// Signs in with FIGMA_EMAIL (or FIGMA_LOGIN_USERNAME) and FIGMA_PASSWORD
// when the session kept in FIGMA_PROFILE isn't signed in already.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../apps/web/package.json"));
const { chromium } = require("@playwright/test");

// biome-ignore-start lint/suspicious/noUndeclaredEnvVars: a tool run by hand, outside every build pipeline.
const email = process.env.FIGMA_EMAIL ?? process.env.FIGMA_LOGIN_USERNAME;
const password = process.env.FIGMA_PASSWORD;
const profile = process.env.FIGMA_PROFILE ?? "/tmp/figma-parity-profile";
// biome-ignore-end lint/suspicious/noUndeclaredEnvVars: a tool run by hand.

/** Opens `link` with `figma` ready on the page, runs `work(page)`, and closes. */
export async function withFigma(link, work) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Figma turns away the headless browser's own user agent.
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto(link, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    if (
      /\/login/.test(page.url()) ||
      (await page.getByRole("button", { name: "Log in" }).count())
    ) {
      if (!email || !password)
        throw new Error("Not signed in: set FIGMA_EMAIL and FIGMA_PASSWORD.");
      await page.goto("https://www.figma.com/login", { waitUntil: "domcontentloaded" });
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("textbox", { name: "Password" }).fill(password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.waitForTimeout(8000);
      await page.goto(link, { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(12000);
    // Any plugin will do: run one from quick actions so the page gets `figma`.
    await page.keyboard.press("Escape");
    await page.mouse.click(720, 500);
    await page.keyboard.press("Control+/");
    await page.waitForTimeout(1200);
    await page.keyboard.type("Scripter", { delay: 50 });
    await page.waitForTimeout(1500);
    await page.getByText("Search plugins & widgets for").click();
    await page.waitForTimeout(3000);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => typeof window.figma === "object", null, { timeout: 30000 });
    return await work(page);
  } finally {
    await context.close();
  }
}
