/**
 * The browser's text measurers and the headless one side by side, for the
 * text parity test (e2e/parity/text.spec.ts, decision 0021). Loaded only
 * from the debug handle, so the HarfBuzz measurer stays out of the app.
 */
export {
  CanvasTextMeasurer,
  fontString,
  HarfBuzzMeasurer,
  layoutText,
  Shaper,
  ShapingMeasurer,
  shapingRun,
} from "@drawpane/editor";
