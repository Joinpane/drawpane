/**
 * Access tokens and the MCP server (decision 0011) in a real browser: make a
 * token in settings, see it once with a ready-to-paste command, read a file
 * through the MCP endpoint with it, and revoke it.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

/** Calls a tool as an MCP client would, with `token`. */
function callTool(page: Page, token: string, name: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ token, name, args }) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "mcp-method": "tools/call",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    },
    { token, name, args },
  );
}

test.describe
  .serial("Access tokens", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let token: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8883, inspectorPort: 9423 });
      page = instance.page;
      // A file to read.
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("makes a token, shown once with a command to paste", async () => {
      await page.goto("/settings/tokens");
      await expect(page.getByRole("heading", { name: "Access tokens" })).toBeVisible();
      await expect(page.getByText("No tokens yet.")).toBeVisible();
      await page.getByRole("button", { name: "New token" }).click();
      await page.getByLabel("Name").fill("Claude Code");
      await page.getByLabel("Expires").selectOption("30");
      await page.getByRole("button", { name: "Make token" }).click();
      const made = page.getByRole("status").filter({ hasText: "You won’t see it again" });
      await expect(made).toBeVisible();
      token = (await made.locator(".tokens__code--secret").textContent()) ?? "";
      expect(token).toMatch(/^dp_pat_/);
      await expect(made).toContainText(`claude mcp add --transport http drawpane`);
      await expect(made).toContainText(`Bearer ${token}`);
      await made.getByRole("button", { name: "Done" }).click();
      // Listed by its prefix, never in full.
      const row = page.getByRole("list", { name: "Your tokens" }).getByRole("listitem");
      await expect(row).toContainText("Claude Code");
      await expect(row).toContainText(token.slice(0, 11));
      await expect(page.locator("body")).not.toContainText(token);
    });

    test("reads files through the MCP server, until revoked", async () => {
      const files = await callTool(page, token, "list_files");
      expect(files.status).toBe(200);
      expect(files.body.result.isError).toBe(false);
      expect(files.body.result.structuredContent.files).toHaveLength(1);
      const [file] = files.body.result.structuredContent.files;
      const outline = await callTool(page, token, "get_outline", { fileId: file.id });
      expect(outline.body.result.structuredContent.pages).toHaveLength(1);

      await page.reload();
      const row = page.getByRole("list", { name: "Your tokens" }).getByRole("listitem");
      await expect(row).toContainText("used");
      await page.getByRole("button", { name: "Revoke Claude Code" }).click();
      await page.getByRole("button", { name: "Revoke Claude Code now" }).click();
      await expect(page.getByText("No tokens yet.")).toBeVisible();
      expect((await callTool(page, token, "list_files")).status).toBe(401);
    });
  });
