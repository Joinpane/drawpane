# Headless render parity

Compares the CPU render engine used by the Worker's `export_image` with the canvas renderer in the open editor (decision 0040).

`apps/web/e2e/parity/headless.spec.ts` builds every cell of these scenes and of the Figma parity scenes (`tools/figma-parity/scenes`, minus the glass probes), exports each at 2× both ways and compares pixels: mean difference over RGB (0–255). Each cell must stay within `thresholds.json`.

- `scenes/` are the scenes only this suite draws, in the Figma suites' format: radii and open ends (`shapes`), auto layout cards and type in Inter and Instrument Sans (`cards`), styled runs (`rich-text`) and image fills (`images`; `"$IMAGE"` is a picture the spec draws and uploads).
- `thresholds.json` is each cell's score with a little headroom (×1.1 + 0.3). Record it again after a change that moves a score:

  ```sh
  pnpm --filter @drawpane/web build
  UPDATE_THRESHOLDS=1 pnpm --filter @drawpane/web exec playwright test e2e/parity/headless.spec.ts
  ```

- The report (canvas, headless and a heat map of the difference, per cell) is written to `apps/web/test-results/parity/headless.html`.

The `corners/layer-blur` cell compares directly with the frozen Figma capture. The grain suite compares blurred pixels to measure tone and density across renderers.
