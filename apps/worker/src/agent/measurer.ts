/**
 * The text measurer the Worker's headless editor uses (decision 0021). Text
 * fixes itself up after every edit (it sizes to its content, and auto layout
 * follows), so an agent's edit needs text measured as the browser measures
 * it. That is the HarfBuzz measurer (`harfbuzz.ts`), reading the same font
 * files the browser uses, registered with `provideMeasurer` when the Worker
 * starts.
 *
 * `AGENT_MEASURER=standin` asks for a stand-in instead: fixed advances per
 * character, deterministic, for tests and local development only. Its text
 * sizes are close, never exact.
 */
import type { FontMetrics, TextFace, TextMeasurer } from "@drawpane/editor";
import type { Env } from "../env";

/** A measurer that fetches fonts first: everything async happens in `load`, never while measuring. */
export interface HeadlessMeasurer extends TextMeasurer {
  /** Whether text in `face` measures as it will in the browser now (its font is loaded, or can't be). */
  has(face: TextFace): boolean;
  /** Loads the fonts for `faces`. A face it can't find measures with a fallback from then on. */
  load(faces: readonly TextFace[]): Promise<void>;
}

/** Makes the measurer for one file's room (team fonts are per team). */
export type MeasurerFactory = (env: Env, fileId: string) => HeadlessMeasurer;

let provided: MeasurerFactory | null = null;

/** Configures the real measurer, at the Worker's start. */
export function provideMeasurer(factory: MeasurerFactory | null): void {
  provided = factory;
}

/** The measurer for a file's room, or null when none is configured (the agent tools are then off). */
export function agentMeasurer(env: Env, fileId: string): HeadlessMeasurer | null {
  // Asked for by name (tests, local development): the stand-in, even with the real one configured.
  if (env.AGENT_MEASURER === "standin") return STANDIN;
  return provided ? provided(env, fileId) : null;
}

/** Whether agents can design here: a measurer is configured. */
export function agentToolsEnabled(env: Env): boolean {
  return provided !== null || env.AGENT_MEASURER === "standin";
}

/** The px size in a canvas font string ("italic 700 16px Inter"). */
const fontSize = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);

/** Half an em per character, 0.9 em above the baseline and 0.25 below: plain and predictable. */
export const STANDIN: HeadlessMeasurer = {
  width: (font, text) => text.length * fontSize(font) * 0.5,
  metrics: (font): FontMetrics => ({
    ascent: fontSize(font) * 0.9,
    descent: fontSize(font) * 0.25,
  }),
  has: () => true,
  load: async () => {},
};
