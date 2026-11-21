/**
 * The text measurer the runner's headless editor uses (decision 0021). Text
 * fixes itself up after every edit (it sizes to its content, and auto layout
 * follows), so an agent's edit needs text measured as the browser measures
 * it. That is the HarfBuzz measurer (`harfbuzz.ts`), reading the same font
 * files the browser uses.
 *
 * `AGENT_MEASURER=standin` asks for a stand-in instead (`STANDIN`): fixed
 * advances per character, deterministic, for tests and local development
 * only. Its text sizes are close, never exact.
 */
import type { FontMetrics, TextFace, TextMeasurer } from "@drawpane/editor";
import type { NodeRecord } from "@drawpane/model";

/** A measurer that fetches fonts first: everything async happens in `load`, never while measuring. */
export interface HeadlessMeasurer extends TextMeasurer {
  /** Temporarily selects the Han locale explicitly requested for an export. */
  setScriptLocale?(locale: string): void;
  /** Whether text in `face` measures as it will in the browser now (its font is loaded, or can't be). */
  has(face: TextFace): boolean;
  /** Loads the fonts for `faces`. A face it can't find measures with a fallback from then on. */
  load(faces: readonly TextFace[]): Promise<void>;
  /** Loads the extra faces needed by OpenType features and variable axes in an export. */
  prepareRenderFonts?(nodes: Iterable<NodeRecord>): Promise<void>;
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
