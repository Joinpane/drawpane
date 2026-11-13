/**
 * Comments, end to end: drop a pin on a layer, reply with an @mention from a
 * second account (a viewer), see it live, resolve, and find it again in the
 * panel.
 *
 * The regular suite's instance is set up by editor.spec.ts, and that
 * account's passkey disappears with its browser context, so this spec starts
 * its own Worker with a fresh database on another port.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

const PORT = process.env.E2E_COMMENTS_PORT ?? String(Number(process.env.E2E_PORT ?? "8788") + 1);
const BASE = `http://localhost:${PORT}`;
const SETUP_TOKEN = "e2e-setup-token";

test.skip(!!process.env.E2E_BASE_URL, "Needs a fresh local instance of its own.");
test.use({ baseURL: BASE });

let server: ChildProcess | null = null;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = spawn("node", [resolve(import.meta.dirname, "server.mjs")], {
    env: { ...process.env, E2E_PORT: PORT },
    stdio: "inherit",
  });
  const deadline = Date.now() + 110_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("The comments test server didn't start.");
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

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

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

test("comments: pin, reply with a mention, live updates, resolve, find again", async ({
  browser,
}) => {
  test.setTimeout(120_000);

  // Ana sets up the instance and draws a layer to comment on.
  const anaContext = await browser.newContext();
  const ana = await anaContext.newPage();
  await addPasskeyDevice(anaContext, ana);
  await ana.goto("/setup");
  await ana.getByLabel("Your name").fill("Ana Lima");
  await ana.getByLabel("Email").fill("ana@example.com");
  await ana.getByLabel("Setup token").fill(SETUP_TOKEN);
  await ana.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(ana.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await ana.getByRole("button", { name: "New file" }).first().click();
  await expect(ana.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  const fileUrl = ana.url();

  await ana.keyboard.press("r");
  await ana.mouse.move(600, 300);
  await ana.mouse.down();
  await ana.mouse.move(700, 380, { steps: 5 });
  await ana.mouse.move(760, 420, { steps: 5 });
  await ana.mouse.up();
  await expect(ana.getByRole("treeitem", { name: /Rectangle 1/ })).toBeVisible();

  // C picks the comment tool and opens the panel; a click drops a pin on the layer.
  await ana.keyboard.press("c");
  await expect(ana.getByRole("button", { name: "Comment", pressed: true })).toBeVisible();
  const anaPanel = ana.getByRole("complementary", { name: "Comments" });
  await expect(anaPanel.getByText("No open comments on this page.")).toBeVisible();
  await ana.mouse.click(680, 360);
  const draft = ana.getByRole("dialog", { name: "New comment on Rectangle 1 · Page 1" });
  await expect(draft).toBeVisible();
  // Escape throws away an empty draft.
  await ana.keyboard.press("Escape");
  await expect(draft).toBeHidden();
  await ana.mouse.click(680, 360);
  await expect(draft.getByRole("combobox", { name: "Comment" })).toBeFocused();
  await ana.keyboard.type("Should the hero follow the brand blue?");
  await ana.keyboard.press("ControlOrMeta+Enter");

  const anaThread = ana.getByRole("dialog", { name: "Thread on Rectangle 1 · Page 1" });
  await expect(anaThread.getByText("Should the hero follow the brand blue?")).toBeVisible();
  const anaPin = ana.getByRole("button", { name: /^Comment by Ana Lima/ });
  await expect(anaPin).toBeVisible();
  await expect(anaPanel.getByRole("button", { name: /Should the hero follow/ })).toBeVisible();

  // Escape closes the thread and returns focus to its pin; Escape again leaves the tool.
  await ana.keyboard.press("Escape");
  await expect(anaThread).toBeHidden();
  await expect(anaPin).toBeFocused();
  await ana.keyboard.press("Escape");
  await expect(ana.getByRole("button", { name: "Move", pressed: true })).toBeVisible();

  // The pin follows its layer.
  const before = await box(anaPin);
  await ana.mouse.click(620, 405);
  await expect(ana.getByRole("treeitem", { name: /Rectangle 1/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  for (let i = 0; i < 5; i++) await ana.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(async () => Math.round((await box(anaPin)).x - before.x), { timeout: 5_000 })
    .toBe(50);

  // Ana invites Bo as a viewer. Viewers can comment.
  const invite = await ana.evaluate(async () => {
    const { teams } = (await (await fetch("/api/teams")).json()) as { teams: { id: string }[] };
    const response = await fetch(`/api/teams/${teams[0]?.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    });
    return ((await response.json()) as { url: string }).url;
  });
  const boContext = await browser.newContext();
  const bo = await boContext.newPage();
  await addPasskeyDevice(boContext, bo);
  await bo.goto(new URL(invite).pathname);
  await bo.getByLabel("Your name").fill("Bo Chen");
  await bo.getByLabel("Email").fill("bo@example.com");
  await bo.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(bo.getByRole("heading", { name: "Recent files" })).toBeVisible();
  await bo.goto(new URL(fileUrl).pathname);
  await expect(bo.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
  await expect(bo.getByRole("button", { name: "Comment", exact: true })).toBeVisible();

  // Bo opens Ana's pin and replies, mentioning her from the @ list.
  const boPin = bo.getByRole("button", { name: /^Comment by Ana Lima/ });
  await boPin.click();
  const boThread = bo.getByRole("dialog", { name: "Thread on Rectangle 1 · Page 1" });
  const boReply = boThread.getByRole("combobox", { name: "Reply" });
  await expect(boReply).toBeFocused();
  await bo.keyboard.type("Looks good. Can @An");
  const people = bo.getByRole("listbox", { name: "People" });
  await expect(people.getByRole("option", { name: "Ana Lima" })).toBeVisible();
  await bo.keyboard.press("Enter");
  await expect(people).toBeHidden();
  await bo.keyboard.type("check the contrast?");
  await expect(boReply).toHaveValue("Looks good. Can @Ana Lima check the contrast?");
  await bo.keyboard.press("ControlOrMeta+Enter");
  await expect(boReply).toHaveValue("");

  // Ana sees the reply without reloading, and her name is the mention.
  await anaPin.click();
  await expect(anaThread.getByText("check the contrast?")).toBeVisible({ timeout: 10_000 });
  await expect(anaThread.locator(".comment-mention--you")).toHaveText("@Ana Lima");
  await expect(anaPin).toHaveAccessibleName("Comment by Ana Lima, 1 reply");

  // Bo edits his reply from the author menu.
  await boThread.getByText("check the contrast?").hover();
  await boThread.getByRole("button", { name: "Options for Bo Chen's comment" }).click();
  await bo.getByRole("menuitem", { name: "Edit" }).click();
  const edit = boThread.getByRole("combobox", { name: "Edit comment" });
  await edit.press("End");
  await edit.pressSequentially(" Thanks.");
  await boThread.getByRole("button", { name: /^Save/ }).click();
  await expect(anaThread.getByText(/check the contrast\? Thanks\./)).toBeVisible({
    timeout: 10_000,
  });
  await expect(anaThread.getByText("· edited")).toBeVisible();

  // Focus mode keeps other people's pins, calmly.
  await bo.keyboard.press("Escape");
  await expect(boThread).toBeHidden();
  await bo.keyboard.press("Shift+F");
  await expect(boPin).toHaveAttribute("data-calm", "true");

  // Ana resolves; it leaves Bo's open pins and moves to "Resolved".
  await anaThread.getByRole("button", { name: "Resolve thread" }).click();
  await expect(anaThread.getByText("Resolved by Ana Lima")).toBeVisible();
  await expect(boPin).toBeHidden({ timeout: 10_000 });
  await ana.keyboard.press("Escape");
  await expect(anaPin).toBeHidden();
  await expect(anaPanel.getByText("No open comments on this page.")).toBeVisible();
  await anaPanel.getByRole("radio", { name: "Resolved" }).click();
  const row = anaPanel.getByRole("button", { name: /Should the hero follow/ });
  await expect(row).toContainText("Resolved by Ana Lima");

  // Clicking a thread in the panel brings its pin into view and opens it.
  await ana.keyboard.press("Shift+1");
  await row.click();
  await expect(anaThread).toBeVisible();
  const pin = ana.getByRole("button", { name: /^Resolved comment by Ana Lima/ });
  const pinBox = await box(pin);
  expect(Math.abs(pinBox.x - (276 + (1440 - 276 - 276) / 2))).toBeLessThan(40);
  await anaThread.getByRole("button", { name: "Reopen thread" }).click();
  await expect(anaThread.getByText("Resolved by Ana Lima")).toBeHidden();

  await boContext.close();
  await anaContext.close();
});
