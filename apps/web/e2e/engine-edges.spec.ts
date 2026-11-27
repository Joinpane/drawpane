/**
 * Edges the kit audit found the engine drawing worse than the canvas renderer, on every backend
 * (CPU, WebGPU and WebGL2; SwiftShader here), each against an exact answer:
 *
 * - Curved edges cover what their outline covers. vello_common flattened fills at a quarter
 *   pixel, every chord inside its curve, so the iOS kit's 8 x 8 page dot (16 px at 2x) and a
 *   38 x 38 circle came out polygonal and light at the edge. The vendored vello_common flattens
 *   at 1/16 px (packages/engine/rust/vendor/vello_common/VENDORED.md).
 * - A closed path that only retraces itself (`M8 0 L0 8 Z`, the shadcn kit's Lucide X instances)
 *   strokes like the open lines: stroked closed, its two outlines coincide and the engine's
 *   analytic coverage counted their edges twice, half a pixel wider (engine/retraced.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance } from "./fresh-instance";

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

type Backend = "cpu" | "gpu" | "webgl";
type W = {
  drawpane: {
    s: { pageId: string };
    createLayer(type: string, box: object, parent: string, props: object): string;
  };
  drawpaneEngine: {
    render(o: Record<string, unknown>): Promise<{
      ok: boolean;
      error?: string;
      rgba?: string;
      gpu?: { backend?: string };
    }>;
  };
};

/** Exact coverage (64 x 64 samples a pixel) of a disc of radius `r` centred in a `size` frame. */
function disc(r: number, size: number): number[] {
  const n = 64;
  const c = size / 2;
  const out: number[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const px = x + (i + 0.5) / n - c;
          const py = y + (j + 0.5) / n - c;
          if (px * px + py * py <= r * r) inside++;
        }
      out.push(Math.round((inside / (n * n)) * 255));
    }
  return out;
}

/** Worst per-pixel alpha error and the mean signed error over edge pixels. */
function errors(drawn: number[], exact: number[]): { worst: number; bias: number } {
  let worst = 0;
  let sum = 0;
  let edge = 0;
  drawn.forEach((d, i) => {
    const e = exact[i] as number;
    worst = Math.max(worst, Math.abs(d - e));
    if (e > 0 && e < 255) {
      sum += d - e;
      edge++;
    }
  });
  return { worst, bias: sum / Math.max(1, edge) };
}

/** One layer drawn alone at 2x on `backend`, over transparency: its alpha, row by row. */
async function alpha(
  page: Page,
  backend: Backend,
  id: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    const r = await page.evaluate(
      async ({ backend, id, rect }) => {
        const w = window as unknown as W;
        const out = await w.drawpaneEngine.render({
          pageId: w.drawpane.s.pageId,
          ids: [id],
          rect,
          scale: 2,
          width: rect.width * 2,
          height: rect.height * 2,
          backend,
          background: [0, 0, 0, 0],
        });
        if (!out.ok || !out.rgba) return { error: out.error ?? "no pixels" };
        const bytes = atob(out.rgba);
        const a: number[] = [];
        for (let i = 3; i < bytes.length; i += 4) a.push(bytes.charCodeAt(i));
        return { alpha: a, gpu: out.gpu?.backend ?? null };
      },
      { backend, id, rect },
    );
    if ("alpha" in r) {
      if (backend !== "cpu") expect(r.gpu).toBe(backend === "gpu" ? "webgpu" : "webgl2");
      return r.alpha;
    }
    // SwiftShader under load can miss the engine's GPU wait once; anything else fails.
    if (attempt < 2 && /timed out/.test(r.error)) continue;
    throw new Error(`${backend}: ${r.error}`);
  }
}

test.describe
  .serial("Engine edges against exact coverage", () => {
    test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
    let page: Page;
    let stop: () => Promise<void>;
    const ids: Record<string, string> = {};

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      const port = Number(process.env.ENGINE_EDGES_E2E_PORT ?? 9461);
      const instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
      page = instance.page;
      stop = instance.stop;
      await page.evaluate(() => {
        localStorage.setItem("drawpane:debug", "1");
        // This VM's only WebGPU adapter is SwiftShader, which the editor refuses by default.
        localStorage.setItem("drawpane:engine-software", "allow");
      });
      await page.reload();
      await page.getByRole("button", { name: "New file" }).first().click();
      await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
        timeout: 15_000,
      });
      Object.assign(
        ids,
        await page.evaluate(() => {
          const e = (window as unknown as W).drawpane;
          const page = e.s.pageId;
          const black = [{ type: "solid", color: "#000000" }];
          const ink = [{ type: "solid", color: "#0a0a0a" }];
          const x = {
            strokes: ink,
            strokeWeight: 1.5,
            strokeAlign: "center",
            strokeJoin: "round",
            strokeCap: "round",
          };
          return {
            // The iOS kit's page dot.
            dot: e.createLayer("frame", { x: 0, y: 0, width: 8, height: 8 }, page, {
              cornerRadius: 50,
              fills: black,
            }),
            // The iOS date picker's selected day.
            circle: e.createLayer("ellipse", { x: 20, y: 0, width: 38, height: 38 }, page, {
              fills: black,
            }),
            // The shadcn kit's Lucide X as its instances hold it, and as lines.
            closed: e.createLayer("path", { x: 80, y: 0, width: 8, height: 8 }, page, {
              ...x,
              pathData: "M8 0 L0 8 Z M0 0 L8 8 Z",
              fills: ink,
            }),
            open: e.createLayer("path", { x: 100, y: 0, width: 8, height: 8 }, page, {
              ...x,
              pathData: "M8 0 L0 8 M0 0 L8 8",
            }),
          };
        }),
      );
    });

    test.afterAll(async () => {
      await stop?.();
    });

    for (const backend of ["cpu", "gpu", "webgl"] as const) {
      test(`curved edges cover what their outline covers (${backend})`, async () => {
        test.setTimeout(120_000);
        const dot = errors(
          await alpha(page, backend, ids.dot as string, { x: 0, y: 0, width: 8, height: 8 }),
          disc(8, 16),
        );
        // At a quarter pixel: 44 levels off at worst, the edge 12 levels light on average.
        expect(dot.worst, "the 16 px dot's worst pixel").toBeLessThanOrEqual(12);
        expect(Math.abs(dot.bias), "the 16 px dot's edge on average").toBeLessThanOrEqual(6);
        const circle = errors(
          await alpha(page, backend, ids.circle as string, { x: 20, y: 0, width: 38, height: 38 }),
          disc(38, 76),
        );
        // At a quarter pixel its top was one 17 px chord: 52 levels off at worst.
        expect(circle.worst, "the 76 px circle's worst pixel").toBeLessThanOrEqual(16);
        expect(Math.abs(circle.bias), "the 76 px circle's edge on average").toBeLessThanOrEqual(8);
      });

      test(`a retraced closed path strokes like its open lines (${backend})`, async () => {
        test.setTimeout(120_000);
        const closed = await alpha(page, backend, ids.closed as string, {
          x: 76,
          y: -4,
          width: 16,
          height: 16,
        });
        const open = await alpha(page, backend, ids.open as string, {
          x: 96,
          y: -4,
          width: 16,
          height: 16,
        });
        // Stroked closed, a 45° edge pixel the lines cover 157/255 of came out 255.
        expect(Math.max(...closed.map((a, i) => Math.abs(a - (open[i] as number))))).toBe(0);
        expect(open.some((a) => a > 0 && a < 255)).toBe(true);
      });
    }
  });
