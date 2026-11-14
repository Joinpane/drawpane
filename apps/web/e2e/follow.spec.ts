/**
 * Following and spotlight with two people in two browsers: Bo follows Ana's
 * view across a pan and a page change, stops with Escape, then follows her
 * spotlight; when she leaves, he's told. Runs on its own throwaway instance.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "./fresh-instance";

type View = { x: number; y: number; width: number; height: number };
type Debug = {
  s: { pageId: string; following: string | null };
  presence(cursor: null): { viewport: View | null };
  setCamera(c: unknown): void;
  zoomBy(f: number): void;
  addPage(): void;
  doc: { pageIds(): string[] };
};

/** The page area a person's screen shows, rounded. */
const shown = (page: Page) =>
  page.evaluate(() => {
    const v = (window as unknown as { drawpane: Debug }).drawpane.presence(null).viewport as View;
    return { cx: Math.round(v.x + v.width / 2), cy: Math.round(v.y + v.height / 2) };
  });
const state = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { drawpane: Debug }).drawpane;
    return { page: e.s.pageId, following: e.s.following };
  });

async function joinAs(browser: Browser, url: string, invite: string, name: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: url });
  const page = await context.newPage();
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
  await page.goto(new URL(invite).pathname);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(`${name.split(" ")[0]?.toLowerCase()}@example.com`);
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
  return page;
}

test.describe
  .serial("Following", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");

    let instance: Instance;
    let ana: Page;
    let bo: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240_000);
      instance = await freshInstance(browser, { port: 8775, inspectorPort: 9315 });
      ana = instance.page;
      await ana.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await ana.getByRole("button", { name: "New file" }).first().click();
      await expect(ana.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      const fileUrl = ana.url();
      const invite = await ana.evaluate(async () => {
        const { teams } = (await (await fetch("/api/teams")).json()) as { teams: { id: string }[] };
        const response = await fetch(`/api/teams/${teams[0]?.id}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "editor" }),
        });
        return ((await response.json()) as { url: string }).url;
      });
      bo = await joinAs(browser, instance.url, invite, "Bo Chen");
      await bo.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      await bo.goto(new URL(fileUrl).pathname);
      await expect(bo.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(ana.getByRole("group", { name: /1 person in this file/ })).toBeVisible();
    });

    test.afterAll(async () => {
      await bo?.context().close();
      await instance?.stop();
    });

    test("Bo follows Ana's view, across a pan and a page change", async () => {
      await bo.getByRole("button", { name: /^Follow Ana Lima/ }).click();
      await expect(bo.getByRole("button", { name: /Following Ana Lima/ })).toBeVisible();
      // Ana moves her view; Bo's screen centres where hers does.
      await ana.evaluate(() => {
        const e = (
          window as unknown as {
            drawpane: Debug & { s: { camera: { pan(x: number, y: number): unknown } } };
          }
        ).drawpane;
        e.setCamera(e.s.camera.pan(-600, -300));
      });
      const target = await shown(ana);
      await expect.poll(() => shown(bo)).toEqual(target);
      // A new page: Bo goes there too.
      await ana.evaluate(() => (window as unknown as { drawpane: Debug }).drawpane.addPage());
      const anaPage = (await state(ana)).page;
      await expect.poll(async () => (await state(bo)).page).toBe(anaPage);
      expect((await state(bo)).following).not.toBeNull();
    });

    test("Escape stops following", async () => {
      await bo.locator(".canvas__overlay").hover();
      await bo.keyboard.press("Escape");
      await expect.poll(async () => (await state(bo)).following).toBeNull();
      await expect(bo.getByRole("button", { name: /Following Ana Lima/ })).toHaveCount(0);
    });

    test("an idle cursor fades from the other person's screen, and comes back when it moves", async () => {
      test.setTimeout(30_000);
      const overlay = bo.locator(".canvas__overlay");
      const box = await overlay.boundingBox();
      if (!box) throw new Error("no canvas");
      /** How opaque Bo's cursor is on Ana's overlay, just inside its arrow. */
      const boOnAna = () =>
        ana.evaluate(() => {
          const e = (
            window as unknown as {
              drawpane: {
                s: {
                  peers: Map<
                    string,
                    { presence: { cursor: { x: number; y: number } | null } | null }
                  >;
                  camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
                };
              };
            }
          ).drawpane;
          const cursor = [...e.s.peers.values()][0]?.presence?.cursor;
          const canvas = document.querySelector<HTMLCanvasElement>(".canvas__overlay");
          const ctx = canvas?.getContext("2d");
          if (!cursor || !canvas || !ctx) return -1;
          const p = e.s.camera.toScreen(cursor);
          const k = canvas.width / canvas.getBoundingClientRect().width;
          return ctx.getImageData((p.x + 2) * k, (p.y + 7) * k, 1, 1).data[3] ?? 0;
        });
      await bo.mouse.move(box.x + 400, box.y + 300);
      await bo.mouse.move(box.x + 420, box.y + 310, { steps: 3 });
      await expect.poll(boOnAna).toBeGreaterThan(200);
      const still = Date.now();
      // Calm: once Bo has been still a few seconds, his cursor is gone from Ana's view.
      await expect.poll(boOnAna, { timeout: 8_000 }).toBe(0);
      expect(Date.now() - still).toBeGreaterThan(2_500);
      // And back the moment he moves.
      await bo.mouse.move(box.x + 440, box.y + 320, { steps: 3 });
      await expect.poll(boOnAna).toBeGreaterThan(200);
    });

    test("scrolling under a still pointer moves the cursor others see", async () => {
      const overlay = bo.locator(".canvas__overlay");
      const box = await overlay.boundingBox();
      if (!box) throw new Error("no canvas");
      /** Bo's cursor as Ana's copy of his presence has it. */
      const boOnAna = () =>
        ana.evaluate(() => {
          const e = (
            window as unknown as {
              drawpane: {
                s: { peers: Map<string, { presence: { cursor: { y: number } | null } | null }> };
              };
            }
          ).drawpane;
          return [...e.s.peers.values()][0]?.presence?.cursor?.y ?? null;
        });
      await bo.mouse.move(box.x + 300, box.y + 300, { steps: 3 });
      await expect.poll(boOnAna).not.toBeNull();
      const before = (await boOnAna()) as number;
      // The wheel scrolls the canvas; the pointer stays where it is on screen.
      await bo.mouse.wheel(0, 600);
      await expect.poll(async () => ((await boOnAna()) as number) - before).toBeGreaterThan(300);
    });

    test("Ana spotlights; Bo is asked, follows, and is told when she leaves", async () => {
      await ana.getByRole("button", { name: "People in this file" }).click();
      await ana.getByRole("button", { name: "Spotlight me" }).click();
      await expect(
        ana.getByRole("status").filter({ hasText: "You're spotlighting" }),
      ).toBeVisible();
      const prompt = bo.getByRole("region", { name: "Ana Lima wants to spotlight" });
      await expect(prompt).toBeVisible();
      await prompt.getByRole("button", { name: "Follow Ana" }).click();
      await expect.poll(async () => (await state(bo)).following).not.toBeNull();
      await expect(ana.getByRole("status").filter({ hasText: "1 person follows" })).toBeVisible();

      await ana.close();
      await expect(bo.getByRole("alert")).toContainText(
        "Ana Lima left the file, so you stopped following.",
        {
          timeout: 15_000,
        },
      );
    });
  });
