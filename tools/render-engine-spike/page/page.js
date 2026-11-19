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

async function run() {
  await init();
  const list = new Uint8Array(await (await fetch("./board.dl")).arrayBuffer());
  const view = new DataView(list.buffer);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const adapter = await adapterInfo();
  const software =
    !adapter ||
    adapter.isFallbackAdapter === true ||
    /swiftshader|llvmpipe|software/i.test(
      `${adapter.vendor} ${adapter.architecture} ${adapter.description}`,
    );
  status.textContent = "Creating the GPU engine…";
  const engine = await GpuEngine.create(width, height);
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
    adapter,
    wgpuAdapter: engine.adapter,
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
