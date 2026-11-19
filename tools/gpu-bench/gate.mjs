// The GPU gate, run inside the Modal container before every benchmark run
// (see gpu_bench.py). It launches the same Chromium the benchmark will use,
// through the same wrapper and flags, on a page served from localhost (WebGPU
// needs a secure context), and records:
//
// - the WebGPU adapters `navigator.gpu.requestAdapter()` gives, core and
//   compatibility mode, and whether each one's device renders (a texture read
//   back through a buffer) and presents (a WebGPU canvas copied into a 2D one);
// - WebGL2's UNMASKED_VENDOR/RENDERER, the GPU the 2D canvas rasterizes on;
// - chrome://gpu's feature status (Canvas, Rasterization, Compositing, WebGL,
//   WebGPU), with the whole page kept as text;
// - read-backs of a 2D canvas and a WebGL clear.
//
// --expect gpu fails (exit 2) unless the 2D canvas, WebGL and compositing run on
// the NVIDIA GPU and an NVIDIA WebGPU adapter (core or compatibility mode)
// renders: SwiftShader, llvmpipe, lavapipe or a fallback adapter abort the run.
// --expect webgpu needs a core NVIDIA adapter instead and allows software
// compositing. --expect cpu only records what it saw.
//
// Usage: node gate.mjs [--checkout <repo>] --chrome <wrapper> --expect gpu|webgpu|cpu --out <dir>
// Without --checkout it drives the Playwright installed in the image (`--doctor`).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const opts = {};
for (let i = 2; i < process.argv.length; i += 2)
  opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const { checkout, chrome, expect = "gpu", out } = opts;
if (!chrome || !out) {
  console.error(
    "usage: gate.mjs [--checkout <repo>] --chrome <wrapper> --expect gpu|webgpu|cpu --out <dir>",
  );
  process.exit(64);
}
mkdirSync(out, { recursive: true });

// The checkout's own Playwright, so the gate drives the same version the benchmark does.
const { chromium } = checkout
  ? createRequire(join(checkout, "apps/web/package.json"))("@playwright/test")
  : createRequire("/opt/node/lib/node_modules/")("playwright");

const PAGE = `<!doctype html><meta charset="utf-8"><title>GPU gate</title>
<style>body{margin:0;background:#fff}canvas{display:inline-block;margin:8px;border:1px solid #ccc}</style>
<canvas id="c2d" width="512" height="512"></canvas><canvas id="cgl" width="512" height="512"></canvas><canvas id="cgpu" width="512" height="512"></canvas>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i;
const report = { expect, chrome, url, ok: false, problems: [] };
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  await page.goto(url);
  report.probes = await page.evaluate(async () => {
    const result = {};
    const near = (px, rgba) => rgba.every((v, i) => Math.abs(px[i] - v) <= 2);
    // WebGPU first: a context lost on the GL side shouldn't hide the adapter. Each
    // adapter: its info, a device, a texture cleared on the GPU and read back through
    // a buffer (does the device work?), and a WebGPU canvas copied into a 2D canvas
    // (does presenting work?). The first request can race the GPU process's Dawn
    // setup and come back empty, so each is tried a few times.
    const adapterInfo = (adapter) => {
      const i = adapter.info ?? {};
      return {
        vendor: i.vendor,
        architecture: i.architecture,
        device: i.device,
        description: i.description,
        isFallbackAdapter: i.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
        featureLevel: adapter.featureLevel ?? null,
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      };
    };
    const probeAdapter = async (options) => {
      let adapter = null;
      for (let attempt = 0; attempt < 3 && !adapter; attempt++) {
        adapter = await navigator.gpu.requestAdapter(options);
        if (!adapter) await new Promise((r) => setTimeout(r, 500));
      }
      if (!adapter) return { adapter: null };
      const out = { adapter: adapterInfo(adapter) };
      try {
        const device = await adapter.requestDevice();
        const clear = (view) => {
          const encoder = device.createCommandEncoder();
          encoder
            .beginRenderPass({
              colorAttachments: [
                { view, clearValue: { r: 0, g: 0, b: 1, a: 1 }, loadOp: "clear", storeOp: "store" },
              ],
            })
            .end();
          return encoder;
        };
        // Through a buffer.
        const texture = device.createTexture({
          size: [4, 4],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const buffer = device.createBuffer({
          size: 256 * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = clear(texture.createView());
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 4]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const px = [...new Uint8Array(buffer.getMappedRange(0, 4))];
        buffer.unmap();
        out.bufferPixel = px;
        out.bufferReadbackOk = near(px, [0, 0, 255, 255]);
        // Through a canvas.
        const canvas = document.getElementById("cgpu");
        const ctx = canvas.getContext("webgpu");
        ctx.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          alphaMode: "opaque",
        });
        device.queue.submit([clear(ctx.getCurrentTexture().createView()).finish()]);
        await device.queue.onSubmittedWorkDone();
        const copy = new OffscreenCanvas(512, 512).getContext("2d");
        copy.drawImage(canvas, 0, 0);
        let cpx = [...copy.getImageData(256, 256, 1, 1).data];
        if (!near(cpx, [0, 0, 255, 255])) {
          // Once more after the frame that presents it.
          await new Promise((r) => requestAnimationFrame(() => r()));
          copy.drawImage(canvas, 0, 0);
          cpx = [...copy.getImageData(256, 256, 1, 1).data];
        }
        out.canvasPixel = cpx;
        out.canvasReadbackOk = near(cpx, [0, 0, 255, 255]);
        device.destroy();
      } catch (error) {
        out.error = String(error);
      }
      return out;
    };
    if (!navigator.gpu) result.webgpu = { available: false };
    else {
      result.webgpu = {
        available: true,
        core: await probeAdapter({ powerPreference: "high-performance" }),
        compat: await probeAdapter({
          featureLevel: "compatibility",
          powerPreference: "high-performance",
        }),
      };
    }
    // 2D canvas: big enough that Chrome rasterizes it on the GPU when it can.
    const c2d = document.getElementById("c2d").getContext("2d");
    c2d.fillStyle = "rgb(255,0,0)";
    c2d.fillRect(0, 0, 512, 512);
    const px2d = [...c2d.getImageData(256, 256, 1, 1).data];
    result.canvas2d = { pixel: px2d, readbackOk: near(px2d, [255, 0, 0, 255]) };

    // WebGL2: the renderer string, and a clear read back.
    const gl = document.getElementById("cgl").getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) result.webgl = { available: false };
    else {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      gl.clearColor(0, 1, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(4);
      gl.readPixels(256, 256, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      result.webgl = {
        available: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        pixel: [...px],
        readbackOk: near([...px], [0, 255, 0, 255]),
      };
    }

    return result;
  });
  await page.screenshot({ path: join(out, "gate.png") });

  // chrome://gpu: the feature status and the whole page, kept as text.
  await page.goto("chrome://gpu");
  await page.waitForTimeout(2000);
  const gpuText = await page.evaluate(() => {
    // The page is built of custom elements: read every shadow root's text too. innerText,
    // not textContent: the feature list is parsed by its line breaks.
    // biome-ignore lint/performance/useDomNodeTextContent: line breaks matter here.
    const texts = [document.body.innerText];
    const visit = (root) => {
      for (const el of root.querySelectorAll("*"))
        if (el.shadowRoot) {
          // biome-ignore lint/performance/useDomNodeTextContent: line breaks matter here.
          texts.push([...el.shadowRoot.children].map((c) => c.innerText ?? "").join("\n"));
          visit(el.shadowRoot);
        }
    };
    visit(document);
    return texts.join("\n");
  });
  writeFileSync(join(out, "chrome-gpu.txt"), gpuText);
  const features = {};
  for (const m of gpuText.matchAll(
    /^\s*([A-Za-z][A-Za-z0-9 ._()-]{1,40}?):\s+(Hardware accelerated[^\n]*|Software only[^\n]*|Disabled[^\n]*|Unavailable[^\n]*|Software[^\n]*)$/gm,
  ))
    features[m[1].trim()] = m[2].trim();
  report.features = features;
  report.glRenderer = gpuText.match(/GL_RENDERER\s+([^\n]+)/)?.[1]?.trim() ?? null;
  report.console = consoleLines;
} finally {
  await browser.close();
  server.close();
}

// The verdict. `gpu`: the 2D canvas, WebGL and compositing on the NVIDIA GPU, and an
// NVIDIA WebGPU adapter that works (core, or compatibility mode). `webgpu`: a core
// WebGPU adapter on the NVIDIA GPU that works; compositing may be in software.
const p = report.probes;
const problems = report.problems;
const describe = (probe) => {
  const a = probe?.adapter;
  if (!a) return "none";
  const name = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(" / ");
  const works = probe.bufferReadbackOk
    ? "renders"
    : `doesn't render (${probe.error ?? probe.bufferPixel})`;
  const canvas = probe.canvasReadbackOk ? "canvas presents" : "canvas doesn't present";
  return `${name}${a.isFallbackAdapter ? " (fallback)" : ""}, ${works}, ${canvas}`;
};
const isNvidia = (probe) => {
  const a = probe?.adapter;
  if (!a || a.isFallbackAdapter) return false;
  const words = `${a.vendor} ${a.architecture} ${a.description}`;
  return /nvidia/i.test(words) && !SOFTWARE.test(words) && probe.bufferReadbackOk === true;
};
report.summary = {
  webgpuAdapter: describe(p.webgpu?.core),
  webgpuCompatAdapter: describe(p.webgpu?.compat),
  webglRenderer: p.webgl?.unmaskedRenderer ?? p.webgl?.renderer ?? "none",
  canvas: report.features.Canvas ?? "unknown",
  rasterization: report.features.Rasterization ?? "unknown",
  compositing: report.features.Compositing ?? "unknown",
  webgl: report.features.WebGL ?? "unknown",
  webgpu: report.features.WebGPU ?? "unknown",
};
if (expect === "gpu" || expect === "webgpu") {
  const renderer = report.summary.webglRenderer;
  if (!/nvidia/i.test(renderer)) problems.push(`WebGL's renderer isn't NVIDIA: ${renderer}`);
  if (SOFTWARE.test(renderer)) problems.push(`WebGL renders in software: ${renderer}`);
  const needed =
    expect === "gpu"
      ? ["Canvas", "Rasterization", "Compositing", "WebGL"]
      : ["Canvas", "Rasterization", "WebGL"];
  for (const name of needed)
    if (!/^Hardware accelerated/.test(report.features[name] ?? ""))
      problems.push(`chrome://gpu: ${name}: ${report.features[name] ?? "not listed"}`);
  if (!p.canvas2d.readbackOk) problems.push(`2D canvas read back ${p.canvas2d.pixel}`);
  if (!p.webgl?.readbackOk) problems.push(`WebGL read back ${p.webgl?.pixel}`);
  if (expect === "gpu" && !isNvidia(p.webgpu?.core) && !isNvidia(p.webgpu?.compat))
    problems.push(
      `No working NVIDIA WebGPU adapter: core ${report.summary.webgpuAdapter}; compatibility ${report.summary.webgpuCompatAdapter}`,
    );
  if (expect === "webgpu" && !isNvidia(p.webgpu?.core))
    problems.push(
      `The core WebGPU adapter isn't a working NVIDIA one: ${report.summary.webgpuAdapter}`,
    );
}
report.ok = problems.length === 0;
writeFileSync(join(out, "gate.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  [
    `GPU gate (${expect}): ${report.ok ? "passed" : "FAILED"}`,
    `  Chromium ${report.browserVersion}`,
    `  WebGPU adapter: ${report.summary.webgpuAdapter}`,
    `  WebGPU adapter, compatibility mode: ${report.summary.webgpuCompatAdapter}`,
    `  WebGL renderer: ${report.summary.webglRenderer}`,
    `  chrome://gpu: Canvas ${report.summary.canvas}; Rasterization ${report.summary.rasterization}; Compositing ${report.summary.compositing}; WebGL ${report.summary.webgl}; WebGPU ${report.summary.webgpu}`,
    ...problems.map((x) => `  problem: ${x}`),
  ].join("\n"),
);
process.exit(report.ok ? 0 : 2);
