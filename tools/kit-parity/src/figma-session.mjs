// A Figma file open in a headless browser with Figma's plugin API on the
// page as `figma`, for reading only. It works like
// tools/figma-parity/figma-session.mjs (once any plugin has run, the page
// exposes the plugin API), with guards for a file that must not change:
//
// - Keys are typed only once the quick actions box is open, so a missed
//   shortcut can't land on the canvas as tool shortcuts.
// - Every page visited is watched for changes (`nodechange`); `assertUnchanged`
//   throws on any change made from this session, so the run stops.
// - The document's plugin data keys are compared at the end.
//
// Signs in with FIGMA_EMAIL (or FIGMA_LOGIN_USERNAME) and FIGMA_PASSWORD
// when the session kept in FIGMA_PROFILE isn't signed in already.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../apps/web/package.json"));
const { chromium } = require("@playwright/test");

// biome-ignore-start lint/suspicious/noUndeclaredEnvVars: a tool run by hand, outside every build pipeline.
const email = process.env.FIGMA_EMAIL ?? process.env.FIGMA_LOGIN_USERNAME;
const password = process.env.FIGMA_PASSWORD;
const profile = process.env.FIGMA_PROFILE ?? "/tmp/figma-parity-profile";
// biome-ignore-end lint/suspicious/noUndeclaredEnvVars: a tool run by hand.

/** Thrown when the file changed while it was being read: the run must stop. */
export class FileChanged extends Error {}

async function signIn(page, link) {
  if (!email || !password) throw new Error("Not signed in: set FIGMA_EMAIL and FIGMA_PASSWORD.");
  await page.goto("https://www.figma.com/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForTimeout(8000);
  if (/\/login/.test(page.url()))
    throw new Error("Figma's sign-in didn't go through (a captcha or a second factor?).");
  await page.goto(link, { waitUntil: "domcontentloaded" });
}

/** Opens `link` with `figma` ready on the page, runs `work(page, guard)`, and closes. */
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
      (await page.getByRole("button", { name: "Log in" }).count()) ||
      (await page.getByRole("button", { name: "Sign up" }).count())
    )
      await signIn(page, link);
    // A large file takes a while: wait for its pages list.
    await page.getByText("Pages", { exact: true }).first().waitFor({ timeout: 180_000 });
    await page.waitForTimeout(5000);
    if (await page.getByRole("button", { name: "Ask to edit" }).count())
      throw new Error(
        "This account can only view the file, and Figma runs no plugins there: it needs edit access.",
      );
    // Any plugin will do: run one from quick actions so the page gets `figma`.
    // Quick actions focuses its search box; only then do keys go there and not to the canvas.
    const focused = () =>
      page
        .waitForFunction(() => document.activeElement?.tagName === "INPUT", null, {
          timeout: 10_000,
        })
        .then(() => true)
        .catch(() => false);
    let open = false;
    for (let attempt = 0; attempt < 3 && !open; attempt++) {
      await page.keyboard.press("Escape");
      await page.mouse.click(720, 120);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+/");
      open = await focused();
      if (!open) await page.waitForTimeout(5000);
    }
    if (!open) {
      await page.screenshot({ path: join(profile, "..", "kit-parity-quick-actions.png") });
      throw new Error("Quick actions didn't open; nothing was typed.");
    }
    await page.keyboard.type("Scripter", { delay: 50 });
    await page.getByText("Search plugins & widgets for").click({ timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => typeof window.figma === "object", null, { timeout: 60_000 });
    await page.keyboard.press("Escape");

    const pluginKeys = () =>
      page.evaluate(() => {
        const root = window.figma.root;
        const shared = root
          .getSharedPluginDataNamespaces?.()
          ?.flatMap((ns) => root.getSharedPluginDataKeys(ns).map((k) => `${ns}/${k}`));
        // Private plugin data needs a plugin id, which this session has none of: only shared data
        // can be written from here, so only shared data is compared.
        return JSON.stringify(shared ?? []);
      });
    const keysBefore = await pluginKeys();
    await page.evaluate(() => {
      window.__kitParityChanges = [];
      window.__kitParityWatched = new Set();
      window.__kitParityWatch = (pageNode) => {
        if (window.__kitParityWatched.has(pageNode.id)) return;
        window.__kitParityWatched.add(pageNode.id);
        pageNode.on("nodechange", (event) => {
          for (const c of event.nodeChanges)
            if (c.origin === "LOCAL")
              window.__kitParityChanges.push(`${c.type} ${c.id} ${c.properties?.join(",") ?? ""}`);
        });
      };
      window.__kitParityWatch(window.figma.currentPage);
    });
    const guard = {
      /** Throws when anything in the file changed from this session. */
      async assertUnchanged() {
        const changes = await page.evaluate(() => window.__kitParityChanges);
        if (changes.length > 0)
          throw new FileChanged(
            `The Figma file changed while being read (${changes.length} changes, first: ${changes[0]}). Stopped.`,
          );
      },
    };
    const result = await work(page, guard);
    await guard.assertUnchanged();
    if ((await pluginKeys()) !== keysBefore)
      throw new FileChanged(
        "Plugin data on the Figma document changed while it was read. Stopped.",
      );
    return result;
  } finally {
    await context.close();
  }
}
