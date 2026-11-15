/**
 * Figma import fidelity: the parity scenes as Figma itself stores them
 * (GET /v1/files/:key?geometry=paths, kept as a fixture so CI needs no
 * Figma account), imported with @drawpane/figma, drawn in Drawpane, and
 * compared cell by cell with Figma's renders of them (tools/figma-parity's
 * goldens). Each cell must stay within `import-thresholds.json`; record new
 * ones with UPDATE_THRESHOLDS=1. The report goes to PARITY_OUT, by default
 * test-results/parity/import.html.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertFile, drawpaneId, type Figma } from "@drawpane/figma";
import { expect, test } from "@playwright/test";
import { freshInstance, type Instance } from "../fresh-instance";
import { compare, decodePng, encodePng } from "./pixels";

const ROOT = fileURLToPath(new URL("../../../../tools/figma-parity", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../../../../packages/figma/test/fixtures/parity-file.json", import.meta.url),
);
const THRESHOLDS = join(ROOT, "import-thresholds.json");
const OUT =
  process.env.PARITY_OUT ?? fileURLToPath(new URL("../../test-results/parity", import.meta.url));
const SCALE = 2;
const updating = process.env.UPDATE_THRESHOLDS === "1";
type Thresholds = Record<string, Record<string, number>>;
const recorded: Thresholds = existsSync(THRESHOLDS)
  ? (JSON.parse(readFileSync(THRESHOLDS, "utf8")) as Thresholds)
  : {};

type W = {
  drawpane: {
    s: { camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
    setPage(id: string): void;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
  };
  drawpaneFrames: { redraw(): void };
};

test.describe
  .serial("Figma import fidelity", () => {
    let instance: Instance;
    let fileId: string;
    const figma = JSON.parse(readFileSync(FIXTURE, "utf8")) as Figma.File;
    const pages = (figma.document.children ?? []).filter((p) => p.name.startsWith("Parity: "));
    const results: Thresholds = {};
    const report: string[] = [];

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      instance = await freshInstance(browser, { port: 8961, inspectorPort: 9501 });
      const page = instance.page;
      await page.evaluate(() => localStorage.setItem("drawpane:debug", "1"));
      // Into a new file, through the same import endpoint the dashboard uses.
      const teams = await (await page.request.get("/api/teams")).json();
      const teamId = teams.teams[0].id as string;
      const projects = await (await page.request.get(`/api/teams/${teamId}/projects`)).json();
      const created = await (
        await page.request.post(`/api/projects/${projects.projects[0].id}/files`, {
          data: { name: figma.name },
        })
      ).json();
      fileId = created.file.id;
      const { nodes } = convertFile(figma);
      const imported = await page.request.post(`/api/files/${fileId}/import`, { data: { nodes } });
      expect(imported.ok(), await imported.text()).toBe(true);
    });

    test.afterAll(async () => {
      await instance?.stop();
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, "import.html"),
        `<!doctype html><meta charset="utf-8"><title>Figma import fidelity</title><style>body{font:13px system-ui;margin:24px;background:#f4f3ef}img{width:240px;display:block}td,th{padding:4px 8px;vertical-align:top;text-align:left}small{color:#666}</style><h1>Figma import fidelity</h1><p>Figma's file imported and drawn by Drawpane, against Figma's own render: mean difference over RGB (0–255), 99th percentile, and where they differ.</p>${report.join("")}`,
      );
      if (updating) {
        const next: Thresholds = { ...recorded };
        for (const [suite, cells] of Object.entries(results))
          next[suite] = Object.fromEntries(
            Object.entries(cells).map(([id, mean]) => [
              id,
              Math.round((mean * 1.1 + 0.3) * 100) / 100,
            ]),
          );
        writeFileSync(THRESHOLDS, `${JSON.stringify(next, null, 2)}\n`);
      }
    });

    for (const figmaPage of pages) {
      const suite = figmaPage.name.slice("Parity: ".length);
      test(`${suite}, imported from Figma`, async () => {
        test.setTimeout(240_000);
        const page = instance.page;
        const cells = (figmaPage.children ?? [])
          .filter((c) => c.name.startsWith(`${suite}/`))
          .map((c) => ({
            id: c.name.slice(suite.length + 1),
            x: c.absoluteBoundingBox?.x ?? 0,
            y: c.absoluteBoundingBox?.y ?? 0,
            width: c.size?.x ?? 0,
            height: c.size?.y ?? 0,
          }));
        const right = Math.max(...cells.map((c) => c.x + c.width));
        const bottom = Math.max(...cells.map((c) => c.y + c.height));
        await page.setViewportSize({
          width: Math.min(4000, right * SCALE + 200),
          height: Math.min(4000, bottom * SCALE + 200),
        });
        await page.goto(`/f/${fileId}`);
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({
          timeout: 20_000,
        });
        await page.keyboard.press("ControlOrMeta+Shift+Backslash");
        const shots = await page.evaluate(
          async ({ pageId, cells, right, bottom, scale }) => {
            const w = window as unknown as W;
            w.drawpane.setPage(pageId);
            w.drawpane.select([]);
            w.drawpane.zoomTo(scale);
            w.drawpane.centerOn({ x: right / 2, y: bottom / 2 });
            await new Promise((r) => setTimeout(r, 1500));
            w.drawpaneFrames.redraw();
            for (let i = 0; i < 4; i++)
              await new Promise((r) => requestAnimationFrame(() => r(null)));
            const canvas = document.querySelector(".canvas canvas") as HTMLCanvasElement;
            const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
            const ratio = canvas.width / canvas.getBoundingClientRect().width;
            return cells.map((c) => {
              const at = w.drawpane.s.camera.toScreen({ x: c.x, y: c.y });
              const data = ctx.getImageData(
                Math.round(at.x * ratio),
                Math.round(at.y * ratio),
                c.width * scale,
                c.height * scale,
              ).data;
              let s = "";
              for (let i = 0; i < data.length; i += 0x8000)
                s += String.fromCharCode(...data.subarray(i, i + 0x8000));
              return btoa(s);
            });
          },
          { pageId: drawpaneId(figmaPage.id), cells, right, bottom, scale: SCALE },
        );

        const rows: string[] = [];
        const failures: string[] = [];
        results[suite] = {};
        for (const [i, cell] of cells.entries()) {
          const golden = join(ROOT, "goldens", suite, `${cell.id}.png`);
          if (!existsSync(golden)) continue;
          const width = cell.width * SCALE;
          const height = cell.height * SCALE;
          const theirs = await decodePng(page, golden);
          const diff = await compare(page, shots[i] as string, theirs.data, width, height);
          (results[suite] as Record<string, number>)[cell.id] = diff.mean;
          const limit = recorded[suite]?.[cell.id];
          if (!updating && limit !== undefined && diff.mean > limit)
            failures.push(`${cell.id}: ${diff.mean} (allowed ${limit})`);
          rows.push(
            `<tr><th>${cell.id}<br><small>${diff.mean} · p99 ${diff.p99}</small></th><td><img src="data:image/png;base64,${readFileSync(golden).toString("base64")}"></td><td><img src="${await encodePng(page, shots[i] as string, width, height)}"></td><td><img src="${await encodePng(page, diff.heat, width, height)}"></td></tr>`,
          );
        }
        const scores = Object.values(results[suite] as Record<string, number>);
        const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
        report.push(
          `<h2>${suite} <small>mean ${mean.toFixed(2)} over ${scores.length} cells</small></h2><table><tr><th></th><th>Figma</th><th>Imported</th><th>Difference</th></tr>${rows.join("")}</table>`,
        );
        console.log(
          `${suite} (imported): mean difference ${mean.toFixed(2)} over ${scores.length} cells`,
        );
        expect(failures, `${suite} import drifted from Figma`).toEqual([]);
      });
    }
  });
