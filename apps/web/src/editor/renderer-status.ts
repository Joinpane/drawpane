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
      a.software === b.software
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
  return status.active === "engine" ? `Engine · ${status.backend}` : "Canvas renderer";
}

export function formatRendererReason(status: ActiveRendererStatus): string {
  if (status.active === "engine") {
    return status.adapter
      ? `Drawing with ${status.backend} (${status.adapter})`
      : `Drawing with ${status.backend}`;
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
    case "error":
      return `engine error: ${status.reason.message}`;
  }
}
