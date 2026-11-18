/**
 * The real text measurer for the headless engine (decision 0021): the
 * editor's `HarfBuzzMeasurer`, reading the same font files the browser
 * draws with (`headless/font-files.ts`), held to the canvas measurer by the
 * text parity suite. Registered with `provideMeasurer` when the Worker
 * starts, which turns the agent tools on.
 *
 * HarfBuzz is WebAssembly. Its package loads the module from beside its
 * script, which a Worker can't do, so the module is bundled here and handed
 * to it (`patches/harfbuzzjs@1.6.4.patch` lets the package take it).
 */
import type { FaceFileLoader } from "@drawpane/editor";
// HarfBuzz's module with its memory capped, written by scripts/cap-wasm.ts.
import hbWasm from "../../wasm/harfbuzz.wasm";
import type { Env } from "../env";
import { headlessFontLoader } from "../headless/font-files";
import { harfBuzzMeasurerWith } from "./harfbuzz-measurer";
import { type HeadlessMeasurer, type MeasurerFactory, provideMeasurer } from "./measurer";

type HarfBuzz = typeof import("harfbuzzjs");

/** Emscripten's hook for instantiating its module itself, from the bundled one. */
interface EmscriptenOptions {
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): Record<string, never>;
}

let harfBuzz: Promise<HarfBuzz> | null = null;

/** HarfBuzz, instantiated from the bundled module once per isolate. */
function loadHarfBuzz(): Promise<HarfBuzz> {
  if (!harfBuzz) {
    const options: EmscriptenOptions = {
      instantiateWasm(imports, done) {
        void WebAssembly.instantiate(hbWasm, imports).then((instance) => done(instance, hbWasm));
        return {};
      },
    };
    (globalThis as { __drawpaneHarfBuzz?: EmscriptenOptions }).__drawpaneHarfBuzz = options;
    harfBuzz = import("harfbuzzjs").catch((error: unknown) => {
      harfBuzz = null;
      throw error;
    });
  }
  return harfBuzz;
}

/** The engine's measurer over HarfBuzz, with font files from `loadFile`. */
export const harfBuzzMeasurer = (loadFile: FaceFileLoader): HeadlessMeasurer =>
  harfBuzzMeasurerWith(loadFile, loadHarfBuzz);

/**
 * A file's font files: its team's fonts, then Google's and the app's own.
 * The team is looked up once, the first time a font is wanted.
 */
export function fileFontLoader(env: Env, fileId: string): FaceFileLoader {
  let loader: Promise<ReturnType<typeof headlessFontLoader>> | null = null;
  const loaderFor = () => {
    loader ??= env.DB.prepare("SELECT team_id FROM files WHERE id = ?")
      .bind(fileId)
      .first<{ team_id: string }>()
      .then((row) => headlessFontLoader({ env, teamId: row?.team_id ?? null }));
    return loader;
  };
  return async (face) => (await loaderFor())(face);
}

/** A file's measurer, over its font files. */
export function headlessMeasurer(env: Env, fileId: string): HeadlessMeasurer {
  return harfBuzzMeasurer(fileFontLoader(env, fileId));
}

export const harfBuzzMeasurers: MeasurerFactory = headlessMeasurer;

/** Turns the agent tools on, with the real measurer. Called when the Worker starts. */
export function provideHarfBuzzMeasurer(): void {
  provideMeasurer(harfBuzzMeasurers);
}
