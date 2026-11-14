/**
 * The inbox: someone mentions you, your sidebar says so, the inbox lists it,
 * opening it takes you to the comment in its file, and it's read. A reply in
 * a thread you started arrives too, and Mark all read clears everything.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { addPasskey, freshInstance, type Instance } from "./fresh-instance";

type W = { drawpane: { s: { pageId: string } } };

test.describe
  .serial("Inbox", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let ana: Page;
    let boContext: BrowserContext;
    let bo: Page;
    let fileId: string;
    let pageId: string;
    let anaId: string;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8857, inspectorPort: 9397 });
      ana = instance.page;
      // Ana makes a file and invites Bo.
      await ana.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await ana.getByRole("button", { name: "New file" }).first().click();
      await expect(ana.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      fileId = new URL(ana.url()).pathname.split("/").at(-1) as string;
      pageId = await ana.evaluate(() => (window as unknown as W).drawpane.s.pageId);
      const invite = await ana.evaluate(async () => {
        const { teams } = await (await fetch("/api/teams")).json();
        const response = await fetch(`/api/teams/${teams[0].id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "editor" }),
        });
        return (await response.json()).url as string;
      });
      anaId = await ana.evaluate(async () => (await (await fetch("/api/session")).json()).user.id);
      boContext = await browser.newContext({ baseURL: instance.url });
      bo = await boContext.newPage();
      await addPasskey(boContext, bo);
      await bo.goto(new URL(invite).pathname);
      await bo.getByLabel("Your name").fill("Bo Chen");
      await bo.getByLabel("Email").fill("bo@example.com");
      await bo.getByRole("button", { name: "Create account with a passkey" }).click();
      await expect(bo.getByRole("heading", { name: "Recent files" })).toBeVisible();
      await ana.goto("/");
    });

    test.afterAll(async () => {
      await boContext?.close();
      await instance?.stop();
    });

    test("a mention shows in the sidebar and the inbox, and opens at its comment", async () => {
      // Bo mentions Ana in a comment on her file.
      await bo.evaluate(
        async ({ fileId, pageId, anaId }) => {
          await fetch(`/api/files/${fileId}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pageId,
              x: 200,
              y: 160,
              body: "@Ana Lima can we tighten the header spacing?",
              mentions: [anaId],
            }),
          });
        },
        { fileId, pageId, anaId },
      );
      const inbox = ana.getByRole("link", { name: /^Inbox/ });
      await ana.reload();
      await expect(inbox).toContainText("1 unread");

      await inbox.click();
      await expect(ana.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
      const item = ana
        .getByRole("region", { name: "Notifications" })
        .getByRole("link", { name: /Bo Chen mentioned you in Untitled/ });
      await expect(item).toContainText("can we tighten the header spacing?");
      await expect(item).toContainText("Unread");

      // It opens the file at the comment, and the address loses the link.
      await item.click();
      await expect(ana.getByRole("dialog", { name: /^Thread on/ })).toBeVisible({
        timeout: 15_000,
      });
      await expect(ana).toHaveURL(new RegExp(`/f/${fileId}$`));

      // Back on the dashboard: read, so no badge, and Unread is empty.
      await ana.goto("/");
      await expect(inbox).not.toContainText("unread");
      await inbox.click();
      await expect(ana.getByText("You're all caught up.")).toBeVisible();
      await ana.getByRole("radio", { name: "All" }).click();
      await expect(ana.getByRole("link", { name: /Bo Chen mentioned you/ })).not.toContainText(
        "Unread",
      );
    });

    test("a reply in your thread arrives while you're in a file; mark all read clears it", async () => {
      // Ana starts a thread, then opens her file; Bo replies.
      const threadId = await ana.evaluate(
        async ({ fileId, pageId }) => {
          const response = await fetch(`/api/files/${fileId}/comments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pageId, x: 40, y: 40, body: "Is the logo too small?" }),
          });
          return (await response.json()).thread.id as string;
        },
        { fileId, pageId },
      );
      await ana.goto(`/f/${fileId}`);
      await expect(ana.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await bo.evaluate(
        async ({ fileId, threadId }) => {
          await fetch(`/api/files/${fileId}/comments/${threadId}/replies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: "A little. Try 48." }),
          });
        },
        { fileId, threadId },
      );
      // Bo's reply in her thread notifies her.
      await expect
        .poll(() =>
          ana.evaluate(
            async () => (await (await fetch("/api/notifications/unread")).json()).unread,
          ),
        )
        .toBe(1);
      await ana.goto("/");
      const inbox = ana.getByRole("link", { name: /^Inbox/ });
      await expect(inbox).toContainText("1 unread");
      await inbox.click();
      await expect(ana.getByRole("link", { name: /Bo Chen replied in Untitled/ })).toContainText(
        "A little. Try 48.",
      );
      await ana.getByRole("button", { name: "Mark all read" }).click();
      await expect(inbox).not.toContainText("unread");
      await expect(ana.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    });
  });
