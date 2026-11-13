/**
 * A throwaway Drawpane instance for one spec file: its own Worker, port and
 * database, set up with a passkey owner. Specs that need a signed-in owner
 * use this instead of the shared server, whose setup editor.spec.ts claims.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export interface Instance {
  readonly url: string;
  readonly context: BrowserContext;
  readonly page: Page;
  stop(): Promise<void>;
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The test Worker exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The test Worker at ${url} didn't start in time.`);
}

/** Starts a Worker on `port` and signs a new owner in with a virtual passkey. */
export async function freshInstance(
  browser: Browser,
  { port, inspectorPort }: { port: number; inspectorPort: number },
): Promise<Instance> {
  const url = `http://localhost:${port}`;
  const child = spawn("node", [resolve(import.meta.dirname, "server.mjs")], {
    env: { ...process.env, E2E_PORT: String(port), E2E_INSPECTOR_PORT: String(inspectorPort) },
    stdio: "inherit",
    detached: true,
  });
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    // The whole group: wrangler starts workerd, which would otherwise keep the port.
    process.kill(-child.pid, "SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
  try {
    await waitForHealth(url, child, 120_000);
    const context = await browser.newContext({ baseURL: url, acceptDownloads: true });
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
    await page.goto("/setup");
    await page.getByLabel("Your name").fill("Ana Lima");
    await page.getByLabel("Email").fill("ana@example.com");
    await page.getByLabel("Setup token").fill("e2e-setup-token");
    await page.getByRole("button", { name: "Create account with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
    return {
      url,
      context,
      page,
      stop: async () => {
        await context.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A PNG made in the page, as a File dropped onto the canvas at a screen point. */
export async function dropImage(
  page: Page,
  at: { x: number; y: number },
  image: { name: string; width: number; height: number; colors: readonly string[] },
): Promise<void> {
  await page.evaluate(
    async ({ at, image }) => {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // Vertical bands, one per colour, so placement and scale modes are visible.
      const band = image.width / image.colors.length;
      image.colors.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(Math.floor(i * band), 0, Math.ceil(band), image.height);
      });
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const data = new DataTransfer();
      data.items.add(new File([blob], image.name, { type: "image/png" }));
      const target = document.querySelector(".canvas__overlay");
      if (!target) throw new Error("no canvas");
      const init = {
        dataTransfer: data,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      target.dispatchEvent(new DragEvent("drop", init));
    },
    { at, image },
  );
}

/** The design canvas's colour at a screen point, as #rrggbb. */
export async function canvasColor(page: Page, at: { x: number; y: number }): Promise<string> {
  return page.evaluate((at) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".canvas__layer:not(.canvas__overlay)",
    );
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("no canvas");
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const [r = 0, g = 0, b = 0] = ctx.getImageData(
      (at.x - rect.left) * k,
      (at.y - rect.top) * k,
      1,
      1,
    ).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }, at);
}
