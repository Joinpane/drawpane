// The spike's page (decision 0040): draws the board's display list with the engine on WebGPU,
// times it, reads the pixels back, and draws it on the CPU in the same page for comparison.
// Loaded by e2e/browser.spec.ts from its own routes; `window.spike` holds the result.
import init, { GpuEngine, renderCpu } from "./engine/engine.js";

const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const runs = Number(params.get("runs") ?? 9);

async function adapterInfo() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const info = adapter.info ?? {};
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? null,
  };
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function webglRenderer(canvas) {
  const gl = canvas.getContext("webgl2");
  if (!gl) return null;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
}

async function run() {
  const backend = params.get("backend") ?? "webgpu";
  const t0 = performance.now();
  await init();
  const initMs = performance.now() - t0;
  const list = new Uint8Array(await (await fetch("./board.dl")).arrayBuffer());
  const view = new DataView(list.buffer);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  // The adapter as the browser reports it. The engine's own adapter (wgpu's view) is recorded
  // beside it, and the label below goes by both.
  let adapter;
  let glCanvas;
  if (backend === "webgl") {
    // wgpu's GL backend takes its WebGL2 context from this canvas; probe it in a spare one.
    adapter = webglRenderer(document.createElement("canvas"));
    glCanvas = document.createElement("canvas");
  } else adapter = await adapterInfo();
  status.textContent = "Creating the GPU engine…";
  const t1 = performance.now();
  const engine = await GpuEngine.create(width, height, backend, glCanvas);
  const createMs = performance.now() - t1;
  const described = JSON.stringify(adapter ?? {}) + engine.adapter;
  const software =
    !adapter ||
    adapter.isFallbackAdapter === true ||
    /swiftshader|llvmpipe|software|\(Cpu,/i.test(described);
  if (params.get("vello-src-over") === "0") engine.setVelloSrcOver(false);
  const times = [];
  const encode = [];
  let frame;
  for (let i = 0; i < runs + 1; i++) {
    const t = performance.now();
    frame = engine.render(list);
    const t2 = performance.now();
    await engine.finish();
    const ms = performance.now() - t;
    // The first frame compiles pipelines and fills caches; it's reported apart.
    times.push(ms);
    encode.push(t2 - t);
  }
  const gpuPixels = await engine.pixels();
  const t = performance.now();
  const cpu = renderCpu(list);
  const cpuMs = performance.now() - t;
  const cpuPixels = cpu.rgba();
  const canvas = document.getElementById("out");
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext("2d")
    .putImageData(
      new ImageData(
        new Uint8ClampedArray(gpuPixels.buffer, gpuPixels.byteOffset, gpuPixels.length),
        width,
        height,
      ),
      0,
      0,
    );
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  window.spike = {
    width,
    height,
    backend,
    adapter,
    wgpuAdapter: engine.adapter,
    initMs: Math.round(initMs),
    createMs: Math.round(createMs),
    software,
    note: software ? "software adapter, not representative" : "hardware adapter",
    frame: {
      ops: frame.ops,
      flushes: frame.flushes,
      apart: frame.apart,
      glass: frame.glass,
      submits: frame.submits,
    },
    gpu: {
      firstMs: Math.round(times[0]),
      medianMs: Math.round(median(times.slice(1)) * 10) / 10,
      encodeMedianMs: Math.round(median(encode.slice(1)) * 10) / 10,
      runs: times.slice(1).map((v) => Math.round(v * 10) / 10),
    },
    cpuInPageMs: Math.round(cpuMs),
    gpuPixels: base64(gpuPixels),
    cpuPixels: base64(cpuPixels),
  };
  status.textContent = `Drawn: ${width}×${height} on ${software ? "a software adapter (timings not representative)" : "the GPU"}.`;
}

run().catch((error) => {
  window.spike = { error: String(error?.stack ?? error) };
  status.textContent = `Failed: ${error}`;
});
