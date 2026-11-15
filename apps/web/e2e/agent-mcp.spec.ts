/**
 * An agent designing in a file a person has open (decision 0021): the person
 * makes a read and write token in settings, an MCP client (this test, over
 * HTTP) starts a live session and renders a card, and the person sees it
 * arrive in their canvas and layers; the agent's undo takes it away again.
 * The test Worker measures text with the stand-in measurer (server.mjs).
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type W = {
  drawpane: {
    doc: { get(id: string): { props: Record<string, unknown> } | undefined };
  };
};

const tree = (page: Page) => page.getByRole("tree", { name: "Layers" });

test.describe
  .serial("An agent designing over MCP", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let page: Page;
    let token: string;
    let rpcId = 1;

    /** One tool call, as an MCP client sends it: from outside the browser, with the token. */
    async function callTool(name: string, args: Record<string, unknown>) {
      const res = await fetch(`${instance.url}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(res.status).toBe(200);
      const { result } = (await res.json()) as {
        result: { isError: boolean; structuredContent: Record<string, unknown> };
      };
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
      return result.structuredContent;
    }

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 9007, inspectorPort: 9547 });
      page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    });

    test.afterAll(async () => {
      await instance?.stop();
    });

    test("a read and write token is made in settings", async () => {
      await page.goto("/settings/tokens");
      await page.getByRole("button", { name: "New token" }).click();
      await page.getByLabel("Name").fill("Claude Code");
      // Read only unless chosen otherwise.
      await expect(page.getByRole("radio", { name: "Read only" })).toBeChecked();
      await page.getByRole("radio", { name: "Read and write" }).check();
      await expect(page.getByText("Also designs in files you can edit")).toBeVisible();
      await page.getByRole("button", { name: "Make token" }).click();
      const made = page.getByRole("status").filter({ hasText: "You won’t see it again" });
      token = (await made.locator(".tokens__code--secret").textContent()) ?? "";
      expect(token).toMatch(/^dp_pat_/);
      await made.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("list", { name: "Your tokens" })).toContainText("read and write");
    });

    test("the person sees the agent's card arrive, and its undo take it away", async () => {
      await page.goto("/");
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const fileId = /\/f\/([^/?#]+)/.exec(page.url())?.[1] as string;
      expect(fileId).toBeTruthy();

      const session = await callTool("start_session", { fileId, mode: "live", name: "Claude" });
      expect(session.name).toBe("Claude, for Ana");
      const rendered = await callTool("render", {
        sessionId: session.sessionId,
        jsx: `<Frame name="Plan card" flex="col" gap={8} p={16} fill="#ffffff" radius={12} w={240}>
          <Text size={20} weight={600}>Pro plan</Text>
          <Text size={14}>Everything in Free, and more.</Text>
        </Frame>`,
      });
      const cardId = (rendered.ids as string[])[0] as string;

      // It arrives in the open editor, laid out: the card hugs its two lines of text.
      await expect(tree(page).getByRole("treeitem", { name: /Plan card/ })).toBeVisible();
      const height = await page.evaluate(
        (id) => (window as unknown as W).drawpane.doc.get(id)?.props.height,
        cardId,
      );
      expect(Number(height)).toBeGreaterThan(16 + 16 + 8);

      await callTool("undo", { sessionId: session.sessionId });
      await expect(tree(page).getByRole("treeitem", { name: /Plan card/ })).toHaveCount(0);
      expect(
        await page.evaluate((id) => (window as unknown as W).drawpane.doc.get(id), cardId),
      ).toBeUndefined();
      await callTool("end_session", { sessionId: session.sessionId });
    });
  });
