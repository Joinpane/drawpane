/**
 * Live render engine status per editor, for the bottom-bar status chip.
 * Updated by `Canvas.tsx` when the engine switch is on, only notifying listeners
 * when the active renderer or fallback reason actually changes.
 */
import { type Editor, Store } from "@drawpane/editor";
import { useSyncExternalStore } from "react";
import type { EngineBackend, FallbackEvent } from "./engine-view";
import type { RendererChoice } from "./renderer-switch";

export type EngineChoice = Exclude<RendererChoice, "canvas">;

export type RendererFallbackReason =
  | { readonly kind: "starting" }
  | { readonly kind: "recovering" }
  | { readonly kind: "unsupported"; readonly features: readonly string[] }
  | { readonly kind: "limit"; readonly message: string }
  | { readonly kind: "no-webgpu" }
  | { readonly kind: "software-gpu" }
  | { readonly kind: "error"; readonly message: string };

export type RendererStatus =
  | { readonly switchOn: false }
  | {
      readonly switchOn: true;
      readonly choice: EngineChoice;
      readonly active: "engine";
      readonly backend: string;
      readonly adapter: string | null;
      readonly compatibility: boolean;
      readonly software: boolean;
      readonly limit?: string | null;
      readonly computeFallback?: string | null;
      readonly reducedImages?: number;
    }
  | {
      readonly switchOn: true;
      readonly choice: EngineChoice;
      readonly active: "canvas";
      readonly reason: RendererFallbackReason;
    };

export type ActiveRendererStatus = Extract<RendererStatus, { switchOn: true }>;

const FEATURE_LABELS: Record<string, string> = {
  shadow: "shadow",
  layerBlur: "layer blur",
  backgroundBlur: "background blur",
  glass: "glass",
  noise: "noise",
  texture: "texture",
  mask: "mask",
  blend: "blend",
  textWithoutOutlines: "unoutlined text",
  cornerSmoothing: "corner smoothing",
  progressiveBlur: "progressive blur",
  textStrokeOutside: "outside text stroke",
  diamondGradient: "diamond gradient",
  backdropReader: "backdrop effect",
};

const stores = new WeakMap<Editor, Store<{ readonly value: RendererStatus }>>();

export function rendererStatusFor(editor: Editor): Store<{ readonly value: RendererStatus }> {
  let store = stores.get(editor);
  if (!store) {
    store = new Store<{ readonly value: RendererStatus }>({ value: { switchOn: false } });
    stores.set(editor, store);
  }
  return store;
}

function sameFeatures(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameRendererStatus(a: RendererStatus, b: RendererStatus): boolean {
  if (!a.switchOn && !b.switchOn) return true;
  if (!a.switchOn || !b.switchOn) return false;
  if (a.choice !== b.choice || a.active !== b.active) return false;
  if (a.active === "engine" && b.active === "engine") {
    return (
      a.backend === b.backend &&
      a.adapter === b.adapter &&
      a.compatibility === b.compatibility &&
      a.software === b.software &&
      a.limit === b.limit &&
      a.computeFallback === b.computeFallback &&
      a.reducedImages === b.reducedImages
    );
  }
  if (a.active === "canvas" && b.active === "canvas") {
    if (a.reason.kind !== b.reason.kind) return false;
    if (a.reason.kind === "unsupported" && b.reason.kind === "unsupported") {
      return sameFeatures(a.reason.features, b.reason.features);
    }
    if (a.reason.kind === "error" && b.reason.kind === "error") {
      return a.reason.message === b.reason.message;
    }
    if (a.reason.kind === "limit" && b.reason.kind === "limit") {
      return a.reason.message === b.reason.message;
    }
    return true;
  }
  return false;
}

export function setRendererStatus(editor: Editor, next: RendererStatus): void {
  const store = rendererStatusFor(editor);
  if (sameRendererStatus(store.get().value, next)) return;
  store.set({ value: next });
}

export function useRendererStatus(editor: Editor): RendererStatus {
  const store = rendererStatusFor(editor);
  return useSyncExternalStore(store.subscribe, () => store.get().value);
}

export function engineBackendLabel(backend: EngineBackend): string {
  if (backend === "webgpu") return "WebGPU";
  if (backend === "webgl2") return "WebGL2";
  return "CPU view";
}

export function fallbackToReason(event: FallbackEvent): RendererFallbackReason {
  if (event.kind === "no-webgpu") return { kind: "no-webgpu" };
  if (event.kind === "software-gpu") return { kind: "software-gpu" };
  return { kind: "error", message: event.reason };
}

export function rendererChipLabel(status: ActiveRendererStatus): string {
  if (status.active !== "engine") return "Canvas renderer";
  const note = status.limit ? " · Reduced detail" : status.reducedImages ? " · Images reduced" : "";
  const compute = status.computeFallback ? " · Compute off" : "";
  return `Engine · ${status.backend}${compute}${note}`;
}

export function formatRendererReason(status: ActiveRendererStatus): string {
  if (status.active === "engine") {
    const adapter = status.adapter
      ?.replace(
        /\s*\((?:Other|IntegratedGpu|DiscreteGpu|VirtualGpu|Cpu), (?:BrowserWebGpu|Gl)\).*$/,
        "",
      )
      .trim();
    const renderer = adapter ? `${status.backend} (${adapter})` : status.backend;
    const reduced = status.reducedImages ?? 0;
    const note = reduced
      ? `. ${reduced} ${reduced === 1 ? "image" : "images"} at reduced detail`
      : "";
    const limit = status.limit ? ` at reduced detail. ${status.limit}` : "";
    const compute = status.computeFallback
      ? `. Compute is off for this session, so Vello GPU draws instead: ${status.computeFallback}`
      : "";
    return `Drawing with ${renderer}${limit}${note}${compute}`;
  }
  switch (status.reason.kind) {
    case "starting":
      return "starting the render engine";
    case "recovering":
      return "recovering GPU surface";
    case "unsupported": {
      if (status.reason.features.length === 0) return "this page uses an unsupported feature";
      const names = status.reason.features.map((f) => FEATURE_LABELS[f] ?? f);
      return `this page uses ${names.join(", ")}`;
    }
    case "no-webgpu":
      return "no WebGPU in this browser";
    case "software-gpu":
      return "only a software GPU";
    case "limit":
      return `This page exceeded an engine limit. ${status.reason.message}`;
    case "error":
      return `engine error: ${status.reason.message}`;
  }
}
