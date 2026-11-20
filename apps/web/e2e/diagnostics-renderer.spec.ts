/**
 * Standalone renderer diagnostics page (`/diagnostics/renderer`):
 * loads without sign-in, opts out of indexing (`X-Robots-Tag` and `<meta name="robots">`),
 * keeps protected routes authenticated, makes zero `/api/*` requests, renders every
 * diagnostic cell against the shipped CPU-oracle PNGs, verifies "Copy report" writes to the
 * clipboard, and checks WebGPU (when available), WebGL2, and CPU modes.
 */
import { expect, test } from "@playwright/test";

if (!process.env.ENGINE_BROWSER || process.env.ENGINE_BROWSER === "chromium") {
  test.use({
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-unsafe-swiftshader",
        ...(process.env.ENGINE_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      ],
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
  });
}

test.describe("Renderer diagnostics page", () => {
  test("opts out of indexing and preserves auth on adjacent protected routes", async ({
    page,
    request,
  }) => {
    const response = await page.goto("/diagnostics/renderer?software=1");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["x-robots-tag"]).toMatch(/noindex/i);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);

    const privateFile = await request.get("/api/files/review-private-file");
    expect(privateFile.status()).toBe(401);
    await page.goto("/f/review-private-file");
    await expect(page).toHaveURL(/\/(setup|signin)\?/);
  });

  test("loads without auth or API calls, passes all cells, and copies the report", async ({
    browserName,
    context,
    page,
  }) => {
    test.setTimeout(180_000);
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    }
    const apiRequests: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/")) apiRequests.push(path);
    });

    await page.goto("/diagnostics/renderer?software=1");
    await expect(page.getByRole("heading", { name: "Render engine diagnostics" })).toBeVisible();
    await expect(page.getByTestId("diag-summary")).toContainText("10/10 passed", {
      timeout: 60_000,
    });

    // Zero API requests made (fully self-contained standalone diagnostics page).
    expect(apiRequests).toEqual([]);

    const backend = (await page.getByTestId("diag-backend").textContent())?.trim() ?? "";
    expect(["webgpu", "webgl2", "cpu"]).toContain(backend);

    // Every cell shows Pass.
    const cells = page.locator("article.diag__cell");
    await expect(cells).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(cells.nth(i)).toContainText("Pass");
    }

    // Raw report contains structured Markdown + JSON with all 10 cells.
    const report = (await page.getByTestId("diag-report").textContent()) ?? "";
    expect(report).toContain("# Drawpane Renderer Diagnostics");
    expect(report).toContain("gradients-angular-diamond");
    expect(report).toContain("corner-smoothing");
    expect(report).toContain("text-stroke-outside");

    // Clicking "Copy report" confirms copy state and writes the exact report to the clipboard.
    await page.getByRole("button", { name: "Copy report" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    if (browserName === "chromium") {
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toBe(report);
    }

    // Exercise forced WebGPU when this browser exposes a WebGPU adapter, plus WebGL2 and CPU.
    const hasWebGpuAdapter = await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu) return false;
      try {
        return (await gpu.requestAdapter()) !== null;
      } catch {
        return false;
      }
    });
    const modes: string[] = [];
    if (hasWebGpuAdapter) modes.push("WebGPU");
    modes.push("WebGL2", "CPU");

    for (const label of modes) {
      await page.getByRole("radio", { name: label }).click();
      await expect(page.getByTestId("diag-backend")).toHaveText(label.toLowerCase(), {
        timeout: 60_000,
      });
      await expect(page.getByTestId("diag-summary")).toContainText("10/10 passed", {
        timeout: 60_000,
      });
    }
  });
});
