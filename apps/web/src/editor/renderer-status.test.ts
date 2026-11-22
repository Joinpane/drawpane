import { describe, expect, it } from "vitest";
import {
  type ActiveRendererStatus,
  formatRendererReason,
  rendererChipLabel,
} from "./renderer-status";

const webGpu: ActiveRendererStatus = {
  switchOn: true,
  choice: "engine",
  active: "engine",
  backend: "WebGPU",
  adapter: " (Other, BrowserWebGpu)",
  compatibility: false,
  software: false,
};

describe("renderer status text", () => {
  it("omits the adapter when the browser hides its name", () => {
    expect(formatRendererReason(webGpu)).toBe("Drawing with WebGPU");
  });

  it("shows the adapter name without wgpu metadata", () => {
    expect(formatRendererReason({ ...webGpu, adapter: "Apple M4 (Other, BrowserWebGpu)" })).toBe(
      "Drawing with WebGPU (Apple M4)",
    );
  });

  it("marks a limited engine frame as reduced detail", () => {
    const reduced = { ...webGpu, limit: "The lens exceeds the raster budget." };
    expect(rendererChipLabel(reduced)).toBe("Engine · WebGPU · Reduced detail");
    expect(formatRendererReason(reduced)).toBe(
      "Drawing with WebGPU at reduced detail. The lens exceeds the raster budget.",
    );
  });

  it("says when compute is off for the session", () => {
    const off = { ...webGpu, computeFallback: "compute buffers still overflowed after growing" };
    expect(rendererChipLabel(off)).toBe("Engine · WebGPU · Compute off");
    expect(formatRendererReason(off)).toBe(
      "Drawing with WebGPU. Compute is off for this session, so Vello GPU draws instead: compute buffers still overflowed after growing",
    );
  });
});
