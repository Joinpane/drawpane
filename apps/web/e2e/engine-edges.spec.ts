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
 * - A filled box with an opaque inside stroke covers its edge once, as its fill alone does: fill
 *   and stroke both ended on the edge, and an edge pixel got 2c - c² of coverage (the shadcn
 *   Carousel button). Its fills stop halfway under the stroke where that can't show (the engine's
 *   `rim_inset`): a band two device pixels wide or more, so a thin border never turns an opaque
 *   box see-through, and nothing beneath reading the backdrop the fill leaves.
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

/** One layer drawn alone at `scale` on `backend` over `background`: its RGBA, row by row. */
async function pixels(
  page: Page,
  backend: Backend,
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  scale = 2,
  background = [0, 0, 0, 0],
): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    const r = await page.evaluate(
      async ({ backend, id, rect, scale, background }) => {
        const w = window as unknown as W;
        const out = await w.drawpaneEngine.render({
          pageId: w.drawpane.s.pageId,
          ids: [id],
          rect,
          scale,
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale),
          backend,
          background,
        });
        if (!out.ok || !out.rgba) return { error: out.error ?? "no pixels" };
        const bytes = atob(out.rgba);
        const px: number[] = [];
        for (let i = 0; i < bytes.length; i++) px.push(bytes.charCodeAt(i));
        return { px, gpu: out.gpu?.backend ?? null };
      },
      { backend, id, rect, scale, background },
    );
    if ("px" in r) {
      if (backend !== "cpu") expect(r.gpu).toBe(backend === "gpu" ? "webgpu" : "webgl2");
      return r.px;
    }
    // SwiftShader under load can miss the engine's GPU wait once; anything else fails.
    if (attempt < 2 && /timed out/.test(r.error)) continue;
    throw new Error(`${backend}: ${r.error}`);
  }
}

/** One layer drawn alone at 2x on `backend`, over transparency: its alpha, row by row. */
async function alpha(
  page: Page,
  backend: Backend,
  id: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number[]> {
  return (await pixels(page, backend, id, rect)).filter((_, i) => i % 4 === 3);
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
            // The shadcn kit's Carousel button, bordered and not.
            bordered: e.createLayer("frame", { x: 120, y: 0, width: 28, height: 28 }, page, {
              cornerRadius: 9999,
              fills: [{ type: "solid", color: "#f5f5f5" }],
              strokes: [{ type: "solid", color: "#e5e5e5" }],
              strokeWeight: 1,
              strokeAlign: "inside",
            }),
            plain: e.createLayer("frame", { x: 160, y: 0, width: 28, height: 28 }, page, {
              cornerRadius: 9999,
              fills: [{ type: "solid", color: "#f5f5f5" }],
            }),
            // The review's black box with a black inside border, drawn below 2 px of band.
            thin: e.createLayer("rect", { x: 220, y: 0, width: 32, height: 28 }, page, {
              fills: black,
              strokes: black,
              strokeWeight: 1,
              strokeAlign: "inside",
            }),
            // The review's red frame with a 20 unit black border over a child that blurs what's
            // behind it, and the same with a border a hair short of opaque (never stopped).
            ...Object.fromEntries(
              (["#000000", "#000000fe"] as const).map((ink, i) => {
                const frame = e.createLayer(
                  "frame",
                  { x: 300 + i * 120, y: 0, width: 100, height: 76 },
                  page,
                  {
                    fills: [{ type: "solid", color: "#ff0000" }],
                    strokes: [{ type: "solid", color: ink }],
                    strokeWeight: 20,
                    strokeAlign: "inside",
                  },
                );
                e.createLayer("rect", { x: 10, y: 10, width: 80, height: 56 }, frame, {
                  fills: [{ type: "solid", color: "#ffffff05" }],
                  effects: [{ type: "background-blur", radius: 20 }],
                });
                return [i === 0 ? "readerOpaque" : "readerHair", frame];
              }),
            ),
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

      test(`a filled box covers its edge once under an inside stroke (${backend})`, async () => {
        test.setTimeout(120_000);
        const bordered = await alpha(page, backend, ids.bordered as string, {
          x: 120,
          y: 0,
          width: 28,
          height: 28,
        });
        const plain = await alpha(page, backend, ids.plain as string, {
          x: 160,
          y: 0,
          width: 28,
          height: 28,
        });
        // Fill and stroke both on the edge: an edge pixel the circle covers 60/255 of came out 98.
        expect(
          Math.max(...bordered.map((a, i) => Math.abs(a - (plain[i] as number)))),
        ).toBeLessThanOrEqual(1);
        expect(plain.some((a) => a > 0 && a < 255)).toBe(true);
      });

      test(`an opaque box stays opaque under a thin inside border (${backend})`, async () => {
        test.setTimeout(120_000);
        // Bands of 0.5, 1 and 1.5 device pixels, at fractional spots: every pixel the box
        // covers whole stays opaque (a fill stopped under a thin band left 223).
        for (const [scale, x0] of [
          [0.5, 219.4],
          [1, 219.7],
          [1.5, 219.2],
        ] as const) {
          const rect = { x: x0, y: -0.6, width: 36, height: 32 };
          const a = (await pixels(page, backend, ids.thin as string, rect, scale)).filter(
            (_, i) => i % 4 === 3,
          );
          const width = Math.round(rect.width * scale);
          const [left, right] = [(220 - x0) * scale, (252 - x0) * scale];
          const [top, bottom] = [(0 - rect.y) * scale, (28 - rect.y) * scale];
          let inside = 0;
          for (let y = Math.ceil(top); y + 1 <= bottom; y++)
            for (let x = Math.ceil(left); x + 1 <= right; x++) {
              inside++;
              expect(a[y * width + x], `scale ${scale}, pixel (${x}, ${y})`).toBe(255);
            }
          expect(inside).toBeGreaterThan(100);
        }
      });

      test(`a border over a backdrop reader leaves its fill whole (${backend})`, async () => {
        test.setTimeout(120_000);
        const white = [1, 1, 1, 1];
        const opaque = await pixels(
          page,
          backend,
          ids.readerOpaque as string,
          { x: 300, y: 0, width: 100, height: 76 },
          1,
          white,
        );
        const hair = await pixels(
          page,
          backend,
          ids.readerHair as string,
          { x: 420, y: 0, width: 100, height: 76 },
          1,
          white,
        );
        // Stopped under the band, the fill left the child's blur a white page to sample: a halo
        // of (255, 32, 32) where (255, 5, 5) belongs.
        expect(
          Math.max(...opaque.map((v, i) => Math.abs(v - (hair[i] as number)))),
        ).toBeLessThanOrEqual(2);
      });
    }
  });
