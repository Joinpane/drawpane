/**
 * Policy regression tests for `tools/gpu-bench/gate.mjs`:
 * verifies honest adapter identity classification, Safari 16K Metal safety, masked software
 * rejection in `gpu` mode, hardware rejection in `cpu` mode, Firefox blank-WebGPU host-evidence
 * requirement, and Chromium `webgpu` render-only labeling.
 */
import assert from "node:assert/strict";
import { classifyWebglIdentity, classifyWebgpuIdentity, evaluatePolicy } from "./gate.mjs";

function runPolicy({ browserName, expect, renderer, p, features = {}, hostGpuOk = false }) {
  const report = {
    features,
    summary: {
      webglRenderer: renderer,
      webgpuAdapter: p.webgpu?.core?.adapter ? "adapter" : "none",
      webgpuCompatAdapter: "none",
    },
  };
  const res = evaluatePolicy({ browserName, expect, report, probes: p, hostGpuOk });
  return { ...res, summary: report.summary };
}

// 1. Honest identity classification: privacy masks and generic labels report "unknown".
assert.equal(classifyWebglIdentity("ANGLE (NVIDIA, Vulkan, Tesla T4)"), "hardware");
assert.equal(classifyWebglIdentity("ANGLE (Apple, ANGLE Metal Renderer: Apple M3)"), "hardware");
assert.equal(classifyWebglIdentity("llvmpipe (LLVM, 128 bits)"), "software");
assert.equal(classifyWebglIdentity("Google SwiftShader"), "software");
assert.equal(classifyWebglIdentity("Apple GPU"), "unknown");
assert.equal(classifyWebglIdentity("Apple Inc. / Apple GPU"), "unknown");
assert.equal(classifyWebglIdentity("WebKit WebGL"), "unknown");
assert.equal(classifyWebglIdentity("Mozilla"), "unknown");
assert.equal(classifyWebglIdentity(""), "none");
assert.equal(
  classifyWebgpuIdentity({ vendor: "", description: "", isFallbackAdapter: false }),
  "unknown",
);
assert.equal(
  classifyWebgpuIdentity({
    vendor: "nvidia",
    description: "NVIDIA Tesla T4",
    isFallbackAdapter: false,
  }),
  "hardware",
);
assert.equal(
  classifyWebgpuIdentity({ vendor: "", description: "llvmpipe", isFallbackAdapter: false }),
  "software",
);
assert.equal(
  classifyWebgpuIdentity({ vendor: "nvidia", description: "NVIDIA", isFallbackAdapter: true }),
  "software",
);

// 2. Software WebGL (llvmpipe) without hardware WebGPU must FAIL gpu mode on Firefox and WebKit.
for (const browserName of ["firefox", "webkit"]) {
  const { problems } = runPolicy({
    browserName,
    expect: "gpu",
    renderer: "llvmpipe (LLVM, 128 bits)",
    p: {
      canvas2d: { readbackOk: true },
      webgl: { available: true, readbackOk: true, presentOk: true },
    },
  });
  assert(problems.length > 0, `${browserName} gpu gate must reject llvmpipe software rendering`);
}

// 3. Explicit hardware NVIDIA renderer must FAIL cpu mode on Chromium, Firefox, and WebKit.
for (const browserName of ["chromium", "firefox", "webkit"]) {
  const { problems } = runPolicy({
    browserName,
    expect: "cpu",
    renderer: "NVIDIA T4",
    p: { canvas2d: { readbackOk: true }, webgl: { available: true, readbackOk: true } },
  });
  assert(problems.length > 0, `${browserName} cpu gate must reject hardware NVIDIA renderer`);
}

// 4. Firefox gpu mode:
//    - Blank non-fallback WebGPU WITHOUT hostGpuOk or timing FAILS (never conflates blank with hardware).
//    - Blank non-fallback WebGPU WITH hostGpuOk + presentOk PASSES even if canvasReadbackOk is false.
//    - Generic "WebKit WebGL" FAILS Firefox gpu mode even if presentOk is true.
const blankFirefoxGpu = {
  canvas2d: { readbackOk: true },
  webgl: { available: true, readbackOk: true, presentOk: false },
  webgpu: {
    core: {
      adapter: { vendor: "", description: "", isFallbackAdapter: false },
      bufferReadbackOk: true,
      canvasReadbackOk: false,
      presentOk: true,
    },
  },
};
assert(
  runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "llvmpipe, or similar",
    p: blankFirefoxGpu,
    hostGpuOk: false,
  }).problems.length > 0,
  "Firefox gpu gate must reject blank WebGPU identity when hostGpuOk is false",
);
{
  const res = runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "llvmpipe, or similar",
    p: blankFirefoxGpu,
    hostGpuOk: true,
  });
  assert.equal(
    res.problems.length,
    0,
    "Firefox gpu gate should pass with hostGpuOk + presentOk even without 2D canvasReadbackOk",
  );
  assert.equal(res.webgpuIdentityClass, "unknown");
  assert.equal(res.presentationMode, "onscreen");
}
assert(
  runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "llvmpipe, or similar",
    p: {
      ...blankFirefoxGpu,
      webgpu: { core: { ...blankFirefoxGpu.webgpu.core, presentOk: false } },
    },
    hostGpuOk: true,
  }).problems.length > 0,
  "Firefox gpu gate must fail when onscreen WebGPU presentation fails",
);
assert(
  runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "WebKit WebGL",
    p: {
      canvas2d: { readbackOk: true },
      webgl: { available: true, readbackOk: true, presentOk: true },
    },
    hostGpuOk: true,
  }).problems.length > 0,
  "Firefox gpu gate must reject generic WebKit WebGL label",
);

// 5. WebKit gpu mode (Safari 16K Metal safe!):
//    - Real macOS Safari 16K Metal ("Apple GPU", 16384, caveatOk: true, fast fill probe) PASSES gpu!
//    - Linux WebKit T4 ("Apple GPU", 32768, caveatOk: true, fast fill probe) PASSES gpu!
//    - Masked Mesa llvmpipe ("Apple GPU", 16384, slow fill probe or caveatOk: false) FAILS gpu!
{
  const safari16k = runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 4.2, passes: 32, side: 512 },
      },
    },
  });
  assert.equal(
    safari16k.problems.length,
    0,
    "WebKit gpu gate must allow real 16K macOS Safari Metal when caveat + timing pass",
  );
  assert.equal(safari16k.webglIdentityClass, "unknown");
}
assert.equal(
  runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: true,
        maxTextureSize: 32768,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 3.1, passes: 32, side: 512 },
      },
    },
  }).problems.length,
  0,
  "WebKit gpu gate should pass with hardware EGL WebGL2 and onscreen presentation",
);
assert(
  runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 280, passes: 32, side: 512 },
      },
    },
  }).problems.length > 0,
  "WebKit gpu gate must reject slow masked Mesa llvmpipe",
);
assert(
  runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: false,
        perfProbe: { ms: 5, passes: 32, side: 512 },
      },
    },
  }).problems.length > 0,
  "WebKit gpu gate must reject failIfMajorPerformanceCaveat failure",
);
assert(
  runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: false,
        maxTextureSize: 32768,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 3, passes: 32, side: 512 },
      },
    },
  }).problems.length > 0,
  "WebKit gpu gate must fail when onscreen WebGL2 presentation fails",
);

// 6. cpu mode:
//    - Explicit llvmpipe passes across all 3 browsers.
//    - Masked WebKit llvmpipe passes ONLY when proven software (slow fill probe or caveat false).
//    - 16K macOS Safari Metal ("Apple GPU", 16384, fast fill probe) FAILS cpu mode!
for (const browserName of ["chromium", "firefox", "webkit"]) {
  assert.equal(
    runPolicy({
      browserName,
      expect: "cpu",
      renderer: "llvmpipe (LLVM, 128 bits)",
      p: { canvas2d: { readbackOk: true }, webgl: { available: true, readbackOk: true } },
    }).problems.length,
    0,
    `${browserName} cpu gate should pass on llvmpipe`,
  );
}
assert.equal(
  runPolicy({
    browserName: "webkit",
    expect: "cpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 260, passes: 32, side: 512 },
      },
    },
  }).problems.length,
  0,
  "WebKit cpu gate should pass on masked Mesa llvmpipe proven slow by perfProbe",
);
assert(
  runPolicy({
    browserName: "webkit",
    expect: "cpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 4.5, passes: 32, side: 512 },
      },
    },
  }).problems.length > 0,
  "WebKit cpu gate must reject fast 16K macOS Safari Metal instead of misclassifying it as software",
);
assert(
  runPolicy({
    browserName: "webkit",
    expect: "cpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        maxTextureSize: 32768,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 3.0, passes: 32, side: 512 },
      },
    },
  }).problems.length > 0,
  "WebKit cpu gate must reject hardware T4 masked as Apple GPU",
);

// 7. Chromium gpu & webgpu modes: gpu requires onscreen WebGL present; webgpu labels render-only.
const hwChromiumFeatures = {
  Canvas: "Hardware accelerated",
  Rasterization: "Hardware accelerated",
  Compositing: "Hardware accelerated",
  WebGL: "Hardware accelerated",
};
const hwChromiumProbes = {
  canvas2d: { readbackOk: true },
  webgl: { available: true, readbackOk: true, presentOk: true },
  webgpu: {
    core: {
      adapter: { vendor: "nvidia", description: "NVIDIA Tesla T4", isFallbackAdapter: false },
      bufferReadbackOk: true,
      presentOk: false,
    },
  },
};
{
  const res = runPolicy({
    browserName: "chromium",
    expect: "gpu",
    renderer: "ANGLE (NVIDIA, Vulkan, Tesla T4)",
    features: hwChromiumFeatures,
    p: hwChromiumProbes,
  });
  assert.equal(res.problems.length, 0);
  assert.equal(res.presentationMode, "onscreen");
  assert.deepEqual(
    res.verifiedBackends,
    ["webgl2"],
    "Chromium gpu with render-only WebGPU must only list webgl2 in verifiedBackends",
  );
}
assert(
  runPolicy({
    browserName: "chromium",
    expect: "gpu",
    renderer: "ANGLE (NVIDIA, Vulkan, Tesla T4)",
    features: hwChromiumFeatures,
    p: { ...hwChromiumProbes, webgl: { available: true, readbackOk: true, presentOk: false } },
  }).problems.length > 0,
  "Chromium gpu gate must fail when onscreen WebGL presentation fails",
);
{
  const renderOnly = runPolicy({
    browserName: "chromium",
    expect: "webgpu",
    renderer: "ANGLE (NVIDIA, Vulkan, Tesla T4)",
    features: hwChromiumFeatures,
    p: hwChromiumProbes,
  });
  assert.equal(renderOnly.problems.length, 0);
  assert.equal(
    renderOnly.presentationMode,
    "render-only",
    "Chromium webgpu without onscreen present must be explicitly labeled render-only",
  );
  assert.deepEqual(renderOnly.verifiedBackends, ["webgpu"]);
  const onscreen = runPolicy({
    browserName: "chromium",
    expect: "webgpu",
    renderer: "ANGLE (NVIDIA, Vulkan, Tesla T4)",
    features: hwChromiumFeatures,
    p: {
      ...hwChromiumProbes,
      webgpu: { core: { ...hwChromiumProbes.webgpu.core, presentOk: true } },
    },
  });
  assert.equal(onscreen.problems.length, 0);
  assert.equal(onscreen.presentationMode, "onscreen");
  assert.deepEqual(onscreen.verifiedBackends, ["webgpu"]);
}

// 8. Standalone gate verifiedBackends binds Firefox/WebKit/CPU to only the backend(s) proven.
{
  const ffWebglOnly = runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "NVIDIA Tesla T4",
    hostGpuOk: false,
    p: {
      canvas2d: { readbackOk: true },
      webgl: { available: true, readbackOk: true, presentOk: true },
      webgpu: {
        core: {
          adapter: { vendor: "", description: "", isFallbackAdapter: false },
          bufferReadbackOk: true,
          presentOk: true,
        },
      },
    },
  });
  assert.equal(ffWebglOnly.problems.length, 0);
  assert.deepEqual(
    ffWebglOnly.verifiedBackends,
    ["webgl2"],
    "Firefox verified only through hardware WebGL2 must NOT claim webgpu in verifiedBackends",
  );

  const ffWebgpuHost = runPolicy({
    browserName: "firefox",
    expect: "gpu",
    renderer: "llvmpipe",
    hostGpuOk: true,
    p: {
      canvas2d: { readbackOk: true },
      webgl: null,
      webgpu: {
        core: {
          adapter: { vendor: "", description: "", isFallbackAdapter: false },
          bufferReadbackOk: true,
          presentOk: true,
        },
      },
    },
  });
  assert.equal(ffWebgpuHost.problems.length, 0);
  assert.deepEqual(ffWebgpuHost.verifiedBackends, ["webgpu"]);

  const wkMetal = runPolicy({
    browserName: "webkit",
    expect: "gpu",
    renderer: "Apple GPU",
    p: {
      canvas2d: { readbackOk: true },
      webgl: {
        available: true,
        readbackOk: true,
        presentOk: true,
        maxTextureSize: 16384,
        failIfMajorPerformanceCaveatOk: true,
        perfProbe: { ms: 6.5 },
      },
    },
  });
  assert.equal(wkMetal.problems.length, 0);
  assert.deepEqual(wkMetal.verifiedBackends, ["webgl2"]);

  const cpu = runPolicy({
    browserName: "chromium",
    expect: "cpu",
    renderer: "SwiftShader",
    p: {
      canvas2d: { readbackOk: true },
      webgl: { available: true, readbackOk: true },
      webgpu: {
        core: {
          adapter: { vendor: "google", description: "SwiftShader", isFallbackAdapter: true },
        },
      },
    },
  });
  assert.equal(cpu.problems.length, 0);
  assert.deepEqual(cpu.verifiedBackends, ["cpu-worker"]);
}

console.log("All GPU/CPU gate policy assertions passed.");
