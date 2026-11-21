import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { pipeline } from "node:stream/promises";
import type { BrowserContext, Page } from "@playwright/test";
import type { Score } from "../../../packages/engine/src/compare";
import type { EngineRenderOptions, engineDebug } from "../src/editor/engine-debug";
import type { parityDebug } from "../src/editor/parity-debug";

export type Backend = EngineRenderOptions["backend"];
type Pixels = Awaited<ReturnType<ReturnType<typeof engineDebug>["renderPixels"]>>;
type Fact = Omit<Pixels, "pixels" | "stats" | "unsupported"> & {
  unsupported: Record<string, string[]>;
  wallMs: number;
};
type Metrics = {
  canvas: Score;
  engines: Partial<Record<Backend, { vsFigma: Score; worse: string[] }>>;
  cpuVsGpu: Partial<Record<Backend, { score: Score; failures: string[] }>>;
};

export type Debug = {
  drawpane?: {
    s: { status: string };
    doc: {
      pageIds(): readonly string[];
      get(id: string): { type: string; parent: string; props: { name?: unknown } } | undefined;
    };
  };
  drawpaneParity?: ReturnType<typeof parityDebug>;
  drawpaneEngine?: ReturnType<typeof engineDebug>;
  __kitCompare: typeof import("../../../packages/engine/src/compare");
};

export async function installScoring(context: BrowserContext) {
  const source = await readFile(
    new URL("../../../packages/engine/src/compare.ts", import.meta.url),
    "utf8",
  );
  const js = stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export /gm, "");
  await context.addInitScript({
    content: `window.__kitCompare = (() => { ${js}; return { score, outsideTolerance }; })();`,
  });
}

/** Pass PNG streams over loopback. Playwright only carries the frame's metadata. */
export async function pngTransfer(origin: string) {
  const routes = new Map<string, string>();
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    const file = routes.get(`${req.method} ${req.url}`);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "image/png");
        await pipeline(createReadStream(file), res);
      } else {
        await pipeline(req, createWriteStream(file));
        res.writeHead(204).end();
      }
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PNG server has no port");
  return {
    frame(input: string, outputs: Record<string, string>) {
      routes.clear();
      const prefix = `/${randomUUID()}`;
      routes.set(`GET ${prefix}/figma`, input);
      for (const [side, file] of Object.entries(outputs))
        routes.set(`POST ${prefix}/${side}`, file);
      return `http://127.0.0.1:${address.port}${prefix}`;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

export async function pageCensus(page: Page) {
  return page.evaluate(async () => {
    const { drawpane, drawpaneEngine } = window as unknown as Debug;
    if (!drawpane || !drawpaneEngine) throw new Error("Engine debug handle is missing");
    const inspect = (pageId: string) => {
      const started = performance.now();
      const { unsupported, records, waiting } = drawpaneEngine.inspect(pageId);
      return {
        pageId,
        name: String(drawpane.doc.get(pageId)?.props.name ?? ""),
        records,
        waiting,
        unsupported: Object.fromEntries(
          Object.entries(unsupported).map(([feature, ids]) => [feature, ids.length]),
        ),
        buildMs: performance.now() - started,
      };
    };
    const pages = drawpane.doc.pageIds().map(inspect);
    // The first pass requests all faces. The shaper resolves missing faces after its deadline.
    if (pages.some(({ waiting }) => waiting > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      return pages.map((entry) => (entry.waiting > 0 ? inspect(entry.pageId) : entry));
    }
    return pages;
  });
}

type FrameOptions = Pick<EngineRenderOptions, "rect" | "scale" | "width" | "height"> & {
  id: string;
  url: string;
  backends: Backend[];
  inline: boolean;
};

export function renderFrame(page: Page, options: FrameOptions) {
  return page.evaluate(async ({ id, url, backends, inline, rect, scale, width, height }) => {
    const { drawpane, drawpaneParity, drawpaneEngine, __kitCompare } = window as unknown as Debug;
    if (!drawpane || !drawpaneParity || !drawpaneEngine)
      throw new Error("Debug handles are missing");
    let node = drawpane.doc.get(id);
    let pageId = id;
    while (node && node.type !== "page") {
      pageId = node.parent;
      node = drawpane.doc.get(pageId);
    }
    if (!node) return null;
    const save = async (side: string, canvas: OffscreenCanvas) => {
      const png = await canvas.convertToBlob({ type: "image/png" });
      // A Blob with image/png would trigger CORS preflight. Its bytes are all the server needs.
      const response = await fetch(`${url}/${side}`, { method: "POST", body: png.slice() });
      if (!response.ok) throw new Error(`Could not save ${side} (${response.status})`);
    };
    const context = (canvas: OffscreenCanvas) => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("No 2D context for kit pixels");
      return ctx;
    };
    const { faces, missing } = await drawpaneParity.fonts(id);
    const nodes = inline ? [] : drawpaneParity.layout(id);
    const { canvas, ms } = await drawpaneParity.renderCanvas(id, rect, scale, width, height);
    const facts: Partial<Record<Backend, Fact>> = {};
    const engines: Metrics["engines"] = {};
    const cpuVsGpu: Metrics["cpuVsGpu"] = {};
    let figma: Uint8ClampedArray | undefined;
    let cpu: Uint8Array | undefined;
    let canvasScore: Score | undefined;
    const score = (a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray) => {
      const { heat: _heat, ...metrics } = __kitCompare.score(a, b, width, height, false);
      return metrics;
    };
    const scratch = new OffscreenCanvas(width, height);
    const ctx = context(scratch);
    if (inline) {
      const response = await fetch(`${url}/figma`);
      if (!response.ok) throw new Error(`Missing Figma PNG (${response.status})`);
      const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      try {
        if (bitmap.width !== width || bitmap.height !== height)
          throw new Error("Figma PNG size differs");
        ctx.drawImage(bitmap, 0, 0);
        figma = ctx.getImageData(0, 0, width, height).data;
      } finally {
        bitmap.close();
      }
      canvasScore = score(context(canvas).getImageData(0, 0, width, height).data, figma);
    }
    let keepCanvas = !inline;
    for (const backend of backends) {
      const started = performance.now();
      const {
        pixels,
        stats: _stats,
        ...result
      } = await drawpaneEngine
        .renderPixels({
          pageId,
          ids: [id],
          context: true,
          rect,
          scale,
          width,
          height,
          backend,
          background: [0, 0, 0, 0],
        })
        .catch((error: unknown): Pixels => ({ ok: false, error: String(error), unsupported: {} }));
      facts[backend] = { ...result, wallMs: performance.now() - started };
      if (!pixels || !result.ok || Object.keys(result.unsupported).length > 0) continue;
      let keep = !inline;
      if (figma && canvasScore) {
        if (backend === "cpu") cpu = pixels;
        if (backend !== "cpu" && cpu) {
          const metrics = score(pixels, cpu);
          cpuVsGpu[backend] = { score: metrics, failures: __kitCompare.outsideTolerance(metrics) };
        }
        const vsFigma = score(pixels, figma);
        const worse: string[] = [];
        if (vsFigma.mean > canvasScore.mean + 0.01) worse.push("mean");
        if (vsFigma.worstTile > canvasScore.worstTile + 1) worse.push("worstTile");
        if (vsFigma.alphaMean > canvasScore.alphaMean + 0.05) worse.push("alpha");
        engines[backend] = { vsFigma, worse };
        keep = worse.length > 0;
        keepCanvas ||= keep;
      }
      if (keep) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
        await save(backend, scratch);
      }
    }
    if (keepCanvas) await save("canvas", canvas);
    const metrics: Metrics | undefined = canvasScore && { canvas: canvasScore, engines, cpuVsGpu };
    return { faces, missing, nodes, ms, facts, metrics };
  }, options);
}
