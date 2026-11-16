/**
 * Canvas performance against the PRD's budget: p95 frame time under 16 ms
 * while panning a 10,000-layer file. Builds a realistic file (400 cards of
 * 25 layers: boards, text, shapes, icons) on a throwaway instance, pans it
 * for 240 frames at three zoom levels, and reports what drawing took.
 *
 * Prints the numbers always; fails over budget only with BENCH_ENFORCE=1,
 * since headless browsers without a GPU are far slower than a laptop.
 * Run with `pnpm --filter @drawpane/web bench`.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { pan, type Summary, summaryRow, zoom } from "./frames";

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 16);
const ENFORCE = process.env.BENCH_ENFORCE === "1";

/** Fills the current page with `cards` cards of 25 layers, straight into the local document. */
async function buildFile(page: Page, cards: number): Promise<number> {
  return page.evaluate((cards) => {
    type Op = {
      op: "create";
      id: string;
      type: string;
      parent: string;
      key: string;
      props: object;
    };
    const e = (
      window as unknown as {
        drawpane: { s: { pageId: string }; doc: { apply(ops: Op[]): void } };
      }
    ).drawpane;
    const ops: Op[] = [];
    let n = 0;
    const id = () => `bench${(n++).toString(36)}`;
    // Order keys: "a" + one base-62 digit, then "b" + two (see the model's order keys).
    const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const key = (i: number) =>
      i < 62 ? `a${DIGITS[i]}` : `b${DIGITS[Math.floor(i / 62)]}${DIGITS[i % 62]}`;
    const columns = Math.ceil(Math.sqrt(cards));
    for (let c = 0; c < cards; c++) {
      const card = id();
      const x = (c % columns) * 360;
      const y = Math.floor(c / columns) * 260;
      ops.push({
        op: "create",
        id: card,
        type: "frame",
        parent: e.s.pageId,
        key: key(c),
        props: {
          name: `Card ${c + 1}`,
          x,
          y,
          width: 320,
          height: 220,
          cornerRadius: 12,
          fills: [{ type: "solid", color: "#ffffff" }],
          strokes: [{ type: "solid", color: "#e3e1dc" }],
          effects: [{ type: "drop-shadow", color: "#0000001f", x: 0, y: 4, blur: 12, spread: 0 }],
        },
      });
      let k = 0;
      const child = (type: string, props: object) =>
        ops.push({ op: "create", id: id(), type, parent: card, key: key(k++), props });
      child("rect", {
        x: 16,
        y: 16,
        width: 288,
        height: 96,
        cornerRadius: 8,
        fills: [{ type: "solid", color: "#f1efe9" }],
      });
      child("ellipse", {
        x: 16,
        y: 124,
        width: 32,
        height: 32,
        fills: [{ type: "solid", color: "#e8590c" }],
      });
      child("text", {
        x: 56,
        y: 124,
        width: 10,
        height: 10,
        characters: `Project ${c + 1}`,
        fontSize: 15,
        fontWeight: 600,
      });
      child("text", {
        x: 56,
        y: 144,
        width: 10,
        height: 10,
        characters: "Updated just now",
        fontSize: 11,
        fills: [{ type: "solid", color: "#77746d" }],
      });
      child("text", {
        x: 16,
        y: 166,
        width: 288,
        height: 10,
        textAutoResize: "height",
        characters: "Three things on today, nothing more. Pick the one that matters.",
        fontSize: 12,
      });
      for (let i = 0; i < 4; i++) {
        child("rect", {
          x: 16 + i * 52,
          y: 196,
          width: 44,
          height: 16,
          cornerRadius: 8,
          fills: [{ type: "solid", color: i === 0 ? "#007ca5" : "#e9e7e2" }],
        });
        child("text", {
          x: 22 + i * 52,
          y: 198,
          width: 10,
          height: 10,
          characters: ["Focus", "Today", "Later", "Done"][i] as string,
          fontSize: 9,
        });
      }
      for (let i = 0; i < 6; i++)
        child("path", {
          x: 220 + (i % 3) * 28,
          y: 28 + Math.floor(i / 3) * 28,
          width: 20,
          height: 20,
          pathData: "M0 10 L10 0 L20 10 L10 20 Z",
          fills: [{ type: "solid", color: "#1c1b1a" }],
        });
      for (let i = 0; i < 5; i++)
        child("rect", {
          x: 24 + i * 36,
          y: 32 + (i % 2) * 24,
          width: 28,
          height: 20,
          cornerRadius: 4,
          fills: [{ type: "solid", color: "#d9d9d6" }],
        });
    }
    e.doc.apply(ops);
    return ops.length;
  }, cards);
}

test.describe("Canvas performance", () => {
  test.skip(!!process.env.E2E_BASE_URL, "Needs its own local instance.");
  let instance: Instance;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    instance = await freshInstance(browser, { port: 8821, inspectorPort: 9361 });
  });
  test.afterAll(async () => {
    await instance?.stop();
  });

  test("pans a 10,000-layer file within budget", async () => {
    const page = instance.page;
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await page.getByRole("button", { name: "New file" }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
      timeout: 15_000,
    });
    const layers = await buildFile(page, 400);
    expect(layers).toBe(10_000);
    // Let fonts and the first full paint settle.
    await page.waitForTimeout(1500);

    const results: Record<string, Summary> = {};
    for (const level of ["fit", 0.25, 1] as const)
      results[level === "fit" ? "pan, whole" : `pan, ${level * 100}%`] = await pan(
        page,
        level,
        240,
      );
    results["zoom, whole"] = await zoom(page, 240);

    const rows = Object.entries(results).map(([name, r]) => summaryRow(name, r));
    console.log(`\nCanvas, 10,000 layers, ${BUDGET_MS} ms budget\n${rows.join("\n")}\n`);
    test.info().annotations.push({ type: "bench", description: JSON.stringify(results) });
    if (ENFORCE)
      for (const [name, r] of Object.entries(results))
        expect(r.content.p95 + r.overlay.p95, `${name} p95 frame time`).toBeLessThan(BUDGET_MS);
  });
});
