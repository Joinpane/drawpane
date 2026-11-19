/**
 * The Figma parity suites (tools/figma-parity): their scenes, built on a page as
 * figma-builder.js builds them in Figma, and the geometry of their cells. Shared by the canvas
 * renderer's parity spec (parity.spec.ts) and the render engine's (engine.spec.ts).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const ROOT = fileURLToPath(new URL("../../../../tools/figma-parity", import.meta.url));
export const SCALE = 2;
export const THRESHOLDS = join(ROOT, "thresholds.json");

export interface Layer {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly children?: readonly Layer[];
  readonly [prop: string]: unknown;
}
export interface Suite {
  readonly suite: string;
  readonly about: string;
  readonly cell: { width: number; height: number; gap: number; columns: number };
  /**
   * The cells' background colour; "none" for none, so what a cell lets through of an empty
   * backdrop shows: those are drawn as an export draws them and compared over white and black.
   */
  readonly background?: string;
  /**
   * The name of the layer each cell exports, as Figma exports a layer on a page: its
   * glass and background blur see what's under it. Else the cell is exported whole.
   */
  readonly export?: string;
  readonly backdrop?: "stripes";
  /** Compare after blurring both by this many px: for grain, whose pixels are random. */
  readonly blur?: number;
  readonly cells: ReadonlyArray<{ readonly id: string; readonly layers: readonly Layer[] }>;
}
export type Thresholds = Record<string, Record<string, number>>;
export type W = {
  drawpane: {
    s: {
      pageId: string;
      camera: { toScreen(p: { x: number; y: number }): { x: number; y: number } };
    };
    createLayer(
      type: string,
      rect: { x: number; y: number; width: number; height: number },
      parent: string,
      props?: Record<string, unknown>,
    ): string | null;
    select(ids: string[]): void;
    zoomTo(z: number): void;
    centerOn(p: { x: number; y: number }): void;
    createPage?(): string;
  };
  drawpaneFrames: { redraw(): void; exact: boolean };
  drawpaneParity: {
    render(
      id: string,
      rect: { x: number; y: number; width: number; height: number },
      scale: number,
      width: number,
      height: number,
    ): Promise<{ png: string }>;
  };
};

export const suites: Suite[] = readdirSync(join(ROOT, "scenes"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "scenes", f), "utf8")) as Suite);
export const recorded: Thresholds = existsSync(THRESHOLDS)
  ? (JSON.parse(readFileSync(THRESHOLDS, "utf8")) as Thresholds)
  : {};
export const updating = process.env.UPDATE_THRESHOLDS === "1";

export const cellOrigin = (suite: Suite, i: number) => ({
  x: (i % suite.cell.columns) * (suite.cell.width + suite.cell.gap),
  y: Math.floor(i / suite.cell.columns) * (suite.cell.height + suite.cell.gap),
});
export const gridSize = (suite: Suite) => ({
  width: suite.cell.columns * (suite.cell.width + suite.cell.gap),
  height: Math.ceil(suite.cells.length / suite.cell.columns) * (suite.cell.height + suite.cell.gap),
});

/** Builds a suite's cells on the page, as figma-builder.js builds them in Figma: what each exports. */
export function build(page: Page, suite: Suite): Promise<string[]> {
  return page.evaluate(
    ({ suite, origins }) => {
      const e = (window as unknown as W).drawpane;
      const place = (layer: Layer, parent: string, at: { x: number; y: number }) => {
        const { type, x, y, width, height, children, ...props } = layer;
        const id = e.createLayer(type, { x: at.x + x, y: at.y + y, width, height }, parent, {
          fills: [],
          ...props,
        });
        if (id && suite.export && props.name === suite.export) exported = id;
        if (id) for (const child of children ?? []) place(child, id, { x: at.x + x, y: at.y + y });
      };
      let exported: string | null = null;
      const frames = suite.cells.map((cell, i) => {
        const at = origins[i] as { x: number; y: number };
        const frame = e.createLayer(
          "frame",
          { ...at, width: suite.cell.width, height: suite.cell.height },
          e.s.pageId,
          {
            clipContent: true,
            fills:
              suite.background === "none"
                ? []
                : [{ type: "solid", color: suite.background ?? "#ffffff" }],
          },
        ) as string;
        if (suite.backdrop === "stripes") {
          // Bars both ways over a warm-to-cool gradient, as figma-builder.js draws them.
          e.createLayer(
            "rect",
            { ...at, width: suite.cell.width, height: suite.cell.height },
            frame,
            {
              fills: [
                {
                  type: "linear",
                  from: { x: 0, y: 0.5 },
                  to: { x: 1, y: 0.5 },
                  stops: [
                    { position: 0, color: "#ff7a45" },
                    { position: 0.5, color: "#ffd166" },
                    { position: 1, color: "#3d7bf0" },
                  ],
                },
              ],
            },
          );
          for (let y = 0, k = 0; y < suite.cell.height; y += 24, k++)
            e.createLayer(
              "rect",
              { x: at.x, y: at.y + y, width: suite.cell.width, height: 6 },
              frame,
              {
                fills: [{ type: "solid", color: k % 2 ? "#ffffffa6" : "#1c1b1aa6" }],
              },
            );
          for (let x = 0; x < suite.cell.width; x += 30)
            e.createLayer(
              "rect",
              { x: at.x + x, y: at.y, width: 4, height: suite.cell.height },
              frame,
              {
                fills: [{ type: "solid", color: "#0b3d918c" }],
              },
            );
        }
        exported = null;
        for (const layer of cell.layers) place(layer, frame, at);
        return exported ?? frame;
      });
      e.select([]);
      return frames;
    },
    { suite, origins: suite.cells.map((_, i) => cellOrigin(suite, i)) },
  );
}

/** The CSS font of each face the suite's text layers use: "800 96px Inter". */
export function textFaces(suite: Suite): string[] {
  const faces = new Set<string>();
  const visit = (layer: Layer) => {
    if (layer.type === "text") {
      const style = layer.fontStyle === "italic" ? "italic " : "";
      const weight = typeof layer.fontWeight === "number" ? layer.fontWeight : 400;
      const family = typeof layer.fontFamily === "string" ? layer.fontFamily : "Instrument Sans";
      faces.add(`${style}${weight} 16px "${family}"`);
    }
    for (const child of layer.children ?? []) visit(child);
  };
  for (const cell of suite.cells) for (const layer of cell.layers) visit(layer);
  return [...faces];
}

/**
 * Waits for the faces the suite's text uses. Web fonts come from Google Fonts once the file uses
 * them, and the canvas re-measures and redraws when one arrives: captured before that, text (and
 * glass shaped by it) is in a fallback face or at the wrong width. On a slow CI runner that can
 * take longer than any fixed wait. A face that never appears (a system font) stops the wait after
 * a while, without failing it.
 */
export async function waitForFonts(page: Page, suite: Suite): Promise<void> {
  const faces = textFaces(suite);
  if (faces.length === 0) return;
  await page.evaluate(async (faces) => {
    const deadline = performance.now() + 20_000;
    const loaded = async (font: string) => (await document.fonts.load(font)).length > 0;
    for (;;) {
      const all = await Promise.all(faces.map(loaded));
      if (all.every(Boolean) || performance.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await document.fonts.ready;
  }, faces);
}

/** What a cell exports, on the page: the cell, or its layer named by the suite's `export`. */
export function exportRect(
  suite: Suite,
  i: number,
): { x: number; y: number; width: number; height: number } {
  const at = cellOrigin(suite, i);
  const layer = suite.export
    ? suite.cells[i]?.layers.find((l) => l.name === suite.export)
    : undefined;
  return layer
    ? { x: at.x + layer.x, y: at.y + layer.y, width: layer.width, height: layer.height }
    : { ...at, width: suite.cell.width, height: suite.cell.height };
}

/** RGBA (base64) laid over an opaque colour (0 to 255 grey): what it looks like over a page. */
export function over(b64: string, grey: number): string {
  const px = Buffer.from(b64, "base64");
  for (let i = 0; i < px.length; i += 4) {
    const a = (px[i + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round((px[i + c] ?? 0) * a + grey * (1 - a));
    px[i + 3] = 255;
  }
  return px.toString("base64");
}
