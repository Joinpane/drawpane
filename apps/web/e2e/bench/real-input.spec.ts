/** Browser-queued input on the Examples page from the iOS UI kit. See decision 0040. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { freshInstance } from "../fresh-instance";
import { importConverted } from "../import-converted";
import { gestures, replay } from "./real-input-gestures";
import {
  collectProbe,
  openProbe,
  ready,
  resetProbe,
  SETTLE_MS,
  summarize,
  waitForExact,
} from "./real-input-probe";

const FILE = process.env.BENCH_FILE;
const ENFORCE = process.env.BENCH_LAG_GATE === "1";
const PAGE = "f0-3329";
const BOARD = "f12740-35188";
const TARGET = { lagP95Ms: 100, droppedPct: 5, backlogMs: 100 };

test("real input on the iOS kit Examples page", async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "Requires Chromium CDP input");
  if (ENFORCE)
    expect(FILE, "BENCH_LAG_GATE requires the iOS kit via BENCH_FILE or --kit").toBeTruthy();
  test.skip(!FILE, "Requires the converted iOS kit");
  if (!FILE) return;

  const nodes = readFileSync(join(FILE, "nodes.ndjson"), "utf8");
  const isExamples = nodes.includes(`"id":"${PAGE}"`) && nodes.includes(`"id":"${BOARD}"`);
  if (ENFORCE)
    expect(isExamples, "The kit must contain Examples and its Control Center board").toBe(true);
  test.skip(!isExamples, "Requires the iOS kit Examples page and Control Center board");

  test.setTimeout(360_000);
  const port = Number(process.env.E2E_PORT ?? 9010) + 1;
  const instance = await freshInstance(browser, { port, inspectorPort: port + 540 });
  try {
    const { page, context } = instance;
    const fileId = await importConverted(page, FILE, "Real input bench");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
    await openProbe(page);

    const url = `/f/${fileId}?page-id=${PAGE}&renderer=engine-webgl`;
    await page.goto(url);
    await ready(page, PAGE);
    await waitForExact(page, 60_000);
    const cold = await collectProbe(page);
    const rows = [{ gesture: "Cold open", ...summarize(cold) }];
    const invalid: string[] = [];
    const overBudget: string[] = [];
    const requireWebgl = (name: string, data: typeof cold) => {
      if (data.backend !== "webgl2" || data.readsBack) invalid.push(`${name}: need direct WebGL2`);
      if (ENFORCE && data.software) invalid.push(`${name}: gate requires hardware WebGL2`);
    };
    requireWebgl("Cold open", cold);

    await page.goto(`${url}&node-id=${BOARD}`);
    await ready(page, PAGE, BOARD);
    await waitForExact(page, 15_000);
    const canvas = page.locator(".canvas__overlay");
    const rect = await canvas.boundingBox();
    expect(rect, "Canvas input surface").not.toBeNull();
    if (!rect) throw new Error("Canvas input surface is missing");
    const dpr = await page.evaluate(() => devicePixelRatio);
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, dpr };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await sleep(250);
    for (const gesture of gestures) {
      const before = await resetProbe(page);
      const window = await replay(cdp, gesture, point);
      await sleep(SETTLE_MS);
      const after = await collectProbe(page);
      const row = summarize(after, {
        start: window.start - before.timeOrigin,
        stop: window.stop - before.timeOrigin,
        shortcut: gesture.digit !== undefined,
      });
      rows.push({ gesture: gesture.name, ...row });
      requireWebgl(gesture.name, after);
      if (!row.lagMs || row.droppedPct === null)
        invalid.push(`${gesture.name}: missing input or frames`);
      const from = before.camera;
      const to = after.camera;
      if (!from || !to || (from.x === to.x && from.y === to.y && from.zoom === to.zoom)) {
        invalid.push(`${gesture.name}: camera did not move`);
      }
      if (gesture.digit === 0 && to?.zoom !== 1) invalid.push("Shift+0 did not set 100% zoom");
      if (gesture.gate) {
        if ((row.lagMs?.p95 ?? Infinity) > TARGET.lagP95Ms)
          overBudget.push(`${gesture.name}: p95 lag`);
        if ((row.droppedPct ?? Infinity) > TARGET.droppedPct)
          overBudget.push(`${gesture.name}: dropped frames`);
        if ((row.backlogMs ?? Infinity) > TARGET.backlogMs)
          overBudget.push(`${gesture.name}: backlog`);
      }
    }

    const report = {
      dpr,
      backend: cold.backend,
      software: cold.software,
      targets: TARGET,
      rows,
      overBudget,
      invalid,
    };
    console.log("Real input on Examples / Control Center (ms, WebGL2, 60 Hz)");
    console.table(
      rows.map(({ lagMs, longestTaskMs, ...row }) => ({
        ...row,
        lagP50: lagMs?.p50,
        lagP95: lagMs?.p95,
        lagMax: lagMs?.max,
        longestTaskMs: longestTaskMs ?? "<50",
      })),
    );
    console.log(`Real-input budgets: ${overBudget.join(", ") || "met"}`);
    const description = JSON.stringify(report);
    testInfo.annotations.push({ type: "bench", description });
    await testInfo.attach("real-input.json", {
      body: description,
      contentType: "application/json",
    });
    expect(invalid, "Every gesture must reach the editor and produce a camera change").toEqual([]);
    if (ENFORCE) expect(overBudget, "Real-input performance budgets").toEqual([]);
  } finally {
    await instance.stop();
  }
});
