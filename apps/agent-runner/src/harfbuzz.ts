/**
 * The real text measurer for the headless engine (decision 0021): the
 * editor's `HarfBuzzMeasurer`, reading the same font files the browser
 * draws with (`font-files.ts`), held to the canvas measurer by the text
 * parity suite.
 *
 * HarfBuzz is WebAssembly. Its package loads the module from beside its
 * script, which a Worker can't do, so the module is bundled here, capped
 * (`scripts/cap-wasm.ts`), and handed to it (`patches/harfbuzzjs@1.6.4.patch`
 * lets the package take it).
 */
import type { FaceFileLoader } from "@drawpane/editor";
import hbWasm from "../wasm/harfbuzz.wasm";
// HarfBuzz's module with its memory capped, written by scripts/cap-wasm.ts.
import hbDrawWasm from "../wasm/harfbuzz-draw.wasm";
import type { Env } from "./env";
import { type HeadlessFontResolver, headlessFontResolver } from "./font-aliases";
import { headlessFontLoader } from "./font-files";
import { type HarfBuzzWasmOptions, harfBuzzWasmOptions } from "./harfbuzz-draw";
import { harfBuzzMeasurerWith } from "./harfbuzz-measurer";
import { type HeadlessMeasurer, STANDIN } from "./measurer";

type HarfBuzz = typeof import("harfbuzzjs");

let harfBuzz: Promise<HarfBuzz> | null = null;

/** HarfBuzz, instantiated from the bundled module once per isolate. */
function loadHarfBuzz(): Promise<HarfBuzz> {
  if (!harfBuzz) {
    (globalThis as { __drawpaneHarfBuzz?: HarfBuzzWasmOptions }).__drawpaneHarfBuzz =
      harfBuzzWasmOptions(hbWasm, hbDrawWasm);
    harfBuzz = import("harfbuzzjs").catch((error: unknown) => {
      harfBuzz = null;
      throw error;
    });
  }
  return harfBuzz;
}

/** The engine's measurer over HarfBuzz, with font files from `loadFile` and aliases from `fonts`. */
export const harfBuzzMeasurer = (
  loadFile: FaceFileLoader,
  fonts: HeadlessFontResolver | null = null,
): HeadlessMeasurer => harfBuzzMeasurerWith(loadFile, loadHarfBuzz, fonts);

/** A file's team, looked up the first time it's wanted. */
function fileTeam(env: Env, fileId: string): () => Promise<string | null> {
  let team: Promise<string | null> | null = null;
  return () => {
    team ??= env.DB.prepare("SELECT team_id FROM files WHERE id = ?")
      .bind(fileId)
      .first<{ team_id: string }>()
      .then((row) => row?.team_id ?? null);
    return team;
  };
}

/**
 * A file's font files: its team's fonts, then Google's and the app's own.
 * The team is looked up once, the first time a font is wanted.
 */
export function fileFontLoader(env: Env, fileId: string): FaceFileLoader {
  const teamId = fileTeam(env, fileId);
  let loader: Promise<ReturnType<typeof headlessFontLoader>> | null = null;
  const loaderFor = () => {
    loader ??= teamId().then((team) => headlessFontLoader({ env, teamId: team }));
    return loader;
  };
  return async (face) => (await loaderFor())(face);
}

/** A file's font aliases: its team's, and the built-in ones (decision 0036). */
export function fileFontResolver(env: Env, fileId: string): HeadlessFontResolver {
  return headlessFontResolver({ env, teamId: fileTeam(env, fileId) });
}

/** A file's measurer, over its font files, resolving its team's font aliases. */
export function headlessMeasurer(env: Env, fileId: string): HeadlessMeasurer {
  return harfBuzzMeasurer(fileFontLoader(env, fileId), fileFontResolver(env, fileId));
}

/** The measurer for a file: the stand-in when `AGENT_MEASURER=standin`, else HarfBuzz. */
export function agentMeasurer(env: Env, fileId: string): HeadlessMeasurer {
  return env.AGENT_MEASURER === "standin" ? STANDIN : headlessMeasurer(env, fileId);
}
