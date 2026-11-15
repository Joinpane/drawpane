/**
 * Screenshots of SVG import, for design review: an Illustrator-style badge
 * dropped on the canvas as a frame of editable layers (the layers panel
 * shows its groups, shapes and vectors), and the notice after pasting
 * markup with a filter Drawpane can't draw, in both themes. Run with
 * `pnpm --filter @drawpane/web tour`.
 */
import { expect } from "@playwright/test";
import { passkey, shot, test } from "./harness";

const BADGE = `<?xml version="1.0" encoding="UTF-8"?>
<svg id="Layer_1" data-name="Badge" xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 100 100">
  <defs><style>.a{fill:#1d3557}.b{fill:none;stroke:#f1faee;stroke-width:3px}.c{fill:#e63946}.d{fill:#a8dadc;opacity:.8}</style></defs>
  <g data-name="Seal">
    <polygon class="a" data-name="Rosette" points="50 4 61 18 79 15 81 33 96 43 85 58 90 76 72 80 64 96 50 86 36 96 28 80 10 76 15 58 4 43 19 33 21 15 39 18 50 4"/>
    <circle class="b" data-name="Ring" cx="50" cy="50" r="28"/>
    <rect class="c" data-name="Diamond" x="38" y="38" width="24" height="24" transform="translate(50 -20.71) rotate(45)"/>
    <ellipse class="d" data-name="Shine" cx="50" cy="50" rx="10" ry="5" transform="rotate(30 50 50)"/>
  </g>
</svg>`;

test("svg import tour", async ({ browser }) => {
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

  // Dropped like a file from the desktop.
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "badge.svg", { type: "image/svg+xml" }));
    const target = document.querySelector(".canvas__overlay");
    const init = {
      dataTransfer: data,
      clientX: 720,
      clientY: 420,
      bubbles: true,
      cancelable: true,
    };
    target?.dispatchEvent(new DragEvent("drop", init));
  }, BADGE);
  await expect(page.getByRole("treeitem", { name: "Seal" })).toBeVisible();
  await page.getByRole("treeitem", { name: "Diamond" }).click();
  await shot(page, "179-svg-dropped-as-layers");

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><filter id="grain"><feTurbulence baseFrequency=".8"/></filter><rect width="120" height="80" rx="16" fill="#f4a259" filter="url(#grain)"/></svg>',
    );
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByRole("alert")).toContainText("1 filter effect was left out");
  await shot(page, "180-svg-paste-notice");
  await context.close();
});
