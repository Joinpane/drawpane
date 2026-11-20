// The GPU gate, run inside the Modal container before every benchmark or parity run
// (see gpu_bench.py). It launches the same browser (Chromium, Firefox, or WebKit)
// that Playwright will use, on a page served from localhost (WebGPU needs a secure
// context), and records:
//
// - the WebGPU adapters `navigator.gpu.requestAdapter()` gives, core and
//   compatibility mode, whether each one's device renders (a texture read back
//   through a buffer), submits to a WebGPU canvas, and presents onscreen (via
//   element screenshot independent of 2D canvas-copy readback);
// - WebGL2's UNMASKED_VENDOR/RENDERER, extensions, read-back, onscreen
//   presentation, `failIfMajorPerformanceCaveat: true`, and a 512x512 ALU
//   fill-rate probe to distinguish hardware GPUs from masked software renderers
//   without refusing 16K macOS Safari Metal;
// - chrome://gpu's feature status on Chromium;
// - read-backs of a 2D canvas and a WebGL clear;
// - Secure (`__Host-`) cookie handling on http://localhost;
// - WebKit/cross-browser glass trap probes (OffscreenCanvas WebGL2 -> 2D drawImage,
//   UNPACK_PREMULTIPLY_ALPHA_WEBGL + NPOT generateMipmap + textureGrad, RGBA16F FBO).
//
// --expect gpu fails (exit 2) unless hardware acceleration and onscreen presentation work:
// - Chromium: 2D canvas, WebGL, compositing and WebGPU on NVIDIA, with onscreen WebGL present.
// - Firefox: 2D canvas + working non-fallback hardware WebGPU presentation (requiring explicit
//   hardware identity, trusted --host-gpu-ok, or hardware-speed GPU probe) or explicit
//   hardware WebGL2 presentation (generic labels like "WebKit WebGL" are rejected).
// - WebKit: 2D canvas + WebGL2 readback and onscreen presentation with maxTextureSize >= 16384
//   (macOS Safari 16K Metal safe); masked/unknown labels ("Apple GPU", "WebKit WebGL") require
//   passing failIfMajorPerformanceCaveat and fill-rate probe <= HARDWARE_FILL_MAX_MS.
// --expect webgpu needs a core NVIDIA WebGPU adapter on Chromium and labels presentationMode
//   ("onscreen" vs "render-only") based on actual #cgpu screenshot presentation.
// --expect cpu verifies that no hardware GPU adapter is exposed (masked/unknown WebGL labels
//   must fail failIfMajorPerformanceCaveat or run >= SOFTWARE_FILL_MIN_MS).
// --expect info only records what it saw.
//
// Usage: node gate.mjs [--checkout <repo>] [--browser chromium|firefox|webkit]
//        [--chrome <wrapper>] [--headless true|false] [--host-gpu-ok true|false]
//        [--expect gpu|webgpu|cpu|info] --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

export const HARDWARE_FILL_MAX_MS = 100;
export const SOFTWARE_FILL_MIN_MS = 120;
const FILL_PROBE_PASSES = 32;
const FILL_PROBE_SIDE = 512;

const SOFTWARE_RE =
  /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|microsoft basic|mesa offscreen|subzero/i;
const WEBKIT_ALIASED_RE = /^(?:apple(?:\s+inc\.?)?\s*\/\s*)?apple\s+gpu$/i;
const WEBKIT_HIDDEN_RE = /^(?:webkit\s*\/\s*)?webkit\s+webgl$/i;
const GENERIC_ADAPTER_RE =
  /^(?:webgl\s*2?(?:\.0)?|mozilla|angle|unknown|unidentified|none|webkit(?:\s*\/\s*webgl\s*2?(?:\.0)?)?|\s*\/\s*)*$/i;
const HARDWARE_RE =
  /nvidia|geforce|tesla|quadro|radeon|amd|radv|intel|iris|uhd|hd graphics|rtx|gtx|rx\s*\d|arc|metal|adreno|mali|powervr|apple\s+(?:m\d|a\d)/i;

/** Classifies a WebGL renderer label without conflating privacy masks with proven hardware. */
export function classifyWebglIdentity(renderer) {
  const trimmed = String(renderer ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return "none";
  if (SOFTWARE_RE.test(trimmed)) return "software";
  if (
    WEBKIT_ALIASED_RE.test(trimmed) ||
    WEBKIT_HIDDEN_RE.test(trimmed) ||
    GENERIC_ADAPTER_RE.test(trimmed)
  ) {
    return "unknown";
  }
  if (HARDWARE_RE.test(trimmed)) return "hardware";
  return "unknown";
}

/** Classifies a WebGPU adapter object honestly as hardware, software, unknown, or none. */
export function classifyWebgpuIdentity(adapter) {
  if (!adapter) return "none";
  const words = [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (adapter.isFallbackAdapter === true || SOFTWARE_RE.test(words)) return "software";
  if (!words) return "unknown";
  if (HARDWARE_RE.test(words)) return "hardware";
  if (
    WEBKIT_ALIASED_RE.test(words) ||
    WEBKIT_HIDDEN_RE.test(words) ||
    GENERIC_ADAPTER_RE.test(words)
  ) {
    return "unknown";
  }
  return "unknown";
}

export function isNvidiaWebgpu(probe) {
  const a = probe?.adapter;
  if (!a || a.isFallbackAdapter) return false;
  const words = `${a.vendor ?? ""} ${a.architecture ?? ""} ${a.description ?? ""}`;
  return /nvidia/i.test(words) && !SOFTWARE_RE.test(words) && probe.bufferReadbackOk === true;
}

/**
 * Evaluates the GPU/CPU gate policy for one browser and mode.
 * Pure and exported for unit testing (`gate.test.mjs`).
 */
export function evaluatePolicy({ browserName, expect, report, probes, hostGpuOk = false }) {
  const p = probes ?? report?.probes ?? {};
  const problems = [];
  const renderer =
    report?.summary?.webglRenderer ?? p.webgl?.unmaskedRenderer ?? p.webgl?.renderer ?? "none";
  const webglIdentityClass = p.webgl?.available ? classifyWebglIdentity(renderer) : "none";
  const webgpuIdentityClass = classifyWebgpuIdentity(p.webgpu?.core?.adapter);
  let presentationMode = "none";
  const verifiedBackends = [];

  if (browserName === "chromium" && (expect === "gpu" || expect === "webgpu")) {
    if (!/nvidia/i.test(renderer)) problems.push(`WebGL's renderer isn't NVIDIA: ${renderer}`);
    if (SOFTWARE_RE.test(renderer)) problems.push(`WebGL renders in software: ${renderer}`);
    const features = report?.features ?? {};
    const needed =
      expect === "gpu"
        ? ["Canvas", "Rasterization", "Compositing", "WebGL"]
        : ["Canvas", "Rasterization", "WebGL"];
    for (const name of needed) {
      if (!/^Hardware accelerated/.test(features[name] ?? "")) {
        problems.push(`chrome://gpu: ${name}: ${features[name] ?? "not listed"}`);
      }
    }
    if (!p.canvas2d?.readbackOk) problems.push(`2D canvas read back ${p.canvas2d?.pixel}`);
    if (!p.webgl?.readbackOk) problems.push(`WebGL read back ${p.webgl?.pixel}`);
    if (expect === "gpu") {
      if (p.webgl?.presentOk !== true) {
        problems.push(`WebGL onscreen presentation failed (pixel ${p.webgl?.presentPixel})`);
      } else {
        presentationMode = "onscreen";
      }
      if (!isNvidiaWebgpu(p.webgpu?.core) && !isNvidiaWebgpu(p.webgpu?.compat)) {
        problems.push(
          `No working NVIDIA WebGPU adapter: core ${report?.summary?.webgpuAdapter ?? "none"}; compatibility ${report?.summary?.webgpuCompatAdapter ?? "none"}`,
        );
      }
      if (problems.length === 0) {
        verifiedBackends.push("webgl2");
        if (isNvidiaWebgpu(p.webgpu?.core) && p.webgpu?.core?.presentOk === true) {
          verifiedBackends.push("webgpu");
        }
      }
    } else {
      if (!isNvidiaWebgpu(p.webgpu?.core)) {
        problems.push(
          `The core WebGPU adapter isn't a working NVIDIA one: ${report?.summary?.webgpuAdapter ?? "none"}`,
        );
      }
      presentationMode = p.webgpu?.core?.presentOk === true ? "onscreen" : "render-only";
      if (problems.length === 0) {
        verifiedBackends.push("webgpu");
      }
    }
  } else if (browserName === "firefox" && expect === "gpu") {
    if (!p.canvas2d?.readbackOk) problems.push(`2D canvas read back ${p.canvas2d?.pixel}`);
    const webgpuCore = p.webgpu?.core;
    const webgpuPresents = Boolean(
      webgpuCore?.adapter &&
        !webgpuCore.adapter.isFallbackAdapter &&
        webgpuIdentityClass !== "software" &&
        webgpuCore.bufferReadbackOk === true &&
        webgpuCore.presentOk === true,
    );
    const webgpuHardwareProven =
      webgpuPresents &&
      (webgpuIdentityClass === "hardware" ||
        (webgpuIdentityClass === "unknown" &&
          (hostGpuOk === true ||
            (typeof webgpuCore?.gpuProbeMs === "number" &&
              webgpuCore.gpuProbeMs <= HARDWARE_FILL_MAX_MS))));
    const webglHardwareProven = Boolean(
      p.webgl?.available &&
        p.webgl?.readbackOk === true &&
        p.webgl?.presentOk === true &&
        webglIdentityClass === "hardware",
    );
    if (webgpuHardwareProven || webglHardwareProven) {
      presentationMode = "onscreen";
      if (problems.length === 0) {
        if (webgpuHardwareProven) verifiedBackends.push("webgpu");
        if (webglHardwareProven) verifiedBackends.push("webgl2");
      }
    } else {
      problems.push(
        `Firefox gpu gate requires verified hardware WebGPU presentation (identity=${webgpuIdentityClass}, hostGpuOk=${hostGpuOk}, presentOk=${webgpuCore?.presentOk ?? false}) or explicit hardware WebGL2 (renderer=${renderer}, identity=${webglIdentityClass}, presentOk=${p.webgl?.presentOk ?? false})`,
      );
    }
  } else if (browserName === "webkit" && expect === "gpu") {
    if (!p.canvas2d?.readbackOk) problems.push(`2D canvas read back ${p.canvas2d?.pixel}`);
    if (!p.webgl?.available || !p.webgl?.readbackOk) {
      problems.push(`WebGL2 unavailable or read back ${p.webgl?.pixel}`);
    }
    if (p.webgl?.presentOk !== true) {
      problems.push(`WebKit WebGL2 onscreen presentation failed (pixel ${p.webgl?.presentPixel})`);
    } else {
      presentationMode = "onscreen";
    }
    if (webglIdentityClass === "none" || webglIdentityClass === "software") {
      problems.push(`WebKit WebGL2 renders in software or is unavailable: ${renderer}`);
    }
    // Keep the texture floor at 16384 so real macOS Safari Metal (16K max2DTextureSize) is
    // never refused; masked aliases ("Apple GPU", "WebKit WebGL") are verified by caveat + timing.
    if (typeof p.webgl?.maxTextureSize !== "number" || p.webgl.maxTextureSize < 16384) {
      problems.push(
        `WebKit WebGL2 maxTextureSize (${p.webgl?.maxTextureSize ?? "unknown"}) below hardware floor (16384) for renderer ${renderer}`,
      );
    }
    if (webglIdentityClass === "unknown") {
      if (p.webgl?.failIfMajorPerformanceCaveatOk === false) {
        problems.push(
          `WebKit WebGL2 failed failIfMajorPerformanceCaveat (software fallback behind ${renderer})`,
        );
      }
      const perfMs = p.webgl?.perfProbe?.ms;
      if (typeof perfMs !== "number") {
        problems.push(
          `WebKit WebGL2 has unknown adapter identity (${renderer}) without fill-rate timing verification`,
        );
      } else if (perfMs > HARDWARE_FILL_MAX_MS) {
        problems.push(
          `WebKit WebGL2 fill-rate probe took ${perfMs} ms (> ${HARDWARE_FILL_MAX_MS} ms), indicating software rendering behind ${renderer}`,
        );
      }
    }
    if (problems.length === 0) {
      verifiedBackends.push("webgl2");
    }
  } else if (expect === "cpu") {
    if (!p.canvas2d?.readbackOk) problems.push(`2D canvas read back ${p.canvas2d?.pixel}`);
    if (p.webgl?.available && webglIdentityClass === "hardware") {
      problems.push(`cpu mode unexpectedly exposed hardware WebGL renderer: ${renderer}`);
    } else if (p.webgl?.available && webglIdentityClass === "unknown") {
      const perfMs = p.webgl?.perfProbe?.ms;
      const provenSoftware =
        p.webgl?.failIfMajorPerformanceCaveatOk === false ||
        (typeof perfMs === "number" && perfMs >= SOFTWARE_FILL_MIN_MS);
      if (!provenSoftware) {
        problems.push(
          `cpu mode exposed unverified WebGL renderer ${renderer} (caveatOk=${p.webgl?.failIfMajorPerformanceCaveatOk ?? "unknown"}, perfMs=${perfMs ?? "none"} < ${SOFTWARE_FILL_MIN_MS} ms); cannot confirm software-only rendering`,
        );
      }
    }
    const webgpuCore = p.webgpu?.core;
    if (
      webgpuCore?.adapter &&
      !webgpuCore.adapter.isFallbackAdapter &&
      webgpuIdentityClass !== "software"
    ) {
      problems.push(
        `cpu mode unexpectedly exposed non-fallback WebGPU adapter: ${report?.summary?.webgpuAdapter ?? webgpuIdentityClass}`,
      );
    }
    presentationMode = "cpu";
    if (problems.length === 0) {
      verifiedBackends.push("cpu-worker");
    }
  }

  if (report) {
    report.problems = problems;
    if (report.summary) {
      report.summary.webglIdentityClass = webglIdentityClass;
      report.summary.webgpuIdentityClass = webgpuIdentityClass;
      report.summary.hostGpuOk = hostGpuOk;
      report.summary.presentationMode = presentationMode;
      report.summary.verifiedBackends = verifiedBackends;
    }
  }
  return {
    problems,
    presentationMode,
    webglIdentityClass,
    webgpuIdentityClass,
    verifiedBackends,
  };
}

/** Decodes a PNG buffer (8-bit RGB or RGBA, non-interlaced) and returns the center RGBA pixel. */
function readPngCenterPixel(png) {
  if (!png || png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  for (let off = 8; off + 12 <= png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("ascii");
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || !bpp) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowOff = y * stride;
    const srcOff = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[srcOff + x];
      const a = x >= bpp ? out[rowOff + x - bpp] : 0;
      const b = y > 0 ? out[rowOff - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[rowOff - stride + x - bpp] : 0;
      let recon = v;
      if (filter === 1) recon = (v + a) & 0xff;
      else if (filter === 2) recon = (v + b) & 0xff;
      else if (filter === 3) recon = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (v + paeth(a, b, c)) & 0xff;
      out[rowOff + x] = recon;
    }
  }
  const idx = ((height >> 1) * width + (width >> 1)) * bpp;
  return [out[idx], out[idx + 1], out[idx + 2], bpp === 4 ? out[idx + 3] : 255];
}

async function runGate() {
  const opts = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  }
  const {
    checkout,
    browser: browserName = "chromium",
    chrome,
    headless: headlessOpt = "true",
    "host-gpu-ok": hostGpuOkOpt = "false",
    expect = "gpu",
    out,
  } = opts;
  if (!out || (browserName === "chromium" && !chrome)) {
    console.error(
      "usage: gate.mjs [--checkout <repo>] [--browser chromium|firefox|webkit] [--chrome <wrapper>] [--headless true|false] [--host-gpu-ok true|false] --expect gpu|webgpu|cpu|info --out <dir>",
    );
    process.exit(64);
  }
  const headless = headlessOpt !== "false";
  const hostGpuOk = hostGpuOkOpt === "true";
  mkdirSync(out, { recursive: true });

  // The checkout's own Playwright, so the gate drives the same version the tests do.
  const pw = checkout
    ? createRequire(join(checkout, "apps/web/package.json"))("@playwright/test")
    : createRequire("/opt/node/lib/node_modules/")("playwright");
  const browserType = pw[browserName];
  if (!browserType) {
    console.error(`Unknown browser: ${browserName}`);
    process.exit(64);
  }

  const PAGE = `<!doctype html><meta charset="utf-8"><title>GPU gate</title>
<style>body{margin:0;background:#fff}canvas{display:inline-block;margin:8px;border:1px solid #ccc}</style>
<canvas id="c2d" width="512" height="512"></canvas><canvas id="cgl" width="512" height="512"></canvas><canvas id="cgpu" width="512" height="512"></canvas>`;

  const server = createServer((req, res) => {
    if (req.url === "/set-cookie") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "__Host-probe=1; Path=/; Secure; HttpOnly; SameSite=Strict",
      });
      res.end(JSON.stringify({ set: true }));
      return;
    }
    if (req.url === "/check-cookie") {
      const cookie = req.headers.cookie ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hasHostCookie: cookie.includes("__Host-probe=1"), cookie }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `http://localhost:${port}/`;

  const report = {
    browser: browserName,
    headless,
    hostGpuOk,
    expect,
    chrome: chrome ?? null,
    url,
    ok: false,
    problems: [],
  };

  const launchOptions = { headless };
  if (browserName === "chromium") {
    launchOptions.executablePath = chrome;
  } else if (browserName === "firefox") {
    if (chrome) launchOptions.executablePath = chrome;
    if (expect !== "cpu") {
      launchOptions.firefoxUserPrefs = {
        "gfx.webrender.all": true,
        "layers.acceleration.force-enabled": true,
        "webgl.force-enabled": true,
        "webgl.enable-webgl2": true,
        "dom.webgpu.enabled": true,
        "gfx.webgpu.ignore-blocklist": true,
        "gfx.x11-egl.force-enabled": true,
      };
    }
  } else if (browserName === "webkit" && chrome) {
    launchOptions.executablePath = chrome;
  }

  const browser = await browserType.launch(launchOptions);
  try {
    report.browserVersion = browser.version();
    const page = await browser.newPage();
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`pageerror: ${String(e)}`));
    await page.goto(url);
    report.probes = await page.evaluate(
      async ({ fillPasses, fillSide }) => {
        const result = { userAgent: navigator.userAgent, isSecureContext: window.isSecureContext };
        const near = (px, rgba, tol = 2) => rgba.every((v, i) => Math.abs(px[i] - v) <= tol);

        // Secure (__Host-) cookie test on http://localhost.
        try {
          await fetch("/set-cookie", { credentials: "include" });
          const check = await (await fetch("/check-cookie", { credentials: "include" })).json();
          result.hostCookieOnHttpLocalhost = check.hasHostCookie;
        } catch (error) {
          result.hostCookieOnHttpLocalhost = String(error);
        }

        // WebGPU probe.
        const adapterInfo = (adapter) => {
          const i = adapter.info ?? {};
          return {
            vendor: i.vendor,
            architecture: i.architecture,
            device: i.device,
            description: i.description,
            isFallbackAdapter: i.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
            featureLevel: adapter.featureLevel ?? null,
            maxTextureDimension2D: adapter.limits?.maxTextureDimension2D ?? null,
          };
        };
        const liveDevices = [];
        window.__gateCleanup = () => {
          for (const d of liveDevices) {
            try {
              d.destroy();
            } catch {}
          }
          liveDevices.length = 0;
        };
        const probeAdapter = async (options, keepPresented = false) => {
          let adapter = null;
          for (let attempt = 0; attempt < 3 && !adapter; attempt++) {
            try {
              adapter = await navigator.gpu.requestAdapter(options);
            } catch (error) {
              return { adapter: null, error: String(error) };
            }
            if (!adapter) await new Promise((r) => setTimeout(r, 300));
          }
          if (!adapter) return { adapter: null };
          const outProbe = { adapter: adapterInfo(adapter), canvasSubmitted: false };
          try {
            const device = await adapter.requestDevice();
            const clear = (view) => {
              const encoder = device.createCommandEncoder();
              encoder
                .beginRenderPass({
                  colorAttachments: [
                    {
                      view,
                      clearValue: { r: 0, g: 0, b: 1, a: 1 },
                      loadOp: "clear",
                      storeOp: "store",
                    },
                  ],
                })
                .end();
              return encoder;
            };
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
            outProbe.bufferPixel = px;
            outProbe.bufferReadbackOk = near(px, [0, 0, 255, 255]);
            try {
              const canvas = document.getElementById("cgpu");
              const ctx = canvas.getContext("webgpu");
              if (ctx) {
                ctx.configure({
                  device,
                  format: navigator.gpu.getPreferredCanvasFormat(),
                  alphaMode: "opaque",
                });
                device.queue.submit([clear(ctx.getCurrentTexture().createView()).finish()]);
                await device.queue.onSubmittedWorkDone();
                outProbe.canvasSubmitted = true;
                // Wait one paint tick so onscreen presentation lands before screenshot.
                await new Promise((r) => requestAnimationFrame(() => r()));
                try {
                  const copy = document.createElement("canvas");
                  copy.width = 512;
                  copy.height = 512;
                  const c2 = copy.getContext("2d");
                  c2.drawImage(canvas, 0, 0);
                  const cpx = [...c2.getImageData(256, 256, 1, 1).data];
                  outProbe.canvasPixel = cpx;
                  outProbe.canvasReadbackOk = near(cpx, [0, 0, 255, 255]);
                } catch (copyErr) {
                  outProbe.canvasReadbackOk = false;
                  outProbe.canvasReadbackError = String(copyErr);
                }
              }
            } catch (err) {
              outProbe.canvasError = String(err);
            }
            // Keep device alive for onscreen screenshot whenever submission succeeded,
            // independent of whether 2D drawImage canvas copy readback succeeded.
            if (keepPresented && outProbe.canvasSubmitted) {
              liveDevices.push(device);
            } else {
              device.destroy();
            }
          } catch (error) {
            outProbe.error = String(error);
          }
          return outProbe;
        };
        if (!navigator.gpu) result.webgpu = { available: false };
        else {
          const compat = await probeAdapter(
            {
              featureLevel: "compatibility",
              powerPreference: "high-performance",
            },
            false,
          );
          const core = await probeAdapter({ powerPreference: "high-performance" }, true);
          result.webgpu = {
            available: true,
            core,
            compat,
          };
        }

        // 2D canvas readback.
        const c2d = document.getElementById("c2d").getContext("2d");
        c2d.fillStyle = "rgb(255,0,0)";
        c2d.fillRect(0, 0, 512, 512);
        const px2d = [...c2d.getImageData(256, 256, 1, 1).data];
        result.canvas2d = { pixel: px2d, readbackOk: near(px2d, [255, 0, 0, 255]) };

        // WebGL2 probe.
        const gl = document
          .getElementById("cgl")
          .getContext("webgl2", { preserveDrawingBuffer: true });
        if (!gl) result.webgl = { available: false };
        else {
          const info = gl.getExtension("WEBGL_debug_renderer_info");
          gl.clearColor(0, 1, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const px = new Uint8Array(4);
          gl.readPixels(256, 256, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

          // Probe failIfMajorPerformanceCaveat and calibrated ALU fill-rate on a detached
          // canvas so #cgl remains clean green for the onscreen screenshot check.
          let failIfMajorPerformanceCaveatOk = null;
          try {
            const cav = document.createElement("canvas");
            const cgl = cav.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
            failIfMajorPerformanceCaveatOk = !!cgl;
            cgl?.getExtension("WEBGL_lose_context")?.loseContext();
          } catch {
            failIfMajorPerformanceCaveatOk = false;
          }

          let perfProbe = null;
          try {
            const pc = document.createElement("canvas");
            pc.width = fillSide;
            pc.height = fillSide;
            const pgl = pc.getContext("webgl2");
            if (pgl) {
              const vs = pgl.createShader(pgl.VERTEX_SHADER);
              const fs = pgl.createShader(pgl.FRAGMENT_SHADER);
              const prog = pgl.createProgram();
              pgl.shaderSource(
                vs,
                `#version 300 es
void main() {
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}`,
              );
              pgl.compileShader(vs);
              pgl.shaderSource(
                fs,
                `#version 300 es
precision highp float;
uniform float u_pass;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * 0.001953125 + vec2(u_pass * 0.13, u_pass * 0.07);
  float acc = 0.25;
  for (int i = 0; i < 64; i++) {
    float fi = float(i) * 0.17 + acc * 0.05;
    acc = fract(abs(acc + sin(p.x * 12.9898 + fi) * cos(p.y * 78.233 - fi)));
  }
  outColor = vec4(acc, 0.5, 0.25, 1.0);
}`,
              );
              pgl.compileShader(fs);
              pgl.attachShader(prog, vs);
              pgl.attachShader(prog, fs);
              pgl.linkProgram(prog);
              if (pgl.getProgramParameter(prog, pgl.LINK_STATUS)) {
                pgl.viewport(0, 0, fillSide, fillSide);
                pgl.useProgram(prog);
                const loc = pgl.getUniformLocation(prog, "u_pass");
                const ppx = new Uint8Array(4);
                pgl.uniform1f(loc, 0);
                pgl.drawArrays(pgl.TRIANGLES, 0, 3);
                pgl.readPixels(0, 0, 1, 1, pgl.RGBA, pgl.UNSIGNED_BYTE, ppx);
                const t0 = performance.now();
                for (let i = 1; i <= fillPasses; i++) {
                  pgl.uniform1f(loc, i);
                  pgl.drawArrays(pgl.TRIANGLES, 0, 3);
                }
                pgl.readPixels(0, 0, 1, 1, pgl.RGBA, pgl.UNSIGNED_BYTE, ppx);
                perfProbe = {
                  ms: Math.round((performance.now() - t0) * 10) / 10,
                  passes: fillPasses,
                  side: fillSide,
                };
              }
              pgl.deleteProgram(prog);
              pgl.deleteShader(vs);
              pgl.deleteShader(fs);
              pgl.getExtension("WEBGL_lose_context")?.loseContext();
            }
          } catch (e) {
            perfProbe = { error: String(e), passes: fillPasses, side: fillSide };
          }

          result.webgl = {
            available: true,
            vendor: gl.getParameter(gl.VENDOR),
            renderer: gl.getParameter(gl.RENDERER),
            unmaskedVendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null,
            unmaskedRenderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
            version: gl.getParameter(gl.VERSION),
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            extColorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
            extColorBufferHalfFloat: !!gl.getExtension("EXT_color_buffer_half_float"),
            extFloatLinear: !!gl.getExtension("OES_texture_float_linear"),
            failIfMajorPerformanceCaveatOk,
            perfProbe,
            pixel: [...px],
            readbackOk: near([...px], [0, 255, 0, 255]),
          };
        }

        // WebKit / cross-browser glass trap probes (mirrors packages/editor/src/glass.ts).
        const traps = {};
        const readCenter = (canvas) => {
          const outC = document.createElement("canvas");
          outC.width = canvas.width;
          outC.height = canvas.height;
          const ctx = outC.getContext("2d");
          ctx.drawImage(canvas, 0, 0);
          return [...ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data];
        };
        const makeQuad = (glCtx, fragSrc) => {
          const vs = glCtx.createShader(glCtx.VERTEX_SHADER);
          glCtx.shaderSource(
            vs,
            "#version 300 es\nin vec2 c; out vec2 uv; void main(){ uv = c; gl_Position = vec4(c*2.0-1.0, 0.0, 1.0); }",
          );
          glCtx.compileShader(vs);
          const fs = glCtx.createShader(glCtx.FRAGMENT_SHADER);
          glCtx.shaderSource(fs, fragSrc);
          glCtx.compileShader(fs);
          const prog = glCtx.createProgram();
          glCtx.attachShader(prog, vs);
          glCtx.attachShader(prog, fs);
          glCtx.bindAttribLocation(prog, 0, "c");
          glCtx.linkProgram(prog);
          if (!glCtx.getProgramParameter(prog, glCtx.LINK_STATUS)) {
            throw new Error(
              `link failed: vs=${glCtx.getShaderInfoLog(vs)} fs=${glCtx.getShaderInfoLog(fs)} prog=${glCtx.getProgramInfoLog(prog)}`,
            );
          }
          const buf = glCtx.createBuffer();
          glCtx.bindBuffer(glCtx.ARRAY_BUFFER, buf);
          glCtx.bufferData(
            glCtx.ARRAY_BUFFER,
            new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
            glCtx.STATIC_DRAW,
          );
          glCtx.enableVertexAttribArray(0);
          glCtx.vertexAttribPointer(0, 2, glCtx.FLOAT, false, 0, 0);
          return prog;
        };

        // 1. OffscreenCanvas 2D self-drawImage (copyExtended).
        try {
          const oc = new OffscreenCanvas(64, 64);
          const ctx = oc.getContext("2d");
          ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = "rgb(200,100,50)";
          ctx.fillRect(10, 10, 44, 44);
          ctx.drawImage(oc, 10, 10, 1, 44, 0, 10, 10, 44);
          const edgePx = [...ctx.getImageData(4, 32, 1, 1).data];
          traps.copyExtendedSelf = { pixel: edgePx, ok: near(edgePx, [200, 100, 50, 255]) };
        } catch (e) {
          traps.copyExtendedSelf = { error: String(e), ok: false };
        }

        // 2. OffscreenCanvas WebGL2 -> 2D drawImage (default vs preserveDrawingBuffer) + HTMLCanvas.
        for (const [name, useOffscreen, preserve] of [
          ["offscreenGlTo2d_default", true, false],
          ["offscreenGlTo2d_preserve", true, true],
          ["htmlGlTo2d_default", false, false],
        ]) {
          try {
            const c = useOffscreen ? new OffscreenCanvas(64, 64) : document.createElement("canvas");
            c.width = 64;
            c.height = 64;
            const g = c.getContext("webgl2", {
              premultipliedAlpha: true,
              antialias: false,
              ...(preserve ? { preserveDrawingBuffer: true } : {}),
            });
            if (!g) {
              traps[name] = { ok: false, error: "no webgl2" };
              continue;
            }
            g.clearColor(0, 1, 0, 1);
            g.clear(g.COLOR_BUFFER_BIT);
            const px = readCenter(c);
            traps[name] = { pixel: px, ok: near(px, [0, 255, 0, 255]) };
            g.getExtension("WEBGL_lose_context")?.loseContext();
          } catch (e) {
            traps[name] = { error: String(e), ok: false };
          }
        }

        // 3. texImage2D from 2D OffscreenCanvas (unpremul vs premul, NPOT mipmap + textureGrad).
        for (const [name, premul, mipmap, useGrad, w, h] of [
          ["texOffscreen2d_plain", false, false, false, 64, 64],
          ["texOffscreen2d_premul", true, false, false, 64, 64],
          ["texOffscreen2d_mipmap_pot", true, true, true, 128, 128],
          ["texOffscreen2d_mipmap_npot", true, true, true, 200, 150],
        ]) {
          try {
            const src = new OffscreenCanvas(w, h);
            const sctx = src.getContext("2d");
            sctx.fillStyle = "rgb(220,60,30)";
            sctx.fillRect(0, 0, w, h);
            const dst = new OffscreenCanvas(w, h);
            const g = dst.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
            if (!g) {
              traps[name] = { ok: false, error: "no webgl2" };
              continue;
            }
            const frag = useGrad
              ? "#version 300 es\nprecision highp float; in vec2 uv; out vec4 color; uniform sampler2D t; void main(){ color = textureGrad(t, uv, dFdx(uv), dFdy(uv)); }"
              : "#version 300 es\nprecision highp float; in vec2 uv; out vec4 color; uniform sampler2D t; void main(){ color = texture(t, uv); }";
            const prog = makeQuad(g, frag);
            const tex = g.createTexture();
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, tex);
            g.texParameteri(
              g.TEXTURE_2D,
              g.TEXTURE_MIN_FILTER,
              mipmap ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR,
            );
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
            g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul);
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
            if (mipmap) g.generateMipmap(g.TEXTURE_2D);
            g.useProgram(prog);
            g.uniform1i(g.getUniformLocation(prog, "t"), 0);
            g.viewport(0, 0, w, h);
            g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
            const glErr = g.getError();
            const glPx = new Uint8Array(4);
            g.readPixels(w >> 1, h >> 1, 1, 1, g.RGBA, g.UNSIGNED_BYTE, glPx);
            const drawPx = readCenter(dst);
            traps[name] = {
              glErr,
              glPixel: [...glPx],
              drawPixel: drawPx,
              ok:
                glErr === 0 &&
                near([...glPx], [220, 60, 30, 255], 4) &&
                near(drawPx, [220, 60, 30, 255], 4),
            };
            g.getExtension("WEBGL_lose_context")?.loseContext();
          } catch (e) {
            traps[name] = { error: String(e), ok: false };
          }
        }

        // 4. RGBA16F FBO + HALF_FLOAT + LINEAR sampling.
        try {
          const dst = new OffscreenCanvas(64, 64);
          const g = dst.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
          if (!g) {
            traps.rgba16fFbo = { ok: false, error: "no webgl2" };
          } else {
            const extF = !!g.getExtension("EXT_color_buffer_float");
            const extHF = !!g.getExtension("EXT_color_buffer_half_float");
            const tex = g.createTexture();
            g.bindTexture(g.TEXTURE_2D, tex);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, 64, 64, 0, g.RGBA, g.HALF_FLOAT, null);
            const fb = g.createFramebuffer();
            g.bindFramebuffer(g.FRAMEBUFFER, fb);
            g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
            const status = g.checkFramebufferStatus(g.FRAMEBUFFER);
            let glPx = [];
            let drawPx = [];
            let glErr = 0;
            if (status === g.FRAMEBUFFER_COMPLETE) {
              g.viewport(0, 0, 64, 64);
              g.clearColor(0.75, 0.25, 0.5, 1.0);
              g.clear(g.COLOR_BUFFER_BIT);
              g.bindFramebuffer(g.FRAMEBUFFER, null);
              const prog = makeQuad(
                g,
                "#version 300 es\nprecision highp float; in vec2 uv; out vec4 color; uniform sampler2D t; void main(){ color = texture(t, uv); }",
              );
              g.activeTexture(g.TEXTURE0);
              g.bindTexture(g.TEXTURE_2D, tex);
              g.useProgram(prog);
              g.uniform1i(g.getUniformLocation(prog, "t"), 0);
              g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
              glErr = g.getError();
              const buf = new Uint8Array(4);
              g.readPixels(32, 32, 1, 1, g.RGBA, g.UNSIGNED_BYTE, buf);
              glPx = [...buf];
              drawPx = readCenter(dst);
            }
            traps.rgba16fFbo = {
              extF,
              extHF,
              fbComplete: status === g.FRAMEBUFFER_COMPLETE,
              status,
              glErr,
              glPixel: glPx,
              drawPixel: drawPx,
              ok:
                status === g.FRAMEBUFFER_COMPLETE &&
                glErr === 0 &&
                near(drawPx, [191, 64, 128, 255], 4),
            };
            g.getExtension("WEBGL_lose_context")?.loseContext();
          }
        } catch (e) {
          traps.rgba16fFbo = { error: String(e), ok: false };
        }

        // 5. Canvas 2D ctx.filter = "blur(4px)".
        try {
          const c = document.createElement("canvas");
          c.width = 64;
          c.height = 64;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, 32, 64);
          ctx.fillStyle = "#fff";
          ctx.fillRect(32, 0, 32, 64);
          const outC = document.createElement("canvas");
          outC.width = 64;
          outC.height = 64;
          const octx = outC.getContext("2d");
          octx.filter = "blur(4px)";
          octx.drawImage(c, 0, 0);
          const edge = [...octx.getImageData(32, 32, 1, 1).data];
          traps.ctxFilterBlur = { pixel: edge, ok: edge[0] > 40 && edge[0] < 215 };
        } catch (e) {
          traps.ctxFilterBlur = { error: String(e), ok: false };
        }

        result.glassTraps = traps;
        return result;
      },
      { fillPasses: FILL_PROBE_PASSES, fillSide: FILL_PROBE_SIDE },
    );

    await page.screenshot({ path: join(out, "gate.png") });
    // Verify actual onscreen compositor presentation via element screenshots.
    const nearRgba = (px, target, tol = 8) =>
      Array.isArray(px) && target.every((v, i) => Math.abs((px[i] ?? -999) - v) <= tol);
    if (report.probes.webgl?.available) {
      try {
        const glShot = await page.locator("#cgl").screenshot();
        const px = readPngCenterPixel(glShot);
        report.probes.webgl.presentPixel = px;
        report.probes.webgl.presentOk = nearRgba(px, [0, 255, 0, 255]);
      } catch (e) {
        report.probes.webgl.presentOk = false;
        report.probes.webgl.presentError = String(e);
      }
    }
    // Screenshot #cgpu whenever WebGPU submitted to it, independent of 2D canvas-copy readback.
    if (report.probes.webgpu?.core?.canvasSubmitted) {
      try {
        const gpuShot = await page.locator("#cgpu").screenshot();
        const px = readPngCenterPixel(gpuShot);
        report.probes.webgpu.core.presentPixel = px;
        report.probes.webgpu.core.presentOk = nearRgba(px, [0, 0, 255, 255]);
      } catch (e) {
        report.probes.webgpu.core.presentOk = false;
        report.probes.webgpu.core.presentError = String(e);
      }
    }
    // Measure rAF vs 2D vs WebGPU presentation cadence to isolate compositor overhead (e.g. Xvfb).
    report.probes.framePacing = await page.evaluate(async () => {
      const median = (times) => {
        const gaps = times
          .slice(1)
          .map((t, i) => t - times[i])
          .sort((a, b) => a - b);
        return gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10 : null;
      };
      const next = () => new Promise((r) => requestAnimationFrame(() => r()));
      const measure = async (fn, n = 20) => {
        await next();
        const times = [];
        for (let i = 0; i < n; i++) {
          await fn(i);
          await next();
          times.push(performance.now());
        }
        return median(times);
      };
      const outP = {};
      outP.emptyRafMs = await measure(() => {});
      const c2 = document.createElement("canvas");
      c2.width = 2880;
      c2.height = 1800;
      c2.style.cssText = "position:fixed;inset:0;width:1440px;height:900px;pointer-events:none";
      document.body.appendChild(c2);
      const ctx2 = c2.getContext("2d");
      outP.canvas2d2880Ms = await measure((i) => {
        ctx2.fillStyle = i % 2 ? "#e8e7e2" : "#f4f3ef";
        ctx2.fillRect(0, 0, 2880, 1800);
      });
      c2.remove();
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance",
          });
          if (adapter) {
            const device = await adapter.requestDevice();
            for (const [label, w, h] of [
              ["webgpu1440Ms", 1440, 900],
              ["webgpu2880Ms", 2880, 1800],
            ]) {
              const cg = document.createElement("canvas");
              cg.width = w;
              cg.height = h;
              cg.style.cssText =
                "position:fixed;inset:0;width:1440px;height:900px;pointer-events:none";
              document.body.appendChild(cg);
              const gctx = cg.getContext("webgpu");
              if (gctx) {
                gctx.configure({
                  device,
                  format: navigator.gpu.getPreferredCanvasFormat(),
                  alphaMode: "opaque",
                });
                outP[label] = await measure((i) => {
                  const enc = device.createCommandEncoder();
                  enc
                    .beginRenderPass({
                      colorAttachments: [
                        {
                          view: gctx.getCurrentTexture().createView(),
                          clearValue: { r: i % 2 ? 0.2 : 0.4, g: 0.5, b: 0.8, a: 1 },
                          loadOp: "clear",
                          storeOp: "store",
                        },
                      ],
                    })
                    .end();
                  device.queue.submit([enc.finish()]);
                });
              }
              cg.remove();
            }
            device.destroy();
          }
        } catch (e) {
          outP.webgpuError = String(e);
        }
      }
      window.__gateCleanup?.();
      return outP;
    });

    report.features = {};
    report.glRenderer = null;
    if (browserName === "chromium") {
      await page.goto("chrome://gpu");
      await page.waitForTimeout(2000);
      const gpuText = await page.evaluate(() => {
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
      )) {
        features[m[1].trim()] = m[2].trim();
      }
      report.features = features;
      report.glRenderer = gpuText.match(/GL_RENDERER\s+([^\n]+)/)?.[1]?.trim() ?? null;
    }
    report.console = consoleLines;
  } finally {
    await browser.close();
    server.close();
  }

  const p = report.probes;
  const describe = (probe) => {
    const a = probe?.adapter;
    if (!a) return "none";
    const name =
      [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(" / ") ||
      "unidentified";
    const works = probe.bufferReadbackOk
      ? "renders"
      : `doesn't render (${probe.error ?? probe.bufferPixel})`;
    const canvas = probe.presentOk
      ? "presents onscreen"
      : probe.canvasReadbackOk
        ? "canvas readback ok"
        : "no onscreen present";
    return `${name}${a.isFallbackAdapter ? " (fallback)" : ""}, ${works}, ${canvas}`;
  };
  report.summary = {
    browser: browserName,
    browserVersion: report.browserVersion,
    headless,
    hostGpuOk,
    webgpuAdapter: describe(p.webgpu?.core),
    webgpuCompatAdapter: describe(p.webgpu?.compat),
    webgpuIdentityClass: classifyWebgpuIdentity(p.webgpu?.core?.adapter),
    webglRenderer: p.webgl?.unmaskedRenderer ?? p.webgl?.renderer ?? "none",
    webglIdentityClass: p.webgl?.available
      ? classifyWebglIdentity(p.webgl?.unmaskedRenderer ?? p.webgl?.renderer ?? "none")
      : "none",
    webglMaxTextureSize: p.webgl?.maxTextureSize ?? null,
    webglCaveatOk: p.webgl?.failIfMajorPerformanceCaveatOk ?? null,
    webglPerfProbeMs: p.webgl?.perfProbe?.ms ?? null,
    hostCookieOnHttpLocalhost: p.hostCookieOnHttpLocalhost,
    canvas: report.features.Canvas ?? "n/a",
    rasterization: report.features.Rasterization ?? "n/a",
    compositing: report.features.Compositing ?? "n/a",
    webgl: report.features.WebGL ?? (p.webgl?.available ? "available" : "unavailable"),
    webglPresentOk: p.webgl?.presentOk ?? null,
    webgpu: report.features.WebGPU ?? (p.webgpu?.available ? "available" : "unavailable"),
    webgpuPresentOk: p.webgpu?.core?.presentOk ?? null,
    presentationMode: "none",
    framePacing: p.framePacing ?? null,
    glassTrapsFailed: Object.entries(p.glassTraps ?? {})
      .filter(([, v]) => !v.ok)
      .map(([k]) => k),
  };

  const { problems } = evaluatePolicy({
    browserName,
    expect,
    report,
    probes: p,
    hostGpuOk,
  });
  report.ok = problems.length === 0;
  writeFileSync(join(out, "gate.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    [
      `GPU gate (${browserName}, ${expect}, headless=${headless}, hostGpuOk=${hostGpuOk}): ${report.ok ? "passed" : "FAILED"}`,
      `  ${browserName} ${report.browserVersion}`,
      `  presentationMode: ${report.summary.presentationMode}`,
      `  WebGPU adapter: ${report.summary.webgpuAdapter} (identity=${report.summary.webgpuIdentityClass})`,
      `  WebGPU adapter, compatibility mode: ${report.summary.webgpuCompatAdapter}`,
      `  WebGL renderer: ${report.summary.webglRenderer} (identity=${report.summary.webglIdentityClass}, maxTextureSize=${report.summary.webglMaxTextureSize}, caveatOk=${report.summary.webglCaveatOk}, perfMs=${report.summary.webglPerfProbeMs}, presentOk=${report.summary.webglPresentOk})`,
      `  WebGPU presentOk: ${report.summary.webgpuPresentOk}`,
      ...(report.summary.framePacing
        ? [`  frame pacing (median ms): ${JSON.stringify(report.summary.framePacing)}`]
        : []),
      `  __Host- cookie on http://localhost: ${report.summary.hostCookieOnHttpLocalhost}`,
      `  glass traps failed: ${report.summary.glassTrapsFailed.length ? report.summary.glassTrapsFailed.join(", ") : "none"}`,
      ...(browserName === "chromium"
        ? [
            `  chrome://gpu: Canvas ${report.summary.canvas}; Rasterization ${report.summary.rasterization}; Compositing ${report.summary.compositing}; WebGL ${report.summary.webgl}; WebGPU ${report.summary.webgpu}`,
          ]
        : []),
      ...problems.map((x) => `  problem: ${x}`),
    ].join("\n"),
  );
  process.exit(report.ok ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGate();
}
